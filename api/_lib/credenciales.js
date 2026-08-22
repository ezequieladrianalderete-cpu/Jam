// /api/_lib/credenciales.js — JAM 2026
// Lógica de envío de credenciales individuales (QR por participante),
// compartida entre reenviar-qr.js (una inscripción) y
// enviar-credenciales-masivo.js (muchas de una) para que las dos vías
// manden exactamente el mismo mail, sin mantener dos copias.

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function sendMail({ from, to, subject, html, text, idempotencyKey }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

// "jam-inscripciones.com" nunca fue un dominio verificado en Resend (ver
// mismo comentario en reenviar-qr.js) — siempre jamcompetencia.com.
const FROM = "JAM Producciones <info@jamcompetencia.com>";

// Manda la credencial individual (QR con sub-código) a cada integrante
// con email válido, y el QR general al responsable si no quedó cubierto
// como integrante. Devuelve el detalle de a quién se le mandó y si salió
// bien, sin tirar excepción por un fallo puntual de un destinatario.
async function enviarCredencialesDeInscripcion(ins, codigo, nombreEvento, SITE, idPrefix) {
  const nombreGrupo = ins.nombre_grupo || "—";
  let integrantes = [];
  try {
    integrantes = Array.isArray(ins.integrantes)
      ? ins.integrantes
      : typeof ins.integrantes === "string"
        ? JSON.parse(ins.integrantes)
        : [];
  } catch {
    integrantes = [];
  }

  const results = [];
  const emailsIndividuales = new Set();

  for (let idx = 0; idx < integrantes.length; idx++) {
    const it = integrantes[idx] || {};
    const itEmail = (it.email || it.mail || "").trim().toLowerCase();
    if (!itEmail || !/@/.test(itEmail)) continue;
    emailsIndividuales.add(itEmail);

    const subCode = codigo + "-" + (idx + 1);
    const itNombre = it.nombre || it.name || "Integrante " + (idx + 1);
    const subCheckUrl = SITE + "/check?sub=" + encodeURIComponent(subCode);
    const subQrUrl =
      "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
      encodeURIComponent(subCheckUrl);
    const subject = "Tu credencial · " + subCode;

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;padding:32px;border-radius:8px">
  <h1 style="font-family:Georgia,serif;color:#C9A84C;font-size:24px;margin:0 0 16px">${esc(nombreEvento)}</h1>
  <h3 style="color:#333;font-size:16px;margin:0 0 12px">📨 Tu credencial individual</h3>
  <p style="color:#444;line-height:1.5">Hola <strong>${esc(itNombre)}</strong>, esta es tu credencial personal para <strong>${esc(nombreGrupo)}</strong>. Presentala el día del evento para acreditarte.</p>
  <div style="background:#f8f5ee;padding:16px;border-radius:6px;margin:16px 0">
    <p style="margin:0;color:#666;font-size:13px">Tu código:</p>
    <p style="margin:4px 0 0;font-family:monospace;font-size:22px;color:#C9A84C;font-weight:700">${esc(subCode)}</p>
  </div>
  <p style="text-align:center"><img src="${subQrUrl}" alt="QR" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" /></p>
  <p style="color:#888;font-size:12px;text-align:center;margin-top:16px;border-top:1px solid #eee;padding-top:12px">Tu QR es personal e intransferible. El staff lo escanea para acreditarte a vos, no al grupo.</p>
</div>
</body></html>`;

    const text = `${nombreEvento}
Tu credencial individual

Hola ${itNombre},
Tu código: ${subCode}
Grupo: ${nombreGrupo}

Mostrá este código el día del evento para acreditarte:
${subCheckUrl}`;

    try {
      const r = await sendMail({
        from: FROM, to: itEmail, subject, html, text,
        idempotencyKey: idPrefix + "-sub-" + (idx + 1) + "-" + Date.now(),
      });
      results.push({ to: itEmail, sub: subCode, ok: true, id: r.id });
    } catch (e) {
      results.push({ to: itEmail, sub: subCode, ok: false, error: e.message });
    }
  }

  const respEmail = (ins.email || "").trim().toLowerCase();
  if (respEmail && /@/.test(respEmail) && !emailsIndividuales.has(respEmail)) {
    const checkUrl = SITE + "/check?id=" + ins.id;
    const qrUrl =
      "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
      encodeURIComponent(checkUrl);
    const subject = "Tu QR · " + nombreEvento + " — " + codigo;
    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;padding:32px;border-radius:8px">
  <h1 style="font-family:Georgia,serif;color:#C9A84C;font-size:24px;margin:0 0 16px">${esc(nombreEvento)}</h1>
  <h3 style="color:#333;font-size:16px;margin:0 0 12px">📨 Tu QR de inscripción</h3>
  <p style="color:#444;line-height:1.5">Este es el QR de tu inscripción como responsable del grupo.</p>
  <div style="background:#f8f5ee;padding:16px;border-radius:6px;margin:16px 0">
    <p style="margin:0;color:#666;font-size:13px">Código:</p>
    <p style="margin:4px 0 12px;font-family:monospace;font-size:18px;color:#C9A84C;font-weight:700">${esc(codigo)}</p>
    <p style="margin:0;color:#666;font-size:13px">Grupo / Participante:</p>
    <p style="margin:4px 0 0;font-size:16px;font-weight:600">${esc(nombreGrupo)}</p>
  </div>
  <p style="text-align:center"><img src="${qrUrl}" alt="QR" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" /></p>
  <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Si recibiste este email por error, ignoralo. Tu código y QR siguen siendo válidos.</p>
</div>
</body></html>`;
    const text = `${nombreEvento}
Tu QR de inscripción

Código: ${codigo}
Grupo: ${nombreGrupo}

Mostrá este QR el día del evento para acreditarte:
${checkUrl}`;
    try {
      const r = await sendMail({
        from: FROM, to: respEmail, subject, html, text,
        idempotencyKey: idPrefix + "-grupo-" + Date.now(),
      });
      results.push({ to: respEmail, sub: null, ok: true, id: r.id });
    } catch (e) {
      results.push({ to: respEmail, sub: null, ok: false, error: e.message });
    }
  }

  return results;
}

module.exports = { enviarCredencialesDeInscripcion, sendMail, esc, FROM };
