// Vercel Serverless Function - JAM 2026
// POST /api/notify { id: "uuid" }
// v10: IDs JAM-{INSTANCIA}-{NNNN} con offset + integrantes -N + VIAMONTE2600/CBU/Titular (NAC/REP/REG) + Prex (INTER)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const INSTANCIA_CFG = {
    reg: { prefix: 'REG',   offset: 1,    pad: 4, label: 'Sedes' },
    rep: { prefix: 'REP',   offset: 10,   pad: 4, label: 'Repechaje' },
    nac: { prefix: 'NAC',   offset: 200,  pad: 4, label: 'Final Nacional' },
    int: { prefix: 'INTER', offset: 1000, pad: 4, label: 'Final Inter América' }
  };

  function parseIntegrantes(raw) {
    if (!raw) return [];
    try {
      if (typeof raw === 'string') {
        const t = raw.trim();
        if (t.startsWith('[')) return JSON.parse(t);
        return t.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).map(n => ({ nombre: n }));
      }
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'object') return [raw];
    } catch (e) {
      if (typeof raw === 'string') return raw.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).map(n => ({ nombre: n }));
    }
    return [];
  }

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

    const inst = (ins.instancia || '').toLowerCase();
    const cfg = INSTANCIA_CFG[inst] || { prefix: (ins.instancia||'').toUpperCase(), offset: 1, pad: 4, label: '' };
    let codigoLegible = `JAM-${cfg.prefix}-${String(cfg.offset).padStart(cfg.pad,'0')}`;
    try {
      const seqResp = await fetch(`${SB_URL}/rest/v1/inscripciones?instancia=eq.${ins.instancia}&created_at=lte.${encodeURIComponent(ins.created_at)}&select=id&order=created_at.asc`, { headers: sbHeaders });
      if (seqResp.ok) {
        const seqRows = await seqResp.json();
        const pos = seqRows.findIndex(x => x.id === ins.id) + 1;
        const num = cfg.offset + (Math.max(pos, 1) - 1);
        codigoLegible = `JAM-${cfg.prefix}-${String(num).padStart(cfg.pad,'0')}`;
      }
    } catch (e) {}

    const escEq = u => u.replace(/=/g, '&#x3D;');
    const checkUrlRaw = SITE_URL + '/check?id=' + ins.id;
    const checkUrlSafe = escEq(checkUrlRaw);
    const qrUrlRaw = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(checkUrlRaw);
    const qrUrl = escEq(qrUrlRaw);
    const musicaUrlRaw = ins.musica_token ? (SITE_URL + '/musica?token=' + ins.musica_token) : null;
    const musicaUrl = musicaUrlRaw ? escEq(musicaUrlRaw) : null;

    const integrantes = parseIntegrantes(ins.integrantes);
    let categorias = [];
    try {
      categorias = typeof ins.categorias === 'string' ? JSON.parse(ins.categorias) : (ins.categorias || []);
      if (!Array.isArray(categorias)) categorias = [];
    } catch(e) { categorias = []; }

    const nombre = ins.nombre || '';
    const grupo = ins.nombre_grupo || nombre;
    const monto = (ins.moneda || 'ARS') + ' ' + (+(ins.monto_total||0)).toLocaleString('es-AR');
    const sedeNombre = ins.sede_nombre || '';
    const pagoConfirmado = ins.pago_estado === 'confirmado';

    const integrantesRows = integrantes.length ? integrantes.map((int, idx) => {
      const n = int.nombre || int.name || (typeof int === 'string' ? int : 'Integrante ' + (idx+1));
      const sub = codigoLegible + '-' + (idx+1);
      return `<tr><td style="padding:10px 12px;background:#1a1600;border-left:3px solid #C9A84C">
        <div style="font-family:'Courier New',monospace;font-size:12px;color:#C9A84C;letter-spacing:1px;font-weight:600;margin-bottom:3px">${sub}</div>
        <div style="font-family:Georgia,serif;font-size:16px;color:#F8F5EE;font-weight:600">${n}</div>
        ${grupo && grupo !== n ? `<div style="font-size:11px;color:#888;margin-top:2px">${grupo}</div>` : ''}
      </td></tr>`;
    }).join('') : '';

    const categoriasRows = categorias.length ? categorias.map(c =>
      `<tr><td style="padding:10px 12px;background:#1a1600;border-left:3px solid #C9A84C">
         <div style="font-family:'Courier New',monospace;font-size:11px;color:#C9A84C;margin-bottom:3px;font-weight:600">N° ${c.c || '—'} · ${(c.g||'').toUpperCase()}</div>
         <div style="font-family:Georgia,serif;font-size:16px;color:#F8F5EE;font-weight:600">${c.n || 'Sin nombre'}</div>
       </td></tr>`
    ).join('') : `<tr><td style="padding:14px;text-align:center;color:#888;font-style:italic;font-size:13px">No hay categorías registradas</td></tr>`;

    // BLOQUE DE PAGO según instancia
    let pagoBlock = '';
    if (!pagoConfirmado) {
      if (inst === 'nac' || inst === 'rep' || inst === 'reg') {
        pagoBlock = `<div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0">
          <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:14px;text-align:center">Datos para pagar · Transferencia</div>
          <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
            <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Alias</div>
            <div style="font-family:'Courier New',monospace;font-size:18px;color:#F8F5EE;font-weight:700;letter-spacing:2px">VIAMONTE2600</div>
          </div>
          <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
            <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">CBU</div>
            <div style="font-family:'Courier New',monospace;font-size:15px;color:#F8F5EE;font-weight:600;letter-spacing:.5px;word-break:break-all">000000310009572128629</div>
          </div>
          <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px">
            <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Titular</div>
            <div style="font-family:Georgia,serif;font-size:17px;color:#F8F5EE;font-weight:600">Liliana Naomi Tanabe</div>
          </div>
          <div style="font-size:12px;color:rgba(248,245,238,.6);text-align:center;margin-top:14px;line-height:1.5">Una vez realizada la transferencia, enviá el comprobante a la organización para confirmar tu inscripción.</div>
        </div>`;
      } else if (inst === 'int') {
        pagoBlock = `<div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0">
          <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:14px;text-align:center">Datos para pagar · Inter América</div>
          <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
            <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Plataforma de pago</div>
            <div style="font-family:Georgia,serif;font-size:22px;color:#F8F5EE;font-weight:700">Prex</div>
          </div>
          <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
            <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Cuenta / Alias Prex</div>
            <div style="font-family:'Courier New',monospace;font-size:14px;color:#E8A838">A confirmar con la organización</div>
          </div>
          <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px">
            <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Titular responsable</div>
            <div style="font-family:Georgia,serif;font-size:15px;color:#E8A838">A confirmar con la organización</div>
          </div>
          <div style="font-size:12px;color:rgba(248,245,238,.6);text-align:center;margin-top:14px;line-height:1.5">La instancia Inter América se abona <strong style="color:#C9A84C">exclusivamente</strong> vía Prex. Contactá a la organización para recibir los datos.</div>
        </div>`;
      }
    } else {
      pagoBlock = `<div style="background:#001a0a;border:1px solid rgba(76,175,125,.3);border-radius:14px;padding:18px;margin:24px 0;text-align:center">
        <div style="color:#4CAF7D;font-size:14px;font-weight:600">✓ Pago confirmado</div>
        <div style="color:rgba(248,245,238,.5);font-size:12px;margin-top:4px">Tu inscripción está completa.</div>
      </div>`;
    }

    const musicaLink = musicaUrl
      ? `<p style="text-align:center;margin:24px 0"><a href="${musicaUrl}" style="background:#C9A84C;color:#0A0A0A;padding:13px 28px;border-radius:10px;text-decoration:none;display:inline-block;font-weight:700;font-size:14px;letter-spacing:.5px">♪ SUBÍ TU MÚSICA</a></p>`
      : '';

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

    const htmlParticipante = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">
