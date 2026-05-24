// Vercel Serverless Function - JAM 2026
// POST /api/notify { id: "uuid" }
// Lee inscripcion de Supabase, genera QR y envia email via Resend

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Parse body
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const id = body && body.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    // Env vars
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const SITE_URL = process.env.SITE_URL || 'https://jam-inscripciones.vercel.app';

    if (!SB_URL || !SB_KEY || !RESEND_KEY) {
      return res.status(500).json({ 
        error: 'Missing env vars', 
        has: { SB_URL: !!SB_URL, SB_KEY: !!SB_KEY, RESEND_KEY: !!RESEND_KEY }
      });
    }

    // 1. Leer inscripcion de Supabase via REST
    const sbResp = await fetch(`${SB_URL}/rest/v1/inscripciones?id=eq.${id}&select=*`, {
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY
      }
    });
    if (!sbResp.ok) {
      const err = await sbResp.text();
      return res.status(500).json({ error: 'Supabase fetch failed', status: sbResp.status, detail: err.substring(0, 200) });
    }
    const rows = await sbResp.json();
    const ins = rows && rows[0];
    if (!ins) return res.status(404).json({ error: 'Inscripcion not found', id });

    // 2. Generar QR code via API publica (no requiere package)
    const qrData = encodeURIComponent(`JAM2026-${ins.id}`);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${qrData}`;

    // 3. Construir mail HTML
    const musicaLink = ins.musica_token 
      ? `<p><a href="${SITE_URL}/musica?token=${ins.musica_token}">Subir tu musica para el evento</a></p>` 
      : '';
    const instancia = (ins.instancia || '').toUpperCase();
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h1 style="color:#d32f2f">JAM 2026 - Inscripcion confirmada</h1>
      <p>Hola <strong>${ins.nombre || ''}</strong>,</p>
      <p>Tu inscripcion a <strong>${instancia}</strong> fue recibida correctamente.</p>
      <p><strong>ID:</strong> ${ins.id}</p>
      <p><strong>Monto:</strong> ${ins.moneda || 'ARS'} ${ins.monto_total || 0}</p>
      <p><strong>Tu codigo QR:</strong></p>
      <img src="${qrUrl}" alt="QR" style="display:block;margin:20px 0" />
      ${musicaLink}
      <p>Evento: 2, 3 y 4 de Octubre 2026 - Palais Rouge, CABA</p>
      <hr/>
      <p style="font-size:12px;color:#888">JAM Dance Competition 2026</p>
    </div>`;

    // 4. Enviar email via Resend REST API
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'JAM 2026 <onboarding@resend.dev>',
        to: [ins.email],
        subject: `Inscripcion JAM 2026 confirmada - ${instancia}`,
        html: html
      })
    });

    const resendData = await resendResp.json();
    if (!resendResp.ok) {
      return res.status(500).json({ 
        error: 'Resend failed', 
        status: resendResp.status, 
        detail: resendData 
      });
    }

    return res.status(200).json({ 
      ok: true, 
      id, 
      email: ins.email,
      resend_id: resendData.id
    });

  } catch (e) {
    return res.status(500).json({ 
      error: 'Exception', 
      message: e.message,
      stack: (e.stack || '').substring(0, 500)
    });
  }
};
