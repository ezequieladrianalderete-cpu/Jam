// /api/notify.js — JAM 2026 v17
// FIX: sin SDKs (fetch directo) + sin monto en mails
// - Compatible con Node 20+ (no usa @supabase/supabase-js con WebSocket)
// - Mail al participante / sede / admin (info@jamcompetencia.com) SIEMPRE
// - NO incluye monto en los mails (el participante lo calcula según tabla)

const SENDER = "JAM Producciones <info@jamcompetencia.com>";
const ADMIN_EMAIL = "info@jamcompetencia.com";

const INSTANCIA_CFG = {
  reg: { label: "Sedes", code: "JAM-REG", offset: 1 },
  rep: { label: "Repechaje", code: "JAM-REP", offset: 10 },
  nac: { label: "Final Nacional", code: "JAM-NAC", offset: 200 },
  int: { label: "Final Inter América", code: "JAM-INTER", offset: 1000 },
};

const PAGO_VIAMONTE = {
  alias: "VIAMONTE2600",
  cbu: "000000310009572128629",
  titular: "Liliana Naomi Tanabe",
};

const PAGO_PREX = {
  plataforma: "Prex",
  cuenta: "35722990",
  titular: "Nelson Gastón Vidarte",
};

// Días de margen para subir la música sin recargo (instancia Sedes),
// contados desde el momento de la inscripción. Solo se usa si
// MUSICA_VENCIMIENTO_ACTIVO está en true.
const PLAZO_MUSICA_DIAS = 10;

// Por ahora Sedes NO tiene plazo límite para subir la música (decisión de
// negocio, sin fecha definida). Toda la lógica de vencimiento/recargo queda
// implementada y lista: para reactivarla en el futuro alcanza con poner
// esto en `true` (no hace falta tocar musica.html ni admin.html).
const MUSICA_VENCIMIENTO_ACTIVO = false;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// === Supabase REST API helper (sin SDK) ===
async function supaSelect(table, query) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok)
    throw new Error(`Supabase ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supaPatch(table, query, body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`Supabase PATCH ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

// === Cargar configuración dinámica desde evento.config ===
// Devuelve un objeto con todas las claves. Si alguna no existe, no incluye esa key.
// Resiliente: si falla la llamada (Supabase down), devuelve {} y el sistema usa defaults.
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
  } catch (e) {
    return {};
  }
}

