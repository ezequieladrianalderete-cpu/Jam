// Endpoint temporal para gestionar el dominio en Resend vía API
// GET  /api/domain-setup?action=list           -> lista dominios
// GET  /api/domain-setup?action=add            -> agrega jamcompetencia.com
// GET  /api/domain-setup?action=verify&id=XXX  -> dispara verificación
// GET  /api/domain-setup?action=get&id=XXX     -> detalle (records DNS)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'No RESEND_API_KEY' });

  const action = (req.query.action || 'list').toLowerCase();
  const id = req.query.id;
  const base = 'https://api.resend.com/domains';
  const H = { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' };

  try {
    if (action === 'list') {
      const r = await fetch(base, { headers: H });
      return res.status(r.status).json(await r.json());
    }
    if (action === 'add') {
      const r = await fetch(base, { method: 'POST', headers: H, body: JSON.stringify({ name: 'jamcompetencia.com', region: 'us-east-1' }) });
      return res.status(r.status).json(await r.json());
    }
    if (action === 'get' && id) {
      const r = await fetch(base + '/' + id, { headers: H });
      return res.status(r.status).json(await r.json());
    }
    if (action === 'verify' && id) {
      const r = await fetch(base + '/' + id + '/verify', { method: 'POST', headers: H });
      return res.status(r.status).json(await r.json());
    }
    return res.status(400).json({ error: 'Invalid action', usage: 'action=list|add|get&id=|verify&id=' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
