-- ============================================================
-- JAM 2026 — Schemas: scoring + evento + personal
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ── SCHEMAS ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS scoring;
CREATE SCHEMA IF NOT EXISTS evento;
CREATE SCHEMA IF NOT EXISTS personal;

-- ── PERSONAL: Usuarios del sistema (jurados, director, staff) ─
CREATE TABLE IF NOT EXISTS personal.usuarios (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,          -- bcrypt hash
  rol         TEXT NOT NULL CHECK (rol IN ('director','jurado','staff','lineup','acreditacion','dj','presentador','proyeccion')),
  juez_num    INTEGER,                -- solo para rol=jurado (1-10)
  items       TEXT[],                 -- ítems asignados al jurado
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Usuario director por defecto (contraseña: director2026)
INSERT INTO personal.usuarios (username, password, rol)
VALUES ('director', crypt('director2026', gen_salt('bf')), 'director')
ON CONFLICT (username) DO NOTHING;

-- Jurados 1-10 (contraseña inicial: 1234)
DO $$
DECLARE
  items_nac TEXT[][] := ARRAY[
    ARRAY['Técnica','Proyección'],
    ARRAY['Coreografía','Vestuario'],
    ARRAY['Actuación','Interpretación Musical'],
    ARRAY['Conexión','Factor Sorpresa'],
    ARRAY['Tiempo','Edición Musical'],
    ARRAY['Técnica','Proyección'],
    ARRAY['Coreografía','Vestuario'],
    ARRAY['Actuación','Interpretación Musical'],
    ARRAY['Conexión','Factor Sorpresa'],
    ARRAY['Tiempo','Edición Musical']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1..10 LOOP
    INSERT INTO personal.usuarios (username, password, rol, juez_num, items)
    VALUES (
      'jurado' || i,
      crypt('1234', gen_salt('bf')),
      'jurado',
      i,
      items_nac[i]
    ) ON CONFLICT (username) DO NOTHING;
  END LOOP;
END $$;

-- ── SCORING: Sesiones y puntajes ─────────────────────────────

CREATE TABLE IF NOT EXISTS scoring.sesiones (
  id           SERIAL PRIMARY KEY,
  inscripcion_id UUID,                -- ref a public.inscripciones cuando exista
  codigo_id    TEXT NOT NULL,         -- JAM-NAC-0200 etc.
  nombre_grupo TEXT NOT NULL,
  categoria    TEXT,
  instancia    TEXT NOT NULL CHECK (instancia IN ('nac','rep','inter')),
  pais         TEXT DEFAULT 'Argentina',
  activa       BOOLEAN DEFAULT TRUE,
  orden_lineup INTEGER,
  iniciada_at  TIMESTAMPTZ DEFAULT NOW(),
  finalizada_at TIMESTAMPTZ,
  total_final  NUMERIC(6,2)           -- calculado al cerrar todos los jueces
);
CREATE INDEX IF NOT EXISTS idx_scoring_sesiones_activa ON scoring.sesiones(activa);

CREATE TABLE IF NOT EXISTS scoring.puntajes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sesion_id   INTEGER REFERENCES scoring.sesiones(id) ON DELETE CASCADE,
  juez_num    INTEGER NOT NULL CHECK (juez_num BETWEEN 1 AND 10),
  items       JSONB NOT NULL DEFAULT '{}', -- {"item1": 8.5, "item2": 9.0, ...}
  subtotal    NUMERIC(5,2) NOT NULL DEFAULT 0,
  cerrado     BOOLEAN DEFAULT FALSE,
  cerrado_at  TIMESTAMPTZ,
  forzado     BOOLEAN DEFAULT FALSE,  -- forzado por director
  audio_url   TEXT,
  UNIQUE(sesion_id, juez_num)
);
CREATE INDEX IF NOT EXISTS idx_scoring_puntajes_sesion ON scoring.puntajes(sesion_id);

CREATE TABLE IF NOT EXISTS scoring.descalificaciones (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sesion_id   INTEGER REFERENCES scoring.sesiones(id) ON DELETE CASCADE,
  juez_num    INTEGER NOT NULL,
  motivo      TEXT,
  votado_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sesion_id, juez_num)
);

-- Vista: total por sesión (suma de subtotales cerrados / jueces cerrados)
CREATE OR REPLACE VIEW scoring.v_totales AS
SELECT
  s.id AS sesion_id,
  s.codigo_id,
  s.nombre_grupo,
  s.instancia,
  s.activa,
  COUNT(p.id) FILTER (WHERE p.cerrado) AS jueces_cerrados,
  COUNT(p.id) AS jueces_total,
  ROUND(SUM(p.subtotal) FILTER (WHERE p.cerrado), 2) AS subtotal_parcial,
  ROUND(AVG(p.subtotal) FILTER (WHERE p.cerrado) * 
    CASE s.instancia 
      WHEN 'inter' THEN (5.0/2.0)   -- Inter: 5 ítems de 20 → promedio ponderado
      ELSE 1.0 
    END, 2) AS puntaje_normalizado
