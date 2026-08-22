// /api/_lib/security.js — JAM 2026
// Ayudante compartido de seguridad para las funciones de /api: CORS,
// validación de IDs y rate limit, en un solo lugar en vez de duplicarlo
// en cada endpoint.

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://jam-inscripciones.vercel.app,https://jamcompetencia.com,https://www.jamcompetencia.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Refleja el origen SOLO si está en la lista permitida (configurable por
// env var ALLOWED_ORIGINS, por si se agrega un dominio nuevo) — un pedido
// desde cualquier otro sitio no recibe el header y el navegador lo
// bloquea solo, sin que haga falta chequear nada más acá.
function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

function isPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

// Rate limit por IP+ruta usando la función registrar_rate_limit en la
// base (las funciones serverless no comparten memoria entre invocaciones,
// así que el conteo tiene que guardarse en algún lado). Si el chequeo en
// sí falla (Supabase caído, etc.) NO bloquea el flujo real -- es mejor
// dejar pasar de más en un momento raro que cortarle el mail a alguien
// por un problema ajeno al rate limit.
async function checkRateLimit(req, ruta, { max = 8, ventanaSeg = 60 } = {}) {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "sin-ip";
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/registrar_rate_limit`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_clave: ruta + ":" + ip,
        p_max: max,
        p_ventana_seg: ventanaSeg,
      }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch (e) {
    return true;
  }
}

module.exports = { setCors, isUuid, isPositiveInt, checkRateLimit };
