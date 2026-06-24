// /api/health.js — JAM 2026 System Health Check
async function supaFetch(path, profile) {
  const url = process.env.SUPABASE_URL + '/rest/v1/' + path;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  };
  if (profile) headers['Accept-Profile'] = profile;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(res.status + ': ' + (await res.text()).substring(0, 100));
  return res.json();
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const checks = {};
  let errors = 0, warnings = 0;

  // 1. Supabase connection
  try {
    await supaFetch('inscripciones?select=id&limit=1');
    checks.supabase = { ok: true };
  } catch (e) { checks.supabase = { ok: false, error: e.message }; errors++; }

  // 2. Inscripciones por instancia
  try {
    const data = await supaFetch('inscripciones?select=id,instancia');
    const byInst = {};
    data.forEach(r => { byInst[r.instancia] = (byInst[r.instancia] || 0) + 1; });
    checks.inscripciones = { ok: true, total: data.length, por_instancia: byInst };
  } catch (e) { checks.inscripciones = { ok: false, error: e.message }; errors++; }

  // 3. Lineup sync
  try {
    const lineup = await supaFetch('lineup?select=id,estado,instancia,inscripcion_id', 'evento');
    const estados = {};
    lineup.forEach(r => { estados[r.estado] = (estados[r.estado] || 0) + 1; });
    const inscrCount = checks.inscripciones?.total || 0;
    const diff = Math.abs(lineup.length - inscrCount);
    checks.lineup = { ok: diff <= 1, total: lineup.length, estados, diff_with_inscripciones: diff };
    if (diff > 1) warnings++;
  } catch (e) { checks.lineup = { ok: false, error: e.message }; errors++; }

  // 4. Codigos consistentes
  try {
    const lineup = await supaFetch('lineup?select=codigo_id,instancia', 'evento');
    const bad = lineup.filter(l => {
      if (l.instancia === 'int' && !l.codigo_id.startsWith('JAM-INTER-')) return true;
      if (l.instancia === 'nac' && !l.codigo_id.startsWith('JAM-NAC-')) return true;
      if (l.instancia === 'reg') {
        if (!l.codigo_id.startsWith('JAM-REG-')) return true;
        const n = parseInt(l.codigo_id.split('-')[2]);
        if (n > 4999) return true;
      }
      return false;
    });
    checks.codigos = { ok: bad.length === 0, total: lineup.length, mal_formateados: bad.length, samples: bad.slice(0,5).map(b=>b.codigo_id) };
    if (bad.length > 0) errors++;
  } catch (e) { checks.codigos = { ok: false, error: e.message }; errors++; }

  // 5. Usuarios
  try {
    const users = await supaFetch('usuarios?select=username,rol,activo,juez_num,items', 'personal');
    const jurados = users.filter(u => u.rol === 'jurado' && u.activo);
    const director = users.find(u => u.rol === 'director');
    const sinItems = jurados.filter(u => !u.items || (Array.isArray(u.items) && u.items.length === 0));
    checks.usuarios = { ok: !!director, director: !!director, jurados_activos: jurados.length, jurados_sin_items: sinItems.length };
    if (!director) errors++;
  } catch (e) { checks.usuarios = { ok: false, error: e.message }; errors++; }

  // 6. Sesiones scoring
  try {
    const ses = await supaFetch('sesiones?select=id,activa&order=id.desc&limit=20', 'scoring');
    const activa = ses.find(s => s.activa);
    checks.sesiones = { ok: true, total_recientes: ses.length, activa: !!activa, activa_id: activa?.id };
  } catch (e) { checks.sesiones = { ok: false, error: e.message }; errors++; }

  // 7. Resend
  checks.resend = { ok: !!process.env.RESEND_API_KEY };
  if (!process.env.RESEND_API_KEY) errors++;

  // 8. Config precios
  try {
    const cfg = await supaFetch('config_precios?select=*');
    checks.config_precios = { ok: cfg.length > 0, configurado: cfg.length > 0 };
    if (cfg.length === 0) warnings++;
  } catch (e) { checks.config_precios = { ok: false, error: e.message }; warnings++; }

  // 9. Realtime tables enabled
  checks.realtime = { ok: true, msg: 'Verificar manualmente en Supabase: scoring.sesiones, scoring.puntajes, evento.lineup' };

  const elapsed = Date.now() - t0;
  const status = errors === 0 ? (warnings === 0 ? 'HEALTHY' : 'WARNING') : errors <= 2 ? 'WARNING' : 'CRITICAL';

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    system: 'JAM 2026',
    status,
    errors,
    warnings,
    timestamp: new Date().toISOString(),
    elapsed_ms: elapsed,
    checks,
  });
};
