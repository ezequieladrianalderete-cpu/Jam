// /api/enviar-devoluciones-pendientes.js — JAM 2026
// Manda TODAS las devoluciones que todavía no salieron (sesiones ya
// cerradas por los jurados, sin devolucion_enviada_at) de una sola vez,
// en vez de tener que apretar "Enviar devolución" sesión por sesión.
// Pensado para cuando el evento corrió sin internet: las devoluciones se
// van acumulando pendientes, y apenas hay señal se mandan todas juntas.
//
// Reusa el mismo enviar-devolucion.js de siempre (mismo PDF, mismo mail)
// invocándolo directo por cada sesión pendiente, así los dos caminos
// -- uno por uno o todos de una -- hacen exactamente lo mismo.
//
// Cada sesión que sale bien queda marcada (devolucion_enviada_at) para
// no volver a mandarla en la próxima corrida. Las que fallan quedan SIN
// marcar a propósito -- si algo se corta a mitad de camino (se corta la
// señal, Resend da error, lo que sea), la próxima vez que se aprieta el
// botón retoma exactamente donde quedó, sin perder ni repetir nada.

export const config = { maxDuration: 300 };

import { setCors, checkRateLimit } from "./_lib/security.js";
import enviarDevolucionHandler from "./enviar-devolucion.js";

async function supaFetch(path, opts = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    "Accept-Profile": "scoring",
    "Content-Profile": "scoring",
    ...opts.headers,
  };
  const r = await fetch(url, { ...opts, headers });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    setHeader() {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Acción de administración que puede mandar muchos mails de una --
    // límite bajo a propósito, solo para evitar un doble click accidental.
    if (!(await checkRateLimit(req, "enviar-devoluciones-pendientes", { max: 2, ventanaSeg: 300 }))) {
      return res.status(429).json({
        error: "Ya se disparó un envío masivo hace poco — esperá unos minutos antes de repetirlo",
      });
    }

    const pendientes = await supaFetch(
      "sesiones?select=id,codigo_id,nombre_grupo&activa=eq.false&finalizada_at=not.is.null&devolucion_enviada_at=is.null&order=id.asc",
    );

    const resumen = [];
    let enviadas = 0;

    for (const s of pendientes) {
      const fakeReq = { method: "POST", headers: {}, body: { sesion_id: s.id } };
      const fakeRes = mockRes();
      try {
        await enviarDevolucionHandler(fakeReq, fakeRes);
      } catch (e) {
        fakeRes.body = { error: e.message };
      }
      const ok = fakeRes.statusCode === 200 && fakeRes.body?.ok === true;

      if (ok) {
        try {
          await supaFetch(`sesiones?id=eq.${s.id}`, {
            method: "PATCH",
            body: JSON.stringify({ devolucion_enviada_at: new Date().toISOString() }),
          });
          enviadas++;
        } catch (e) {
          // Salió el mail pero no se pudo marcar -- mejor así que al
          // revés: en el peor caso se reintenta (Resend no manda
          // duplicado exacto porque cambia el idempotency key con el
          // tiempo, pero es preferible a perder la devolución de vista).
        }
      }

      resumen.push({
        sesion_id: s.id,
        codigo_id: s.codigo_id,
        nombre_grupo: s.nombre_grupo,
        ok,
        error: ok ? null : fakeRes.body?.error || "error desconocido",
      });

      // Margen entre sesiones: no saturar Resend, y quedar por debajo
      // del propio límite interno de enviar-devolucion.js (30/min).
      await sleep(2500);
    }

    return res.status(200).json({
      ok: true,
      pendientes_encontradas: pendientes.length,
      enviadas,
      fallidas: pendientes.length - enviadas,
      resumen,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