<div style="background:#0A0A0A;padding:28px 24px;text-align:center">
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:42px;font-weight:700;letter-spacing:6px;color:#C9A84C;margin-bottom:6px">JAM</div>
  <div style="font-size:11px;color:rgba(248,245,238,.5);letter-spacing:2px;text-transform:uppercase">Inscripción confirmada · 2026</div>
</div>
<div style="background:linear-gradient(135deg,#111,#1a1800);padding:26px 24px;text-align:center;border-bottom:3px solid #C9A84C">
  <div style="font-size:10px;letter-spacing:3px;color:rgba(201,168,76,.6);text-transform:uppercase;font-weight:700;margin-bottom:10px">Tu código de inscripción</div>
  <div style="font-family:'Courier New',monospace;font-size:26px;color:#C9A84C;letter-spacing:3px;font-weight:600">${codigoLegible}</div>
  <div style="font-family:Georgia,serif;font-size:24px;color:#F8F5EE;font-weight:600;margin-top:14px">${grupo}</div>
  <div style="color:rgba(248,245,238,.5);font-size:12px;margin-top:4px">${cfg.label}${ins.pais ? ' · ' + ins.pais : ''}${sedeNombre ? ' · Sede ' + sedeNombre : ''}</div>
</div>
<div style="padding:24px">
  <p style="margin:0 0 16px;color:#444">Hola <strong>${nombre}</strong>, tu inscripción a <strong>${cfg.label}</strong> fue recibida correctamente.${integrantes.length > 0 ? ' A continuación los códigos individuales de cada integrante:' : ''}</p>

  ${integrantes.length ? `<h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Integrantes (${integrantes.length})</h3>
  <table style="width:100%;border-collapse:separate;border-spacing:0 6px;margin-bottom:20px">${integrantesRows}</table>` : ''}

  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Categorías inscriptas (${categorias.length})</h3>
  <table style="width:100%;border-collapse:separate;border-spacing:0 6px;margin-bottom:20px">${categoriasRows}</table>

  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Datos</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${nombre}</strong></td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Modalidad</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${ins.modalidad || '—'}</strong>${ins.cant_personas > 1 ? ' <span style="color:#888;font-size:12px">(' + ins.cant_personas + ' personas)</span>' : ''}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Monto</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#C9A84C;font-weight:700">${monto}</td></tr>
    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Fecha</td><td style="padding:8px 0;text-align:right">${new Date(ins.created_at).toLocaleString('es-AR')}</td></tr>
  </table>

  ${pagoBlock}

  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Tu código QR</h3>
  <p style="text-align:center"><img src="${qrUrl}" alt="QR" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" /></p>
  <p style="text-align:center;color:#888;font-size:12px">Escanealo para acceder a todos tus datos online</p>

  ${musicaLink}

  <p style="margin:24px 0 0;text-align:center"><a href="${checkUrlSafe}" style="color:#C9A84C;text-decoration:underline;font-size:13px">Ver mi inscripción online →</a></p>
