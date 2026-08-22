// /api/reenviar-qr.js — JAM 2026
// Reenvía el QR + datos de la inscripción al responsable y todos los integrantes.
// Útil cuando hubo un reemplazo de bailarines y hay que notificar nuevos.
// La lógica real de envío vive en _lib/credenciales.js, compartida con
// enviar-credenciales-masivo.js (mismo mail, una inscripción a la vez o
// muchas de una).

import { setCors, isUuid, checkRateLimit } from "./_lib/security.js";
import { enviarCredencialesDeInscripcion } from "./_lib/credenciales.js";

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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { id } = req.body || {};
    if (!id || !isUuid(id))
      return res.status(400).json({ error: "id inválido" });

    // Más margen que notify (15/min): staff puede reenviar QR a varios
    // integrantes seguidos durante la acreditación en vivo.
    if (!(await checkRateLimit(req, "reenviar-qr", { max: 15, ventanaSeg: 60 }))) {
      return res.status(429).json({ error: "Demasiados pedidos, esperá un momento" });
    }

    const cfg = await cargarConfig();
    const nombreEvento = cfg.nombre_evento || "JAM 2026";

    const insArr = await supaSelect("inscripciones", `id=eq.${id}&select=*`);
    const ins = insArr && insArr[0];
    if (!ins) return res.status(404).json({ error: "Inscripción no encontrada" });

    const luArr = await supaSelect("lineup", `inscripcion_id=eq.${id}&select=codigo_id`, "evento");
    const codigo = (luArr && luArr[0]?.codigo_id) || "(pendiente)";

    const SITE = process.env.SITE_URL || "https://jam-inscripciones.vercel.app";

    const results = await enviarCredencialesDeInscripcion(
      ins, codigo, nombreEvento, SITE, "reenviar-" + id,
    );

    if (results.length === 0) {
      return res.status(400).json({ error: "No hay emails a quien enviar" });
    }

    return res.status(200).json({
      ok: true,
      enviados: results.filter((r) => r.ok).length,
      total: results.length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
