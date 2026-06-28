// /api/notificar-pista.js — JAM 2026
// Envía email al responsable y a los integrantes cuando se pone a un participante en pista.
// Disparado automáticamente desde la función poner_en_pista del frontend.

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
    const { lineup_id } = req.body || {};
    if (!lineup_id) return res.status(400).json({ error: "lineup_id required" });

    const cfg = await cargarConfig();
    const nombreEvento = cfg.nombre_evento || "JAM 2026";

    // Traer lineup con código y nombre
    const luArr = await supaSelect("lineup", `id=eq.${lineup_id}&select=*`, "evento");
    const lu = luArr && luArr[0];
    if (!lu) return res.status(404).json({ error: "Lineup no encontrado" });

    // Si tiene inscripcion_id, traer datos del responsable + integrantes
    let ins = null;
    if (lu.inscripcion_id) {
      const insArr = await supaSelect("inscripciones", `id=eq.${lu.inscripcion_id}&select=*`);
      ins = insArr && insArr[0];
    }

    // Construir lista de destinatarios
    const destinatarios = new Set();
    if (ins?.email) destinatarios.add(ins.email.trim().toLowerCase());
    let integrantes = [];
    if (ins?.integrantes) {
      try {
        integrantes = Array.isArray(ins.integrantes) ? ins.integrantes
          : (typeof ins.integrantes === "string" ? JSON.parse(ins.integrantes) : []);
      } catch { integrantes = []; }
    }
    integrantes.forEach(it => {
      if (it?.email && /@/.test(it.email)) destinatarios.add(it.email.trim().toLowerCase());
    });

    if (destinatarios.size === 0) {
      return res.status(200).json({ ok: true, enviados: 0, total: 0, msg: "Sin emails" });
    }

    const FROM = "JAM 2026 <noreply@jam-inscripciones.com>";
    const subject = "⚡ Tu turno se acerca — " + (lu.codigo_id || "");
    const nombreGrupo = lu.nombre_grupo || ins?.nombre_grupo || "—";

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#0a0e14;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#111;padding:32px;border-radius:8px;border:2px solid #E0524C">
  <div style="text-align:center;font-size:48px;margin-bottom:12px">⚡</div>
  <h1 style="font-family:Georgia,serif;color:#E0524C;font-size:28px;margin:0 0 8px;text-align:center">¡TU TURNO SE ACERCA!</h1>
  <p style="color:#C9A84C;text-align:center;margin:0 0 24px;font-size:14px">${esc(nombreEvento)}</p>
  <div style="background:#0a1e0a;padding:20px;border-radius:8px;margin:20px 0;border:1px solid #4CAF7D">
    <p style="margin:0;color:#7DD09B;font-size:12px;text-transform:uppercase;letter-spacing:1px">Tu código</p>
    <p style="margin:6px 0 16px;font-family:monospace;font-size:24px;color:#4CAF7D;font-weight:700">${esc(lu.codigo_id || "—")}</p>
    <p style="margin:0;color:#7DD09B;font-size:12px;text-transform:uppercase;letter-spacing:1px">Grupo / Participante</p>
    <p style="margin:6px 0 0;font-size:18px;color:#F8F5EE;font-weight:600">${esc(nombreGrupo)}</p>
  </div>
  <p style="color:#F8F5EE;line-height:1.6;font-size:16px;text-align:center;margin:24px 0">
    Acabás de ser puesto en pista por el equipo organizador.<br>
    <strong style="color:#E0524C">Acercate al backstage AHORA.</strong>
  </p>
  <p style="color:#888;font-size:12px;text-align:center;margin-top:24px;border-top:1px solid #333;padding-top:16px">
    Este email es automático. Si tenés dudas, hablá con el equipo del evento.
  </p>
</div>
</body></html>`;

    const text = `${nombreEvento}
⚡ TU TURNO SE ACERCA

Código: ${lu.codigo_id || "—"}
Grupo: ${nombreGrupo}

Acabás de ser puesto en pista. Acercate al backstage AHORA.`;

    const results = [];
    for (const to of destinatarios) {
      try {
        const r = await sendMail({
          from: FROM, to, subject, html, text,
          idempotencyKey: "pista-" + lineup_id + "-" + to,
        });
        results.push({ to, ok: true, id: r.id });
      } catch (e) {
        results.push({ to, ok: false, error: e.message });
      }
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
