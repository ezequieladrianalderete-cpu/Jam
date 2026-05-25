// Vercel Serverless Function - JAM 2026
// POST /api/notify { id: "uuid" }
// v4: fix quoted-printable encoding bug en URLs (escapeo '=' con HTML entity)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const id = body && body.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const SITE_URL = process.env.SITE_URL || 'https://jam-inscripciones.vercel.app';

    if (!SB_URL || !SB_KEY || !RESEND_KEY) {
      return res.status(500).json({ error: 'Missing env vars', has: { SB_URL: !!SB_URL, SB_KEY: !!SB_KEY, RESEND_KEY: !!RESEND_KEY } });
    }

    // 1. Leer inscripcion
    const sbResp = await fetch(`${SB_URL}/rest/v1/inscripciones?id=eq.${id}&select=*`, {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    });
    if (!sbResp.ok) {
      const err = await sbResp.text();
      return res.status(500).json({ error: 'Supabase fetch failed', status: sbResp.status, detail: err.substring(0, 200) });
    }
    const rows = await sbResp.json();
    const ins = rows && rows[0];
    if (!ins) return res.status(404).json({ error: 'Inscripcion not found', id });

    // 2. Construir URLs - fix bug quoted-printable: reemplazar '=' por entidad HTML
    // Resend (al envolver lineas largas en quoted-printable) come '=' de URLs.
    // Si en HTML usamos &#x3D; en lugar de '=', el cliente de mail lo decodifica
    // de vuelta a '=' al renderizar, y la URL queda intacta.
    const qrUrlRaw = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=JAM2026-' + ins.id;
    const qrUrl = qrUrlRaw.replace(/=/g, '&#x3D;');
    const musicaUrlRaw = ins.musica_token ? (SITE_URL + '/musica?token=' + ins.musica_token) : null;
    const musicaUrl = musicaUrlRaw ? musicaUrlRaw.replace(/=/g, '&#x3D;') : null;

    const musicaLink = musicaUrl
      ? `<p style="margin:20px 0"><a href="${musicaUrl}" style="background:#d32f2f;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold">Subi tu musica para el evento</a></p>`
      : '';

    const instancia = (ins.instancia || '').toUpperCase();
    const nombre = ins.nombre || '';
    const monto = (ins.moneda || 'ARS') + ' ' + (ins.monto_total || 0);

    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
<h1 style="color:#d32f2f;margin-bottom:8px">JAM 2026</h1>
<p style="color:#888;margin-bottom:20px">Inscripcion confirmada</p>
<p>Hola <strong>${nombre}</strong>,</p>
<p>Tu inscripcion a <strong>${instancia}</strong> fue recibida correctamente.</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">ID</td><td style="padding:8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px">${ins.id}</td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Modalidad</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${ins.modalidad || ''}</strong></td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Monto</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${monto}</strong></td></tr>
</table>
<p><strong>Tu codigo QR:</strong></p>
<p style="text-align:center"><img src="${qrUrl}" alt="QR" style="border:1px solid #ddd;padding:8px;background:#fff" /></p>
${musicaLink}
<hr style="margin:30px 0;border:0;border-top:1px solid #eee" />
<p style="color:#888;font-size:13px">Evento: 2, 3 y 4 de Octubre 2026 - Palais Rouge, CABA</p>
<p style="color:#aaa;font-size:11px;margin-top:10px">JAM Dance Competition 2026</p>
</div>`;

    // Version texto plano (sin afectar QP)
    const textParts = [
      'JAM 2026 - Inscripcion confirmada',
      '',
      'Hola ' + nombre + ',',
      '',
      'Tu inscripcion a ' + instancia + ' fue recibida correctamente.',
      '',
      'ID: ' + ins.id,
      'Modalidad: ' + (ins.modalidad || ''),
      'Monto: ' + monto,
      ''
    ];
    if (musicaUrlRaw) {
      textParts.push('Subi tu musica:');
      textParts.push(musicaUrlRaw);
      textParts.push('');
    }
    textParts.push('Evento: 2, 3 y 4 de Octubre 2026 - Palais Rouge, CABA');
    const text = textParts.join('\n');

    // 3. Enviar via Resend
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'JAM 2026 <onboarding@resend.dev>',
        to: [ins.email],
        subject: 'Inscripcion JAM 2026 confirmada - ' + instancia,
        html: html,
        text: text
      })
    });

    const resendData = await resendResp.json();
    if (!resendResp.ok) {
      return res.status(500).json({ error: 'Resend failed', status: resendResp.status, detail: resendData });
    }

    return res.status(200).json({ ok: true, id, email: ins.email, resend_id: resendData.id });

  } catch (e) {
    return res.status(500).json({ error: 'Exception', message: e.message, stack: (e.stack || '').substring(0, 500) });
  }
};
