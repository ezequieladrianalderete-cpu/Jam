// Vercel Serverless Function - JAM 2026
// POST /api/notify { id: "uuid" }
// v7: codigo legible secuencial JAM-XXX-NNNN + QR apuntando a /check?id=...

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
    if (!SB_URL || !SB_KEY || !RESEND_KEY) return res.status(500).json({ error: 'Missing env vars' });

    const sbHeaders = { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY };
    const sbResp = await fetch(`${SB_URL}/rest/v1/inscripciones?id=eq.${id}&select=*`, { headers: sbHeaders });
    if (!sbResp.ok) return res.status(500).json({ error: 'Supabase fetch failed', detail: (await sbResp.text()).substring(0,200) });
    const rows = await sbResp.json();
    const ins = rows && rows[0];
    if (!ins) return res.status(404).json({ error: 'Inscripcion not found', id });

    let codigoLegible = 'JAM-' + (ins.instancia || '').toUpperCase() + '-XXXX';
    try {
      const seqResp = await fetch(`${SB_URL}/rest/v1/inscripciones?instancia=eq.${ins.instancia}&created_at=lte.${encodeURIComponent(ins.created_at)}&select=id&order=created_at.asc`, { headers: sbHeaders });
      if (seqResp.ok) {
        const seqRows = await seqResp.json();
        const pos = seqRows.findIndex(x => x.id === ins.id) + 1;
        const seq = String(pos > 0 ? pos : seqRows.length).padStart(4, '0');
        codigoLegible = 'JAM-' + (ins.instancia || '').toUpperCase() + '-' + seq;
      }
    } catch (e) {}

    const escEq = u => u.replace(/=/g, '&#x3D;');
    const checkUrlRaw = SITE_URL + '/check?id=' + ins.id;
    const checkUrlSafe = escEq(checkUrlRaw);
    const qrUrlRaw = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(checkUrlRaw);
    const qrUrl = escEq(qrUrlRaw);
    const musicaUrlRaw = ins.musica_token ? (SITE_URL + '/musica?token=' + ins.musica_token) : null;
    const musicaUrl = musicaUrlRaw ? escEq(musicaUrlRaw) : null;
    const musicaLink = musicaUrl
      ? `<p style="margin:20px 0"><a href="${musicaUrl}" style="background:#d32f2f;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold">Subi tu musica para el evento</a></p>`
      : '';

    const instancia = (ins.instancia || '').toUpperCase();
    const nombre = ins.nombre || '';
    const monto = (ins.moneda || 'ARS') + ' ' + (ins.monto_total || 0);
    const sedeNombre = ins.sede_nombre || '';

    async function sendMail(to, subject, html) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'JAM 2026 <onboarding@resend.dev>', to: [to], subject, html })
        });
        const d = await r.json();
        if (r.ok) return { ok: true, id: d.id, to };
        return { ok: false, to, status: r.status, error: d };
      } catch (e) { return { ok: false, to, error: e.message }; }
    }

    const htmlParticipante = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
<h1 style="color:#d32f2f;margin-bottom:6px">JAM 2026</h1>
<p style="color:#888;margin-bottom:24px">Inscripcion confirmada</p>
<div style="background:linear-gradient(135deg,#d32f2f,#b71c1c);color:#fff;padding:22px;border-radius:12px;margin-bottom:24px;text-align:center">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;opacity:0.85;margin-bottom:6px">Tu codigo de participante</div>
<div style="font-size:30px;font-weight:800;letter-spacing:2px;font-family:monospace">${codigoLegible}</div>
</div>
<p>Hola <strong>${nombre}</strong>,</p>
<p>Tu inscripcion a <strong>${instancia}</strong>${sedeNombre ? ' (Sede: ' + sedeNombre + ')' : ''} fue recibida correctamente.</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Modalidad</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${ins.modalidad || ''}</strong></td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Monto</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${monto}</strong></td></tr>
</table>
<p style="margin-top:24px"><strong>Tu codigo QR:</strong></p>
<p style="text-align:center"><img src="${qrUrl}" alt="QR" style="border:1px solid #ddd;padding:8px;background:#fff;border-radius:8px" /></p>
<p style="text-align:center;color:#888;font-size:12px">Escanealo para ver tus datos</p>
${musicaLink}
<p style="margin-top:24px"><a href="${checkUrlSafe}" style="color:#d32f2f;text-decoration:underline">Ver detalles online</a></p>
<hr style="margin:30px 0;border:0;border-top:1px solid #eee" />
<p style="color:#888;font-size:13px">Evento: 2, 3 y 4 de Octubre 2026 - Palais Rouge, CABA</p>
</div>`;

    const mailPart = await sendMail(ins.email, 'Inscripcion JAM 2026 confirmada - ' + codigoLegible, htmlParticipante);

    let mailSede = null;
    const sedeEmail = (ins.sede_email_org || '').trim();
    const isValidEmail = sedeEmail && sedeEmail.indexOf('@') > 0 && sedeEmail.indexOf('.') > 0;
    if (isValidEmail && ins.instancia === 'reg') {
      const htmlSede = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
<h1 style="color:#d32f2f;margin-bottom:8px">JAM 2026 - Nueva inscripcion en tu sede</h1>
<p>Se inscribio un nuevo participante en la sede <strong>${sedeNombre}</strong>.</p>
<div style="background:#f5f5f5;padding:14px;border-radius:8px;margin:16px 0;text-align:center">
<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Codigo asignado</div>
<div style="font-size:22px;font-weight:bold;color:#d32f2f;font-family:monospace;letter-spacing:1px;margin-top:4px">${codigoLegible}</div>
</div>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Nombre</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${nombre}</strong></td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Email</td><td style="padding:8px;border-bottom:1px solid #eee">${ins.email || ''}</td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Celular</td><td style="padding:8px;border-bottom:1px solid #eee">${ins.celular || ''}</td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Modalidad</td><td style="padding:8px;border-bottom:1px solid #eee">${ins.modalidad || ''}${ins.cant_personas > 1 ? ' (' + ins.cant_personas + ' personas)' : ''}</td></tr>
<tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Monto</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${monto}</strong></td></tr>
</table>
<p style="margin-top:20px"><a href="${checkUrlSafe}" style="background:#d32f2f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold">Ver detalles del inscripto</a></p>
<p style="color:#888;font-size:12px;margin-top:20px">Mail informativo - el participante ya recibio su confirmacion.</p>
</div>`;
      mailSede = await sendMail(sedeEmail, 'Nueva inscripcion ' + codigoLegible + ' - ' + nombre, htmlSede);
    }

    return res.status(200).json({
      ok: true,
      id,
      codigo_legible: codigoLegible,
      check_url: checkUrlRaw,
      mail_participante: mailPart,
      mail_sede: mailSede
    });

  } catch (e) {
    return res.status(500).json({ error: 'Exception', message: e.message });
  }
};