FROM scoring.sesiones s
LEFT JOIN scoring.puntajes p ON p.sesion_id = s.id
GROUP BY s.id, s.codigo_id, s.nombre_grupo, s.instancia, s.activa;

-- ── EVENTO: Lineup, acreditación, música ─────────────────────

CREATE TABLE IF NOT EXISTS evento.config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
-- PIN del evento (cambiar antes del día)
INSERT INTO evento.config VALUES ('pin_evento', '1234') ON CONFLICT (clave) DO NOTHING;
INSERT INTO evento.config VALUES ('nombre_evento', 'JAM 2026') ON CONFLICT (clave) DO NOTHING;
INSERT INTO evento.config VALUES ('fecha_evento', 'Octubre 2026') ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS evento.lineup (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  inscripcion_id UUID,                -- ref a public.inscripciones
  codigo_id      TEXT NOT NULL,       -- JAM-NAC-0200 etc. (denormalizado para velocidad)
  nombre_grupo   TEXT NOT NULL,
  responsable    TEXT,
  pais           TEXT DEFAULT 'Argentina',
  categoria      TEXT,
  instancia      TEXT,
  estado_pago    TEXT DEFAULT 'sin_pago',
  posicion       INTEGER NOT NULL,
  estado         TEXT DEFAULT 'pendiente' CHECK (estado IN ('pendiente','presente','pista','listo','ausente')),
  acreditado_at  TIMESTAMPTZ,
  pista_desde    TIMESTAMPTZ,
  listo_at       TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evento_lineup_estado ON evento.lineup(estado);
CREATE INDEX IF NOT EXISTS idx_evento_lineup_pos ON evento.lineup(posicion);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION evento.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lineup_updated ON evento.lineup;
CREATE TRIGGER trg_lineup_updated
  BEFORE UPDATE ON evento.lineup
  FOR EACH ROW EXECUTE FUNCTION evento.set_updated_at();

CREATE TABLE IF NOT EXISTS evento.musica (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  inscripcion_id UUID,
  codigo_id      TEXT NOT NULL,
  nombre_grupo   TEXT NOT NULL,
  filename       TEXT NOT NULL,
  storage_url    TEXT NOT NULL,       -- URL en R2
  duracion_seg   INTEGER,
  duracion_fmt   TEXT,                -- "2:28" formateado
  verificado     BOOLEAN DEFAULT FALSE,
  activo_dj      BOOLEAN DEFAULT FALSE,
  subido_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS (Row Level Security) ──────────────────────────────────
ALTER TABLE personal.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.puntajes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.descalificaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento.lineup ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento.musica ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento.config ENABLE ROW LEVEL SECURITY;

-- Config: solo lectura pública (el PIN se verifica en backend)
CREATE POLICY "config_read" ON evento.config FOR SELECT USING (true);

-- Lineup: lectura y escritura pública (controlada por PIN en frontend)
CREATE POLICY "lineup_read" ON evento.lineup FOR SELECT USING (true);
CREATE POLICY "lineup_write" ON evento.lineup FOR ALL USING (true);

-- Música: solo lectura pública
CREATE POLICY "musica_read" ON evento.musica FOR SELECT USING (true);

-- Sesiones: lectura pública (para proyección), escritura para service_role
CREATE POLICY "sesiones_read" ON scoring.sesiones FOR SELECT USING (true);
CREATE POLICY "sesiones_write" ON scoring.sesiones FOR ALL USING (true);

-- Puntajes: lectura pública (para director), escritura para service_role
CREATE POLICY "puntajes_read" ON scoring.puntajes FOR SELECT USING (true);
CREATE POLICY "puntajes_write" ON scoring.puntajes FOR ALL USING (true);

-- Descalificaciones: acceso completo
CREATE POLICY "desc_all" ON scoring.descalificaciones FOR ALL USING (true);

-- Usuarios: solo service_role puede leer passwords
CREATE POLICY "usuarios_auth" ON personal.usuarios FOR SELECT USING (true);

-- ── REALTIME (habilitar para las tablas que necesitan live updates) ──
-- Ejecutar en el Dashboard de Supabase > Database > Replication
-- O via SQL:
ALTER PUBLICATION supabase_realtime ADD TABLE scoring.puntajes;
ALTER PUBLICATION supabase_realtime ADD TABLE scoring.sesiones;
ALTER PUBLICATION supabase_realtime ADD TABLE evento.lineup;

-- ── FUNCIÓN DE LOGIN segura ───────────────────────────────────
CREATE OR REPLACE FUNCTION personal.verificar_login(p_user TEXT, p_pass TEXT)
RETURNS TABLE(id UUID, username TEXT, rol TEXT, juez_num INTEGER, items TEXT[])
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.username, u.rol, u.juez_num, u.items
  FROM personal.usuarios u
  WHERE u.username = p_user
    AND u.password = crypt(p_pass, u.password)
    AND u.activo = TRUE;
END;
$$;

-- ── NOTAS ────────────────────────────────────────────────────
-- Para habilitar pgcrypto (necesario para bcrypt):
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Ejecutar esta línea PRIMERO antes de correr el resto del script.
