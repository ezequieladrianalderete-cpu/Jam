// /api/health.js — JAM 2026 System Health Check
// GET /api/health → estado completo del sistema

async function supaFetch(path, profile) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (profile) headers["Accept-Profile"] = profile;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const checks = {};
  let errors = 0;

  // 1. Conexión Supabase
  try {
    await supaFetch("inscripciones?select=id&limit=1");
    checks.supabase = { ok: true, msg: "Conectado" };
  } catch (e) {
    checks.supabase = { ok: false, msg: e.message };
    errors++;
  }

  // 2. Inscripciones
  try {
    const data = await supaFetch("inscripciones?select=id,instancia");
    const byInst = {};
    data.forEach(r => { byInst[r.instancia] = (byInst[r.instancia] || 0) + 1; });
    checks.inscripciones = { ok: true, total: data.length, por_instancia: byInst };
  } catch (e) {
    checks.inscripciones = { ok: false, msg: e.message };
    errors++;
  }

  // 3. Lineup sincronizado
  try {
    const lineup = await supaFetch("lineup?select=id,estado,instancia", "evento");
    const estados = {};
    lineup.forEach(r => { estados[r.estado] = (estados[r.estado] || 0) + 1; });
    const inscrCount = checks.inscripciones?.total || 0;
    const synced = lineup.length >= inscrCount;
    checks.lineup = { ok: true, total: lineup.length, estados, sincronizado: synced ? "OK" : `DESYNC: ${lineup.length} vs ${inscrCount} inscripciones` };
    if (!synced) errors++;
  } catch (e) {
    checks.lineup = { ok: false, msg: e.message };
    errors++;
  }

  // 4. Usuarios (jurados + director)
  try {
    const users = await supaFetch("usuarios?select=username,rol,activo,juez_num,items", "personal");
    const director = users.find(u => u.rol === "director");
    const jurados = users.filter(u => u.rol === "jurado");
    const activos = jurados.filter(u => u.activo);
    const sinItems = activos.filter(u => !u.items || u.items.length === 0);
    checks.usuarios = {
      ok: true,
      director: director ? "OK" : "FALTA",
      jurados_total: jurados.length,
      jurados_activos: activos.length,
      jurados_sin_items: sinItems.length,
      jurados_sin_items_list: sinItems.map(u => u.username),
    };
    if (!director) errors++;
    if (sinItems.length > 0) checks.usuarios.warning = "Jurados activos sin items asignados";
  } catch (e) {
    checks.usuarios = { ok: false, msg: e.message };
    errors++;
  }

  // 5. Sesiones activas
  try {
    const sesiones = await supaFetch("sesiones?select=id,codigo_id,nombre_grupo,activa,instancia&order=id.desc&limit=5", "scoring");
    const activa = sesiones.find(s => s.activa);
    checks.sesiones = {
      ok: true,
      total: sesiones.length,
      activa: activa ? { id: activa.id, codigo: activa.codigo_id, nombre: activa.nombre_grupo } : null,
      ultimas: sesiones.slice(0, 3).map(s => ({ id: s.id, codigo: s.codigo_id, activa: s.activa })),
    };
  } catch (e) {
    checks.sesiones = { ok: false, msg: e.message };
    errors++;
  }

  // 6. Puntajes
  try {
    const puntajes = await supaFetch("puntajes?select=id,sesion_id,juez_num,subtotal,cerrado&order=id.desc&limit=10", "scoring");
    checks.puntajes = { ok: true, total_recientes: puntajes.length, ultimos: puntajes.slice(0, 3) };
  } catch (e) {
    checks.puntajes = { ok: false, msg: e.message };
    errors++;
  }

  // 7. Config evento
  try {
    const config = await supaFetch("config?select=clave,valor", "evento");
    const pin = config.find(c => c.clave === "pin_evento");
    checks.config_evento = { ok: !!pin, pin_configurado: !!pin, claves: config.map(c => c.clave) };
    if (!pin) errors++;
  } catch (e) {
    checks.config_evento = { ok: false, msg: e.message };
    errors++;
  }

  // 8. Resend API
  try {
    if (process.env.RESEND_API_KEY) {
      checks.resend = { ok: true, msg: "API key configurada" };
    } else {
      checks.resend = { ok: false, msg: "RESEND_API_KEY no configurada" };
      errors++;
    }
  } catch (e) {
    checks.resend = { ok: false, msg: e.message };
    errors++;
  }

  // 9. Códigos consistentes
  try {
    const lineup = await supaFetch("lineup?select=codigo_id,instancia", "evento");
    const badCodes = lineup.filter(l => {
      if (l.instancia === "int" && !l.codigo_id.startsWith("JAM-INT-1")) return true;
      if (l.instancia === "reg" && !l.codigo_id.startsWith("JAM-REG-5")) return true;
      return false;
    });
    checks.codigos = { ok: badCodes.length === 0, total: lineup.length, errores: badCodes.length, bad: badCodes.slice(0, 5) };
    if (badCodes.length > 0) errors++;
  } catch (e) {
    checks.codigos = { ok: false, msg: e.message };
    errors++;
  }

  const elapsed = Date.now() - t0;
  const status = errors === 0 ? "HEALTHY" : errors <= 2 ? "WARNING" : "CRITICAL";

  return res.status(200).json({
    system: "JAM 2026",
    status,
    errors,
    timestamp: new Date().toISOString(),
    elapsed_ms: elapsed,
    checks,
  });
};