</div>
<div style="background:#0A0A0A;padding:18px;text-align:center;color:rgba(248,245,238,.4);font-size:11px;line-height:1.7">
  <strong style="color:rgba(248,245,238,.6)">JAM Inter América Dance Competition 2026</strong><br>
  2, 3 y 4 de Octubre · Palais Rouge, CABA<br>Jerónimo Salguero 1441
</div>
</div>`;

    const mailPart = await sendMail(ins.email, `Inscripción JAM 2026 confirmada — ${codigoLegible}`, htmlParticipante);

    let mailSede = null;
    const sedeEmail = (ins.sede_email_org || '').trim();
    const isValidEmail = sedeEmail && sedeEmail.indexOf('@') > 0 && sedeEmail.indexOf('.') > 0;
    if (isValidEmail && inst === 'reg') {
      const htmlSede = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">
<div style="background:#0A0A0A;padding:24px;text-align:center">
  <div style="font-family:Georgia,serif;font-size:34px;font-weight:700;letter-spacing:5px;color:#C9A84C">JAM</div>
  <div style="font-size:10px;color:rgba(248,245,238,.5);letter-spacing:2px;text-transform:uppercase;margin-top:4px">Nueva inscripción en tu sede</div>
</div>
<div style="padding:24px">
  <p style="margin:0 0 16px">Se inscribió un nuevo participante en la sede <strong>${sedeNombre}</strong>.</p>
  <div style="background:#f5f5f5;padding:14px;border-radius:10px;margin:16px 0;text-align:center;border-left:4px solid #C9A84C">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px">Código asignado</div>
    <div style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#C9A84C;letter-spacing:2px;margin-top:4px">${codigoLegible}</div>
    <div style="font-family:Georgia,serif;font-size:18px;color:#222;margin-top:8px;font-weight:600">${grupo}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${nombre}</strong></td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;font-size:12px">${ins.email || ''}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px">Celular</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;font-size:12px">${ins.celular || '—'}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px">Modalidad</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${ins.modalidad || '—'}${ins.cant_personas > 1 ? ' (' + ins.cant_personas + ' personas)' : ''}</td></tr>
    <tr><td style="padding:8px 0;color:#888;font-size:12px">Monto</td><td style="padding:8px 0;text-align:right;color:#C9A84C;font-weight:700">${monto}</td></tr>
  </table>
  ${integrantes.length ? `<h4 style="font-family:Georgia,serif;color:#C9A84C;font-size:15px;margin:20px 0 10px">Integrantes</h4>
  <table style="width:100%;border-collapse:separate;border-spacing:0 4px">${integrantesRows}</table>` : ''}
  <h4 style="font-family:Georgia,serif;color:#C9A84C;font-size:15px;margin:20px 0 10px">Categorías</h4>
  <table style="width:100%;border-collapse:separate;border-spacing:0 4px">${categoriasRows}</table>
  <p style="text-align:center;margin-top:24px"><a href="${checkUrlSafe}" style="background:#C9A84C;color:#0A0A0A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Ver detalles del inscripto</a></p>
</div>
</div>`;
      mailSede = await sendMail(sedeEmail, `Nueva inscripción ${codigoLegible} — ${grupo}`, htmlSede);
    }

    return res.status(200).json({
      ok: true,
      id,
      codigo_legible: codigoLegible,
      check_url: checkUrlRaw,
      integrantes_count: integrantes.length,
      categorias_count: categorias.length,
      mail_participante: mailPart,
      mail_sede: mailSede
    });

  } catch (e) {
    return res.status(500).json({ error: 'Exception', message: e.message });
  }
};
