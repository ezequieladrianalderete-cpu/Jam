// /api/enviar-credenciales-masivo.js — JAM 2026
// Manda la credencial individual (QR con sub-código) a TODOS los
// integrantes de un grupo de inscripciones de una sola vez, en vez de
// tener que apretar "Reenviar QR" inscripción por inscripción desde
// /admin. Pensado para asegurar que todos lleguen al evento con el QR
// correcto sin depender de un envío manual, uno por uno.
//
// Body: { instancias: ["reg","int",...], excluir_sede_ids: ["zona-sur", ...] }
// instancias es obligatorio (a propósito -- así nunca se manda "todo" por
// default sin que alguien lo haya pedido explícitamente).

export const config = { maxDuration: 300 };

import { setCors, checkRateLimit } from "./_lib/security.js";
import { enviarCredencialesDeInscripcion } from "./_lib/credenciales.js";

const INSTANCIAS_VALIDAS = ["reg", "rep", "nac", "int"];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { instancias, excluir_sede_ids } = req.body || {};
    if (!Array.isArray(instancias) || instancias.length === 0) {
      return res.status(400).json({ error: "instancias requerido (ej: ['reg','int'])" });
    }
    if (instancias.some((i) => !INSTANCIAS_VALIDAS.includes(i))) {
      return res.status(400).json({ error: "instancia inválida en la lista" });
    }
    const excluirSedes = Array.isArray(excluir_sede_ids) ? excluir_sede_ids : [];

    // Esto es una acción de administración que manda cientos de mails de
    // una sola vez -- el límite es bajo a propósito (evita un doble click
    // accidental que dispare el mismo envío dos veces), no está pensado
    // para frenar tráfico real como los otros endpoints.
    if (!(await checkRateLimit(req, "enviar-credenciales-masivo", { max: 2, ventanaSeg: 300 }))) {
      return res.status(429).json({
        error: "Ya se disparó un envío masivo hace poco — esperá unos minutos antes de repetirlo",
      });
    }

    const cfg = await cargarConfig();
    const nombreEvento = cfg.nombre_evento || "JAM 2026";
    const SITE = process.env.SITE_URL || "https://jam-inscripciones.vercel.app";

    const filtroInstancia = instancias.map((i) => `instancia.eq.${i}`).join(",");
    const rows = await supaSelect(
      "inscripciones",
      `or=(${filtroInstancia})&select=id,email,nombre_grupo,integrantes,sede_id`,
    );
    const objetivo = rows.filter(
      (r) => !(r.sede_id && excluirSedes.includes(r.sede_id)),
    );

    const resumen = [];
    let totalEnviados = 0;
    let totalIntentos = 0;

    for (const ins of objetivo) {
      let codigo = "(pendiente)";
      try {
        const lu = await supaSelect(
          "lineup",
          `inscripcion_id=eq.${ins.id}&select=codigo_id`,
          "evento",
        );
        if (lu?.[0]?.codigo_id) codigo = lu[0].codigo_id;
      } catch (e) {
        // sigue sin código -- no bloquea el envío del resto
      }

      let results = [];
      try {
        results = await enviarCredencialesDeInscripcion(
          ins, codigo, nombreEvento, SITE, "masivo-" + ins.id,
        );
      } catch (e) {
        results = [{ ok: false, error: e.message }];
      }

      const enviados = results.filter((r) => r.ok).length;
      totalEnviados += enviados;
      totalIntentos += results.length;
      resumen.push({ id: ins.id, codigo, nombre_grupo: ins.nombre_grupo, enviados, total: results.length });

      // Margen chico entre inscripciones para no saturar la API de Resend
      // en una ráfaga de cientos de mails seguidos.
      await sleep(200);
    }

    return res.status(200).json({
      ok: true,
      inscripciones_procesadas: objetivo.length,
      mails_enviados: totalEnviados,
      mails_intentados: totalIntentos,
      resumen,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
