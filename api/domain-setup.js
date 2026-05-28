// Endpoint temporal para gestionar el dominio en Resend + DNS lookup
// GET /api/domain-setup.js?action=list|add|get&id=|verify&id=|dns&name=

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const action = (req.query.action || 'list').toLowerCase();
  const id = req.query.id;
  const base = 'https://api.resend.com/domains';
  const H = { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' };

  try {
    if (action === 'dns') {
      const name = req.query.name || 'jamcompetencia.com';
      const types = ['NS','MX','TXT','A','CNAME'];
      const out = {};
      for (const t of types) {
        const r = await fetch('https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=' + t);
        const d = await r.json();
        out[t] = (d.Answer || []).map(a => a.data);
      }
      return res.status(200).json({ domain: name, records: out });
    }
    if (!RESEND_KEY) return res.status(500).json({ error: 'No RESEND_API_KEY' });
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
    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
