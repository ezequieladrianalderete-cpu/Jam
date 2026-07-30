-- ═══════════════════════════════════════════════════════════════════════
-- FIX: generación atómica de codigo_id para evento.lineup
-- ═══════════════════════════════════════════════════════════════════════
-- codigo_id (JAM-NAC-0200, JAM-INTER-1007, etc.) se generaba de tres formas
-- distintas, ninguna seguras contra inserciones concurrentes y ninguna
-- basada en el máximo real ya usado en la base:
--   - evento.html "Nuevo participante": nextNum = luData.length + 1
--     (cuenta TODOS los participantes, sin importar instancia)
--   - evento.html import CSV: la misma cuenta, incrementada en memoria
--     mientras arma el archivo
--   - competencia.html saResyncLineup(): offset fijo por instancia
--     (nac:200, int:1000, reg:1, rep:10) + un contador que arranca de nuevo
--     en cada corrida, ignorando lo que ya existe en la tabla
--
-- Cualquiera de los tres (o dos corridas concurrentes del mismo) puede
-- calcular el mismo número. Así se llegó a tener dos participantes reales
-- distintos con codigo_id = 'JAM-INTER-1007' — y como el resto de la app
-- (estado de categorías, sesiones de scoring, orden del lineup) usa
-- codigo_id como si fuera una clave única para unir evento.lineup con
-- scoring.sesiones, ese duplicado hizo que el estado de evaluación de uno
-- se filtrara al otro.
--
-- Esta migración:
--   1. Crea una secuencia de Postgres por prefijo (nac/rep/inter/reg), arrancada
--      después del máximo código ya emitido. A diferencia de un MAX()+1
--      recalculado en cada alta, una secuencia nunca repite ni reutiliza un
--      valor, ni siquiera si se borra la fila con el número más alto.
--   2. Expone lineup_insertar_auto(...): genera el código Y hace el insert
--      en la MISMA transacción — la única forma de garantizar que dos altas
--      simultáneas (desde cualquier pantalla) nunca terminen con el mismo
--      código.
--   3. Agrega una restricción UNIQUE sobre evento.lineup.codigo_id como red
--      de seguridad, para que cualquier otro camino de inserción (CSV con
--      IDs explícitos ya duplicados, algún script futuro, etc.) falle con
--      un error claro en vez de crear un duplicado silencioso.
--
-- ⚠️ ORDEN DE EJECUCIÓN — LEER ANTES DE CORRER:
-- Ahora mismo hay al menos un duplicado real en producción (JAM-INTER-1007,
-- dos filas). El paso 3 (UNIQUE) va a fallar si corre mientras existan
-- duplicados. Corré primero la consulta de abajo para encontrarlos y
-- reasigná a mano el codigo_id de una de las filas repetidas (por ejemplo,
-- al siguiente número libre de ese prefijo) ANTES de ejecutar el bloque 3.
-- Los bloques 1 y 2 se pueden correr ya mismo sin ese paso previo.

-- Encontrar duplicados existentes (correr esto primero):
SELECT codigo_id, COUNT(*), array_agg(id) AS filas
FROM evento.lineup
GROUP BY codigo_id
HAVING COUNT(*) > 1;

-- ───────────────────────────────────────────────────────────────────────
-- 1. Secuencias, arrancadas después del máximo código ya usado por prefijo
-- ───────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS evento.seq_codigo_nac;
CREATE SEQUENCE IF NOT EXISTS evento.seq_codigo_rep;
CREATE SEQUENCE IF NOT EXISTS evento.seq_codigo_inter;
CREATE SEQUENCE IF NOT EXISTS evento.seq_codigo_reg;
CREATE SEQUENCE IF NOT EXISTS evento.seq_lineup_posicion;

SELECT setval('evento.seq_codigo_nac',
  GREATEST(1, COALESCE((SELECT MAX(substring(codigo_id FROM '[0-9]+$')::int)
    FROM evento.lineup WHERE codigo_id LIKE 'JAM-NAC-%'), 0)));
SELECT setval('evento.seq_codigo_rep',
  GREATEST(1, COALESCE((SELECT MAX(substring(codigo_id FROM '[0-9]+$')::int)
    FROM evento.lineup WHERE codigo_id LIKE 'JAM-REP-%'), 0)));
SELECT setval('evento.seq_codigo_inter',
  GREATEST(1, COALESCE((SELECT MAX(substring(codigo_id FROM '[0-9]+$')::int)
    FROM evento.lineup WHERE codigo_id LIKE 'JAM-INTER-%'), 0)));
SELECT setval('evento.seq_codigo_reg',
  GREATEST(1, COALESCE((SELECT MAX(substring(codigo_id FROM '[0-9]+$')::int)
    FROM evento.lineup WHERE codigo_id LIKE 'JAM-REG-%'), 0)));
SELECT setval('evento.seq_lineup_posicion',
  GREATEST(1, COALESCE((SELECT MAX(posicion) FROM evento.lineup), 0)));

-- ───────────────────────────────────────────────────────────────────────
-- 2. Función atómica: genera el código Y inserta la fila en un solo paso.
--    p_inscripcion_id es opcional (NULL para altas manuales sin inscripción
--    previa, como el formulario "Nuevo participante").
--    SECURITY DEFINER + search_path fijo: corre con los permisos de quien
--    la creó, para no depender de otorgarle USAGE sobre las secuencias
--    nuevas a los roles anon/authenticated por separado (la policy RLS de
--    evento.lineup ya es USING (true), así que esto no cambia qué se puede
--    insertar — solo evita un paso extra de configuración).
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lineup_insertar_auto(
  p_nombre_grupo   text,
  p_responsable    text,
  p_pais           text,
  p_instancia      text,
  p_categoria      text,
  p_estado_pago    text,
  p_inscripcion_id uuid DEFAULT NULL
)
RETURNS evento.lineup
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, evento
AS $$
DECLARE
  v_prefijo text;
  v_seq     regclass;
  v_next    int;
  v_codigo  text;
  v_row     evento.lineup;
BEGIN
  IF p_instancia = 'inter' OR p_instancia = 'int' THEN
    v_prefijo := 'INTER'; v_seq := 'evento.seq_codigo_inter'::regclass;
  ELSIF p_instancia = 'rep' THEN
    v_prefijo := 'REP'; v_seq := 'evento.seq_codigo_rep'::regclass;
  ELSIF p_instancia = 'reg' THEN
    v_prefijo := 'REG'; v_seq := 'evento.seq_codigo_reg'::regclass;
  ELSE
    v_prefijo := 'NAC'; v_seq := 'evento.seq_codigo_nac'::regclass;
  END IF;

  v_next   := nextval(v_seq);
  v_codigo := 'JAM-' || v_prefijo || '-' || lpad(v_next::text, 4, '0');

  INSERT INTO evento.lineup (
    inscripcion_id, codigo_id, nombre_grupo, responsable, pais, instancia,
    categoria, estado_pago, posicion, estado
  ) VALUES (
    p_inscripcion_id, v_codigo, p_nombre_grupo, p_responsable, p_pais,
    p_instancia, p_categoria, p_estado_pago,
    nextval('evento.seq_lineup_posicion'), 'pendiente'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lineup_insertar_auto TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────
-- 3. Red de seguridad — correr SOLO después de limpiar los duplicados de
--    arriba, si no esta línea va a fallar con "could not create unique
--    index... duplicate key".
-- ───────────────────────────────────────────────────────────────────────
ALTER TABLE evento.lineup ADD CONSTRAINT lineup_codigo_id_unique UNIQUE (codigo_id);
