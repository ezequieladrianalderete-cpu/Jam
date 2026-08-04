// /api/reenviar-qr.js — JAM 2026
// Reenvía el QR + datos de la inscripción al responsable y todos los integrantes.
// Útil cuando hubo un reemplazo de bailarines y hay que notificar nuevos.

async function supaSelect(table, query, schema) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  };
  if (schema) headers["Accept-Profile"] = schema;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function cargarConfig() {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/obtener_config`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) return {};
    const data = await res.json();
    const cfg = {};
    if (Array.isArray(data)) {
      data.forEach((c) => {
        if (c.valor_json) cfg[c.clave] = c.valor_json;
        else if (c.valor != null) cfg[c.clave] = c.valor;
      });
    }
    return cfg;
  } catch { return {}; }
}

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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const cfg = await cargarConfig();
    const nombreEvento = cfg.nombre_evento || "JAM 2026";

    // Buscar inscripción
    const insArr = await supaSelect("inscripciones", `id=eq.${id}&select=*`);
    const ins = insArr && insArr[0];
    if (!ins) return res.status(404).json({ error: "Inscripción no encontrada" });

    // Buscar lineup para tener el código
    const luArr = await supaSelect("lineup", `inscripcion_id=eq.${id}&select=codigo_id,nombre_grupo`, "evento");
    // Si no hay lineup mismo continuar sin código
    const codigo = (luArr && luArr[0]?.codigo_id) || "(pendiente)";
    const nombreGrupo = ins.nombre_grupo || (luArr && luArr[0]?.nombre_grupo) || "—";

    const SITE = process.env.SITE_URL || "https://jam-inscripciones.vercel.app";

    // "jam-inscripciones.com" es el nombre viejo del proyecto (ver
    // package.json) y nunca fue un dominio verificado en Resend — Resend
    // rechaza el envío si el remitente no es de un dominio autorizado en la
    // cuenta, así que estos mails salían con error silencioso (results
    // marcaba ok:false, "0 de N enviados") mientras el resto del sistema
    // (api/notify.js, api/enviar-devolucion.js) sí manda bien porque usa
    // jamcompetencia.com.
    const FROM = "JAM Producciones <info@jamcompetencia.com>";

    let integrantes = [];
    try {
      integrantes = Array.isArray(ins.integrantes) ? ins.integrantes
        : (typeof ins.integrantes === "string" ? JSON.parse(ins.integrantes) : []);
    } catch { integrantes = []; }

    const results = [];
    const emailsIndividuales = new Set();

    // ANTES este endpoint mandaba el MISMO QR de grupo (código base, sin
    // sub-código) a todos los emails — responsable e integrantes por
    // igual. Eso rompe el propósito real del botón ("hubo un reemplazo de
    // bailarines y hay que notificar nuevos"): la persona nueva recibía un
    // QR que no la identifica ni dice en qué grupo está, idéntico al que
    // tendría cualquier otro integrante. Cada integrante necesita SU
    // PROPIO sub-código (ej. JAM-REG-0114-1) — el mismo esquema que ya usa
    // el mail de confirmación original (api/notify.js) y que check.html ya
    // sabe mostrar (/check?sub=...).
    for (let idx = 0; idx < integrantes.length; idx++) {
      const it = integrantes[idx] || {};
      const itEmail = (it.email || it.mail || "").trim().toLowerCase();
      if (!itEmail || !/@/.test(itEmail)) continue;
      emailsIndividuales.add(itEmail);

      const subCode = codigo + "-" + (idx + 1);
      const itNombre = it.nombre || it.name || "Integrante " + (idx + 1);
      const subCheckUrl = SITE + "/check?sub=" + encodeURIComponent(subCode);
      const subQrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(subCheckUrl);
      const subject = "Tu credencial actualizada · " + subCode;

      const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;padding:32px;border-radius:8px">
  <h1 style="font-family:Georgia,serif;color:#C9A84C;font-size:24px;margin:0 0 16px">${esc(nombreEvento)}</h1>
  <h3 style="color:#333;font-size:16px;margin:0 0 12px">📨 Credencial actualizada</h3>
  <p style="color:#444;line-height:1.5">Hola <strong>${esc(itNombre)}</strong>, te reenviamos tu credencial personal para <strong>${esc(nombreGrupo)}</strong>.</p>
  <div style="background:#f8f5ee;padding:16px;border-radius:6px;margin:16px 0">
    <p style="margin:0;color:#666;font-size:13px">Tu código:</p>
    <p style="margin:4px 0 0;font-family:monospace;font-size:22px;color:#C9A84C;font-weight:700">${esc(subCode)}</p>
  </div>
  <p style="text-align:center"><img src="${subQrUrl}" alt="QR" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" /></p>
  <p style="color:#888;font-size:12px;text-align:center;margin-top:16px;border-top:1px solid #eee;padding-top:12px">Tu QR es personal e intransferible. El staff lo escanea para acreditarte a vos, no al grupo.</p>
</div>
</body></html>`;

      const text = `${nombreEvento}
Credencial actualizada

Hola ${itNombre},
Tu código: ${subCode}
Grupo: ${nombreGrupo}

Mostrá este código el día del evento para acreditarte:
${subCheckUrl}`;

      try {
        const r = await sendMail({
          from: FROM, to: itEmail, subject, html, text,
          idempotencyKey: "reenviar-sub-" + id + "-" + (idx + 1) + "-" + Date.now(),
        });
        results.push({ to: itEmail, sub: subCode, ok: true, id: r.id });
      } catch (e) {
        results.push({ to: itEmail, sub: subCode, ok: false, error: e.message });
      }
    }

    // El responsable de la inscripción (si su email de cuenta no quedó ya
    // cubierto arriba como uno de los integrantes) sigue recibiendo el QR
    // general del grupo — sigue siendo válido para acreditar la
    // inscripción completa, no a una persona puntual.
    const respEmail = (ins.email || "").trim().toLowerCase();
    if (respEmail && /@/.test(respEmail) && !emailsIndividuales.has(respEmail)) {
      const checkUrl = SITE + "/check?id=" + ins.id;
      const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(checkUrl);
      const subject = "Tu QR actualizado · " + nombreEvento + " — " + codigo;
      const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;padding:32px;border-radius:8px">
  <h1 style="font-family:Georgia,serif;color:#C9A84C;font-size:24px;margin:0 0 16px">${esc(nombreEvento)}</h1>
  <h3 style="color:#333;font-size:16px;margin:0 0 12px">📨 QR reenviado</h3>
  <p style="color:#444;line-height:1.5">Te reenviamos el QR de tu inscripción como responsable del grupo.</p>
  <div style="background:#f8f5ee;padding:16px;border-radius:6px;margin:16px 0">
    <p style="margin:0;color:#666;font-size:13px">Código:</p>
    <p style="margin:4px 0 12px;font-family:monospace;font-size:18px;color:#C9A84C;font-weight:700">${esc(codigo)}</p>
    <p style="margin:0;color:#666;font-size:13px">Grupo / Participante:</p>
    <p style="margin:4px 0 0;font-size:16px;font-weight:600">${esc(nombreGrupo)}</p>
  </div>
  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Tu código QR</h3>
  <p style="text-align:center"><img src="${qrUrl}" alt="QR" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" /></p>
  <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Si recibiste este email por error, ignoralo. Tu código y QR siguen siendo válidos.</p>
</div>
</body></html>`;
      const text = `${nombreEvento}
QR reenviado

Código: ${codigo}
Grupo: ${nombreGrupo}

Mostrá este QR el día del evento para acreditarte:
${checkUrl}`;
      try {
        const r = await sendMail({
          from: FROM, to: respEmail, subject, html, text,
          idempotencyKey: "reenviar-grupo-" + id + "-" + Date.now(),
        });
        results.push({ to: respEmail, sub: null, ok: true, id: r.id });
      } catch (e) {
        results.push({ to: respEmail, sub: null, ok: false, error: e.message });
      }
    }

    if (results.length === 0) {
      return res.status(400).json({ error: "No hay emails a quien enviar" });
    }

    return res.status(200).json({
      ok: true,
      enviados: results.filter(r => r.ok).length,
      total: results.length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
