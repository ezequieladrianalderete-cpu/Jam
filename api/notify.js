// Vercel Serverless Function - JAM 2026
// POST /api/notify { id: "uuid" }
const RESEND_KEY = process.env.RESEND_API_KEY;
const SB_URL = process.env.SUPABASE_URL || 'https://paexpktmcytccjphoppu.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://jam-inscripciones.vercel.app';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

async function sbFetch(path, opts = {}) {
  const r = await fetch(SB_URL + '/rest/v1' + path, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) }
  });
  return r.json();
}

async function getQR(text) {
  const r = await fetch('https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(text) + '&format=png');
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function sendMail(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'JAM 2026 <inscripciones@jam2026.com>', to: [].concat(to), subject, html })
  });
  return r.json();
}

function buildHTML(rec, qr) {
  const isReg = rec.instancia === 'reg';
  const ac = rec.instancia === 'int' ? '#4B96D8' : '#C9A84C';
  const titles = { reg: 'Pre-inscripcion Sedes JAM 2026', nac: 'Final Nacional JAM 2026', int: 'Inter America Dance Competition 2026', rep: 'Repesca JAM 2026' };
  const cats = (rec.categorias || []).map(c => '<li>' + c.c + ' - ' + c.n + '</li>').join('');
  const musLink = rec.musica_token ? SITE_URL + '/musica?token=' + rec.musica_token : null;
  const qrSec = !isReg && qr ? '<div style="text-align:center;margin:20px 0"><img src="data:image/png;base64,' + qr + '" style="width:180px;border:3px solid ' + ac + ';border-radius:10px"><p style="color:#999;font-size:11px;margin-top:6px">Presentalo el dia del evento</p></div>' : '';
  const musSec = musLink && rec.musica_estado === 'pendiente' ? '<div style="background:#EBF5FF;border-left:4px solid ' + ac + ';padding:16px;margin:20px 0;border-radius:0 8px 8px 0"><p style="font-weight:700;color:' + ac + ';margin:0 0 8px">Carga tu musica</p><a href="' + musLink + '" style="background:' + ac + ';color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700">Cargar musica</a></div>' : '';
  return '<!DOCTYPE html><html><body style="font-family:Arial;background:#f4f4f4;margin:0"><div style="max-width:560px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:#0a0a0a;padding:24px;text-align:center"><div style="font-size:26px;font-weight:900;color:' + ac + ';letter-spacing:4px">JAM</div><div style="color:#aaa;font-size:11px;letter-spacing:2px">DANCE COMPETITION 2026</div></div><div style="padding:24px"><h2 style="color:#111;margin:0 0 12px">' + titles[rec.instancia] + '</h2><p>Hola <b>' + rec.nombre + '</b>, tu inscripcion fue recibida correctamente.</p><table style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:8px;margin:16px 0"><tr><td style="padding:8px;color:#888">N inscripcion</td><td style="padding:8px;font-family:monospace">' + (rec.id || '').substring(0, 8).toUpperCase() + '</td></tr>' + (isReg && rec.sede_nombre ? '<tr><td style="padding:8px;color:#888">Sede</td><td style="padding:8px">' + rec.sede_nombre + '</td></tr>' : '') + (!isReg ? '<tr><td style="padding:8px;color:#888">Monto</td><td style="padding:8px;font-weight:700;color:' + ac + '">' + rec.moneda + ' ' + Number(rec.monto_total || 0).toLocaleString() + '</td></tr>' : '') + '<tr><td style="padding:8px;color:#888;vertical-align:top">Categorias</td><td style="padding:8px"><ul style="margin:0;padding-left:16px">' + cats + '</ul></td></tr></table>' + qrSec + musSec + '<div style="background:#FFF8E1;border-left:4px solid #FFD54F;padding:14px;margin:20px 0;border-radius:0 8px 8px 0"><p style="font-weight:700;color:#E65100;margin:0 0 6px">Declaracion Jurada</p><p style="color:#555;font-size:13px;margin:0">Imprime la planilla adjunta, completala y presentala el dia del evento.</p></div><p style="color:#999;font-size:11px;text-align:center">JAM Dance Competition 2026 - Palais Rouge - Salguero 1441 CABA</p></div></div></body></html>';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { id } = req.body;
    if (!id || id.length < 10) return res.status(400).json({ error: 'Invalid id' });
    const rows = await sbFetch('/inscripciones?id=eq.' + id + '&limit=1');
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'Not found', id });
    const rec = rows[0];
    const isReg = rec.instancia === 'reg';
    const subjects = { reg: 'Pre-inscripcion recibida - JAM 2026', nac: 'Confirmacion Final Nacional - JAM 2026', int: 'Confirmacion INTERAMERICA 2026', rep: 'Confirmacion Repesca - JAM 2026' };
    let qr = '';
    if (!isReg) {
      try {
        qr = await getQR('JAM2026|' + rec.instancia.toUpperCase() + '|' + rec.id + '|' + rec.email);
        await sbFetch('/inscripciones?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ qr_codigo: 'data:image/png;base64,' + qr }) });
      } catch (qrErr) { console.error('QR error:', qrErr.message); }
    }
    const html = buildHTML(rec, qr);
    const mailRes = await sendMail(rec.email, subjects[rec.instancia] || 'JAM 2026', html);
    if (isReg && rec.sede_email_org) {
      await sendMail(rec.sede_email_org, 'Nueva inscripcion: ' + rec.nombre, '<div style="font-family:Arial;padding:20px"><h2>' + rec.nombre + '</h2><p>Email: ' + rec.email + '</p><p>Sede: ' + rec.sede_nombre + '</p></div>');
    }
    return res.status(200).json({ ok: true, email: mailRes.id, name: rec.nombre });
  } catch (e) {
    console.error('notify error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