// === Resend HTTP API (sin SDK) ===
async function sendMail({ from, to, subject, html, text, idempotencyKey }) {
  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.message || `HTTP ${res.status}`,
      status: res.status,
    };
  }
  return { ok: true, id: data.id };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    // 0) Cargar config dinámica (nombres, textos email, etc.) - no crítica, sigue si falla
    const eventoCfg = await cargarConfig();
    const nombreEvento = eventoCfg.nombre_evento || "JAM 2026";
    const edicionEvento = eventoCfg.edicion || (String(nombreEvento).match(/\d{4}/) || ["2026"])[0];
    const emailT = eventoCfg.email_templates || {};
    // Datos bancarios: si están configurados en panel, sobreescriben los hardcoded
    const bankV2 = eventoCfg.datos_bancarios_v2 || {};
    const bankCfg = eventoCfg.datos_bancarios || {};
    let datosBancarios = {
      alias: bankCfg.alias || PAGO_VIAMONTE.alias,
      cbu: bankCfg.cbu || PAGO_VIAMONTE.cbu,
      titular: bankCfg.titular || PAGO_VIAMONTE.titular,
      banco: bankCfg.banco || "",
      mp_link: bankCfg.mp_link || "",
      mp_alias: bankCfg.mp_alias || "",
    };
    let prexData = {
      plataforma: PAGO_PREX.plataforma,
      cuenta: (bankV2.internacional && bankV2.internacional.cuenta) || PAGO_PREX.cuenta,
      titular: (bankV2.internacional && bankV2.internacional.titular) || PAGO_PREX.titular,
      alias: (bankV2.internacional && bankV2.internacional.alias) || "",
      cbu: (bankV2.internacional && bankV2.internacional.cbu) || "",
    };

    // 1) Buscar inscripción
    const insArr = await supaSelect("inscripciones", `id=eq.${id}&select=*`);
    const ins = insArr && insArr[0];
    // Resolver datos bancarios nacionales/repesca desde config v2 (si existen)
    if (ins && ins.instancia !== "int" && bankV2.nacional && bankV2.nacional.alias) {
      datosBancarios = {
        alias: bankV2.nacional.alias,
        cbu: bankV2.nacional.cbu,
        titular: bankV2.nacional.titular,
        banco: datosBancarios.banco,
        mp_link: datosBancarios.mp_link,
        mp_alias: datosBancarios.mp_alias,
      };
    }
    if (!ins)
      return res.status(404).json({ error: "Inscripción no encontrada" });

    // 2) Calcular código (instancia + offset + posición)
    const cfg = INSTANCIA_CFG[ins.instancia] || INSTANCIA_CFG.reg;
    const allInst = await supaSelect(
      "inscripciones",
      `instancia=eq.${ins.instancia}&select=id,created_at&order=created_at.asc`,
    );
    let pos = 1;
    if (Array.isArray(allInst)) {
      const idx = allInst.findIndex((x) => x.id === ins.id);
      pos = idx >= 0 ? idx + 1 : 1;
    }
    const num = String(cfg.offset + (Math.max(pos, 1) - 1)).padStart(4, "0");
    const codigo_legible = cfg.code + "-" + num;

    // 3) Parse integrantes y categorías
    let integrantes = [];
    try {
      const raw = ins.integrantes;
      if (raw) integrantes = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {}
    if (!Array.isArray(integrantes)) integrantes = [];

    let categorias = [];
    try {
      const raw = ins.categorias;
      if (raw) categorias = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {}
    if (!Array.isArray(categorias)) categorias = [];

    const nombre_grupo = ins.nombre_grupo || ins.nombre || "Participante";
    const fecha = ins.created_at
      ? new Date(ins.created_at).toLocaleString("es-AR", {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "—";

    // === HTML INTEGRANTES ===
    const intHtml = integrantes.length
      ? integrantes
          .map((it, idx) => {
            const subCode = codigo_legible + "-" + (idx + 1);
            const nm =
              (it && (it.nombre || it.name)) || "Integrante " + (idx + 1);
            return (
              '<tr><td style="padding:10px 12px;background:#1a1600;border-left:3px solid #C9A84C">' +
              "<div style=\"font-family:'Courier New',monospace;font-size:12px;color:#C9A84C;letter-spacing:1px;font-weight:600;margin-bottom:3px\">" +
              esc(subCode) +
              "</div>" +
              '<div style="font-family:Georgia,serif;font-size:16px;color:#F8F5EE;font-weight:600">' +
              esc(nm) +
              "</div>" +
              '<div style="font-size:11px;color:#888;margin-top:2px">' +
              esc(nombre_grupo) +
              "</div>" +
              "</td></tr>"
            );
          })
          .join("")
      : "";

    // === HTML CATEGORÍAS ===
    const catHtml = categorias.length
      ? categorias
          .map((c) => {
            const n = c.c != null ? "N° " + c.c : "";
            const g = c.g ? " · " + String(c.g).toUpperCase() : "";
            const nm = c.n || c.nombre || "Categoría";
            return (
              '<tr><td style="padding:10px 12px;background:#1a1600;border-left:3px solid #C9A84C">' +
              "<div style=\"font-family:'Courier New',monospace;font-size:11px;color:#C9A84C;margin-bottom:3px;font-weight:600\">" +
              esc(n + g) +
              "</div>" +
              '<div style="font-family:Georgia,serif;font-size:16px;color:#F8F5EE;font-weight:600">' +
              esc(nm) +
              "</div>" +
              "</td></tr>"
            );
          })
          .join("")
      : "";

    // === BLOQUE DE PAGO ===
    const isInter = ins.instancia === "int";
    const includePago = ins.instancia !== "reg";
    const pagoHtml = !includePago
      ? ""
      : isInter
        ? `
<div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0">
  <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:14px;text-align:center">Datos para pagar · Inter América</div>
  <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
    <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Plataforma</div>
    <div style="font-family:Georgia,serif;font-size:22px;color:#F8F5EE;font-weight:700">${prexData.plataforma}</div>
  </div>
  <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
    <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Cuenta / Alias Prex</div>
    <div style="font-family:'Courier New',monospace;font-size:14px;color:#E8A838">${prexData.cuenta}</div>
  </div>
  <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px">
    <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Titular</div>
    <div style="font-family:Georgia,serif;font-size:15px;color:#E8A838">${prexData.titular}</div>
  </div>
  <div style="font-size:12px;color:rgba(248,245,238,.6);text-align:center;margin-top:14px;line-height:1.5">El total se calcula según la tabla publicada en el portal. Podés pagar la totalidad o el 50% como seña.</div>
</div>`
        : `
<div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0">
  <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:14px;text-align:center">Datos para pagar (transferencia)</div>
  <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
    <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Alias</div>
    <div style="font-family:'Courier New',monospace;font-size:18px;color:#F8F5EE;font-weight:700">${datosBancarios.alias}</div>
  </div>
  <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
    <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">CBU</div>
    <div style="font-family:'Courier New',monospace;font-size:14px;color:#F8F5EE">${datosBancarios.cbu}</div>
  </div>
  <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px">
    <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Titular</div>
    <div style="font-family:Georgia,serif;font-size:15px;color:#F8F5EE">${datosBancarios.titular}</div>
  </div>
  <div style="font-size:12px;color:rgba(248,245,238,.6);text-align:center;margin-top:14px;line-height:1.5">El total se calcula según la tabla publicada en el portal. Podés pagar la totalidad o el 50% como seña.</div>
</div>`;

    const SITE = process.env.SITE_URL || "https://jam-inscripciones.vercel.app";
    const checkUrl = SITE + "/check?id=" + ins.id;
    const qrUrl =
      "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
      encodeURIComponent(checkUrl);
    const subj = (emailT.asunto_inscripcion || ("Inscripción " + nombreEvento + " confirmada")) + " — " + codigo_legible;

    // === MÚSICA: link de carga, SOLO para Sedes virtuales sin música cargada ===
    // Nacional/Repesca/Inter la cargan obligatoria al inscribirse y nunca ven
    // este bloque. Sedes presenciales tampoco. Si la sede virtual ya tiene
    // música cargada, tampoco se muestra nada: el reemplazo lo maneja el
    // negocio directamente, no es self-service.
    let musicaHtml = "";
    let musicaText = "";
    const esSedeVirtual =
      ins.instancia === "reg" &&
      typeof ins.sede_nombre === "string" &&
      /virtual/i.test(ins.sede_nombre);

    if (esSedeVirtual && ins.musica_estado !== "cargada") {
      if (!ins.musica_token) {
        console.warn(
          `Inscripción ${ins.id} sin musica_token (revisar columna/default en Supabase)`,
        );
      } else {
        const musicaUrl = SITE + "/musica?token=" + ins.musica_token;

        if (MUSICA_VENCIMIENTO_ACTIVO) {
          let vencimientoMusica = ins.vencimiento_musica;
          if (!vencimientoMusica) {
            vencimientoMusica = new Date(
              Date.now() + PLAZO_MUSICA_DIAS * 24 * 60 * 60 * 1000,
            ).toISOString();
            try {
              await supaPatch("inscripciones", `id=eq.${ins.id}`, {
                vencimiento_musica: vencimientoMusica,
              });
            } catch (e) {
              console.warn(
                "No se pudo guardar vencimiento_musica:",
                e.message,
              );
            }
          }
          const vencFecha = new Date(vencimientoMusica).toLocaleDateString(
            "es-AR",
            { day: "numeric", month: "long", year: "numeric" },
          );
          musicaHtml = `
<div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0;text-align:center">
  <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:10px">Subí tu música</div>
  <p style="color:rgba(248,245,238,.7);font-size:13px;margin:0 0 16px;line-height:1.5">Todavía no cargaste la pista de tu presentación. Tenés hasta el <strong style="color:#F8F5EE">${esc(vencFecha)}</strong> para subirla sin cargo extra. Pasada esa fecha podés subirla igual, pero se te va a cobrar un recargo aparte.</p>
  <a href="${musicaUrl}" style="background:#C9A84C;color:#0A0A0A;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;display:inline-block">Subir mi música →</a>
</div>`;
          musicaText =
            "\n\nSUBÍ TU MÚSICA\nTodavía no cargaste la pista. Tenés hasta el " +
            vencFecha +
            " para subirla sin cargo extra (pasada esa fecha se puede subir igual, con recargo aparte).\n" +
            musicaUrl;
        } else {
          musicaHtml = `
<div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0;text-align:center">
  <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:10px">Subí tu música</div>
  <p style="color:rgba(248,245,238,.7);font-size:13px;margin:0 0 16px;line-height:1.5">Todavía no cargaste la pista de tu presentación. Podés subirla cuando quieras desde este link.</p>
  <a href="${musicaUrl}" style="background:#C9A84C;color:#0A0A0A;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;display:inline-block">Subir mi música →</a>
</div>`;
          musicaText =
            "\n\nSUBÍ TU MÚSICA\nTodavía no cargaste la pista. Podés subirla cuando quieras desde este link:\n" +
            musicaUrl;
        }
      }
    }

    // === HTML MAIL PARTICIPANTE (SIN MONTO) ===
    const htmlParticipante = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">
<div style="background:#0A0A0A;padding:28px 24px;text-align:center">
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:42px;font-weight:700;letter-spacing:6px;color:#C9A84C;margin-bottom:6px">JAM</div>
  <div style="font-size:11px;color:rgba(248,245,238,.5);letter-spacing:2px;text-transform:uppercase">Inscripción confirmada · 2026</div>
</div>
<div style="background:linear-gradient(135deg,#111,#1a1800);padding:26px 24px;text-align:center;border-bottom:3px solid #C9A84C">
  <div style="font-size:10px;letter-spacing:3px;color:rgba(201,168,76,.6);text-transform:uppercase;font-weight:700;margin-bottom:10px">Tu código de inscripción</div>
  <div style="font-family:'Courier New',monospace;font-size:26px;color:#C9A84C;letter-spacing:3px;font-weight:600">${esc(codigo_legible)}</div>
  <div style="font-family:Georgia,serif;font-size:24px;color:#F8F5EE;font-weight:600;margin-top:14px">${esc(nombre_grupo)}</div>
  <div style="color:rgba(248,245,238,.5);font-size:12px;margin-top:4px">${esc(cfg.label)} · ${esc(ins.pais || "Argentina")}${ins.sede_nombre ? " · Sede " + esc(ins.sede_nombre) : ""}</div>
</div>
<div style="padding:24px">
  <p style="margin:0 0 16px;color:#444">${emailT.saludo_inscripcion ? esc(emailT.saludo_inscripcion) + " " : ""}Hola <strong>${esc(ins.nombre || nombre_grupo)}</strong>, tu inscripción a <strong>${esc(cfg.label)}</strong> fue recibida correctamente.</p>
  ${integrantes.length ? '<h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Integrantes (' + integrantes.length + ')</h3><table style="width:100%;border-collapse:separate;border-spacing:0 6px;margin-bottom:20px">' + intHtml + "</table>" : ""}
  ${categorias.length ? '<h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Categorías (' + categorias.length + ')</h3><table style="width:100%;border-collapse:separate;border-spacing:0 6px;margin-bottom:20px">' + catHtml + "</table>" : ""}
  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Datos</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${esc(ins.nombre)}</strong></td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Modalidad</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${esc(ins.modalidad || "—")}</strong> <span style="color:#888;font-size:12px">(${ins.cant_personas || 1} pers.)</span></td></tr>
    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Fecha</td><td style="padding:8px 0;text-align:right">${esc(fecha)}</td></tr>
  </table>
  ${musicaHtml}
  ${pagoHtml}
  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Tu código QR</h3>
  <p style="text-align:center"><img src="${qrUrl}" alt="QR" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" /></p>
  <p style="text-align:center;color:#888;font-size:12px">Escanealo para acceder a todos tus datos online</p>
  <p style="margin:24px 0 0;text-align:center"><a href="${checkUrl}" style="color:#C9A84C;text-decoration:underline;font-size:13px">Ver mi inscripción online →</a></p>
</div>
<div style="background:#0A0A0A;padding:18px;text-align:center;color:rgba(248,245,238,.4);font-size:11px;line-height:1.7">
  <strong style="color:rgba(248,245,238,.6)">JAM Inter América Dance Competition 2026</strong><br>
  2, 3 y 4 de Octubre · Palais Rouge, CABA<br>Jerónimo Salguero 1441
</div>
</div>`;

    // === TEXT MAIL PARTICIPANTE ===
    const intText = integrantes.length
      ? "\n\nINTEGRANTES (" +
        integrantes.length +
        ")\n" +
        integrantes
          .map(
            (it, idx) =>
              codigo_legible +
              "-" +
              (idx + 1) +
              "\n" +
              ((it && (it.nombre || it.name)) || "Integrante " + (idx + 1)) +
              "\n" +
              nombre_grupo,
          )
          .join("\n\n")
      : "";
    const catText = categorias.length
      ? "\n\nCATEGORÍAS (" +
        categorias.length +
        ")\n" +
        categorias
          .map(
            (c) =>
              "N° " +
              (c.c || "?") +
              " · " +
              (c.g || "").toUpperCase() +
              "\n" +
              (c.n || c.nombre || "Categoría"),
          )
          .join("\n")
      : "";
    const pagoText = !includePago
      ? ""
      : isInter
        ? "\n\nDatos para pagar · Inter América\nPlataforma: " +
          prexData.plataforma +
          "\nCuenta/Alias Prex: " +
          prexData.cuenta +
          "\nTitular: " +
          prexData.titular +
          "\n(El total se calcula según la tabla del portal. Podés pagar total o 50% seña.)"
        : "\n\nDatos para pagar (transferencia)\nAlias: " +
          datosBancarios.alias +
          "\nCBU: " +
          datosBancarios.cbu +
          "\nTitular: " +
          datosBancarios.titular +
          "\n(El total se calcula según la tabla del portal. Podés pagar total o 50% seña.)";
    const textParticipante =
      nombreEvento + "\nInscripción confirmada\nCódigo: " +
      codigo_legible +
      "\n" +
      nombre_grupo +
      "\n" +
      cfg.label +
      intText +
      catText +
      "\n\nResponsable: " +
      ins.nombre +
      musicaText +
      pagoText +
      "\n\nVer: " +
      checkUrl;

    // === ENVIAR MAIL AL PARTICIPANTE ===
    const mail_participante = await sendMail({
      from: SENDER,
      to: ins.email,
      subject: subj,
      html: htmlParticipante,
      text: textParticipante,
      idempotencyKey: `${ins.id}-participant`,
    });

    // === MAILS INDIVIDUALES POR INTEGRANTE (con su QR propio) ===
    // Cada integrante con email recibe su credencial individual (sub-código).
    // El QR apunta a /check?sub=<sub_codigo> para acreditación por persona.
    // No bloquea el flujo: si uno falla, sigue con los demás.
    const mails_integrantes = [];
    try {
      if (Array.isArray(integrantes) && integrantes.length > 0) {
        const respEmail = (ins.email || "").trim().toLowerCase();
        for (let idx = 0; idx < integrantes.length; idx++) {
          const it = integrantes[idx] || {};
          const itEmail = (it.email || it.mail || "").trim();
          // Solo mandar si tiene email válido
          if (!itEmail || !/@/.test(itEmail)) continue;
          const subCode = codigo_legible + "-" + (idx + 1);
          const itNombre = it.nombre || it.name || "Integrante " + (idx + 1);
          const subCheckUrl = SITE + "/check?sub=" + encodeURIComponent(subCode);
          const subQrUrl =
            "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
            encodeURIComponent(subCheckUrl);
          const htmlInt = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">
<div style="background:#0A0A0A;padding:28px 24px;text-align:center">
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:42px;font-weight:700;letter-spacing:6px;color:#C9A84C;margin-bottom:6px">JAM</div>
  <div style="font-size:11px;color:rgba(248,245,238,.5);letter-spacing:2px;text-transform:uppercase">Credencial individual · ${esc(edicionEvento)}</div>
</div>
<div style="padding:28px 24px;text-align:center">
  <p style="font-size:15px;color:#444;margin:0 0 6px">Hola <strong>${esc(itNombre)}</strong>,</p>
  <p style="font-size:14px;color:#666;margin:0 0 20px;line-height:1.5">Esta es tu credencial personal para <strong>${esc(nombre_grupo)}</strong>. Presentala el día del evento para acreditarte.</p>
  <div style="font-family:'Courier New',monospace;font-size:24px;color:#C9A84C;letter-spacing:3px;font-weight:600;margin-bottom:16px">${esc(subCode)}</div>
  <img src="${subQrUrl}" alt="QR ${esc(subCode)}" style="border:6px solid #fff;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)" />
  <p style="font-size:12px;color:#999;margin-top:20px;line-height:1.5">Tu QR es personal e intransferible. El staff lo escanea para acreditarte a vos, no al grupo.</p>
</div>
<div style="background:#0A0A0A;padding:16px;text-align:center;color:rgba(248,245,238,.4);font-size:11px">
  <strong style="color:rgba(248,245,238,.6)">JAM Dance Competition ${esc(edicionEvento)}</strong>
</div>
</div>`;
          const textInt =
            "JAM " + edicionEvento + "\nCredencial individual\n\n" +
            "Hola " + itNombre + ",\nTu código: " + subCode +
            "\nGrupo: " + nombre_grupo +
            "\n\nMostrá este código el día del evento para acreditarte:\n" + subCheckUrl;
          try {
            const r = await sendMail({
              from: SENDER,
              to: itEmail,
              subject: "Tu credencial · " + subCode,
              html: htmlInt,
              text: textInt,
              idempotencyKey: `${ins.id}-int-${idx + 1}`,
            });
            mails_integrantes.push({ sub: subCode, to: itEmail, ok: true, id: r?.id });
          } catch (e) {
            mails_integrantes.push({ sub: subCode, to: itEmail, ok: false, error: e.message });
          }
        }
      }
    } catch (e) {
      // no interrumpir el flujo principal
    }

    // === MAIL A LA SEDE (solo REG) ===
    let mail_sede = null;
    if (ins.instancia === "reg" && ins.sede_email_org) {
      const sedeHtml =
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">' +
        '<div style="background:#0A0A0A;padding:24px;text-align:center"><div style="font-family:Georgia,serif;font-size:36px;color:#C9A84C;letter-spacing:6px;font-weight:700">JAM</div><div style="color:rgba(248,245,238,.5);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:4px">Nueva inscripción en tu sede</div></div>' +
        '<div style="padding:24px"><p>Se inscribió un nuevo participante en la sede <strong>' +
        esc(ins.sede_nombre || "—") +
        "</strong>.</p>" +
        '<table style="width:100%;border-collapse:collapse;margin-top:16px">' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Código</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;color:#C9A84C;font-weight:700">' +
        esc(codigo_legible) +
        "</td></tr>" +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>' +
        esc(ins.nombre) +
        "</strong></td></tr>" +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
        esc(ins.email) +
        "</td></tr>" +
        '<tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase">Categorías</td><td style="padding:8px 0;text-align:right">' +
        categorias.length +
        "</td></tr>" +
        "</table>" +
        '<p style="margin-top:20px;text-align:center"><a href="' +
        checkUrl +
        '" style="background:#C9A84C;color:#0A0A0A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Ver →</a></p>' +
        "</div></div>";
      mail_sede = await sendMail({
        from: SENDER,
        to: ins.sede_email_org,
        subject: "Nueva inscripción " + codigo_legible + " — " + nombre_grupo,
        html: sedeHtml,
        idempotencyKey: `${ins.id}-sede`,
        text:
          "Nueva inscripción en sede " +
          (ins.sede_nombre || "") +
          "\nCódigo: " +
          codigo_legible +
          "\nResponsable: " +
          ins.nombre +
          "\nEmail: " +
          ins.email +
          "\nCategorías: " +
          categorias.length +
          "\nVer: " +
          checkUrl,
      });
    }

    // === MAIL AL ADMIN (info@jamcompetencia.com) - SIEMPRE ===
    const adminHtml =
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">' +
      '<div style="background:#0A0A0A;padding:24px;text-align:center"><div style="font-family:Georgia,serif;font-size:36px;color:#C9A84C;letter-spacing:6px;font-weight:700">JAM</div><div style="color:rgba(248,245,238,.5);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:4px">Panel director · Nueva inscripción</div></div>' +
      '<div style="padding:24px">' +
      '<p style="margin:0 0 14px"><strong style="color:#C9A84C">Nueva inscripción registrada</strong></p>' +
      '<table style="width:100%;border-collapse:collapse">' +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Instancia</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>' +
      esc(cfg.label) +
      "</strong></td></tr>" +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Código</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;color:#C9A84C;font-weight:700">' +
      esc(codigo_legible) +
      "</td></tr>" +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Nombre/Grupo</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>' +
      esc(nombre_grupo) +
      "</strong></td></tr>" +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
      esc(ins.nombre) +
      "</td></tr>" +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
      esc(ins.email) +
      "</td></tr>" +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Celular</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
      esc(ins.celular || "—") +
      "</td></tr>" +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">País</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
      esc(ins.pais || "—") +
      "</td></tr>" +
      (ins.sede_nombre
        ? '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Sede</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
          esc(ins.sede_nombre) +
          "</td></tr>"
        : "") +
      '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Modalidad</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' +
      esc(ins.modalidad || "—") +
      " (" +
      (ins.cant_personas || 1) +
      " pers.)</td></tr>" +
      '<tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase">Categorías</td><td style="padding:8px 0;text-align:right">' +
      categorias.length +
      "</td></tr>" +
      "</table>" +
      '<p style="margin-top:24px;text-align:center"><a href="' +
      checkUrl +
      '" style="background:#C9A84C;color:#0A0A0A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Ver →</a> &nbsp; <a href="' +
      SITE +
      '/admin" style="background:transparent;color:#C9A84C;border:1px solid #C9A84C;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Admin →</a></p>' +
      "</div></div>";
    const adminText =
      "JAM · Nueva inscripción\nInstancia: " +
      cfg.label +
      "\nCódigo: " +
      codigo_legible +
      "\nNombre: " +
      nombre_grupo +
      "\nResponsable: " +
      ins.nombre +
      "\nEmail: " +
      ins.email +
      "\nCelular: " +
      (ins.celular || "—") +
      "\nPaís: " +
      (ins.pais || "—") +
      (ins.sede_nombre ? "\nSede: " + ins.sede_nombre : "") +
      "\nModalidad: " +
      (ins.modalidad || "—") +
      " (" +
      (ins.cant_personas || 1) +
      " pers.)" +
      "\nCategorías: " +
      categorias.length +
      "\n\nVer: " +
      checkUrl +
      "\nAdmin: " +
      SITE +
      "/admin";

    const mail_admin = await sendMail({
      from: SENDER,
      to: ADMIN_EMAIL,
      idempotencyKey: `${ins.id}-admin`,
      subject:
        "[Admin JAM] Nueva inscripción " +
        codigo_legible +
        " — " +
        nombre_grupo,
      html: adminHtml,
      text: adminText,
    });

    return res.status(200).json({
      ok: true,
      id: ins.id,
      codigo_legible,
      instancia: ins.instancia,
      integrantes_count: integrantes.length,
      categorias_count: categorias.length,
      mail_participante,
      mail_sede,
      mail_admin,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Internal error" });
  }
}
