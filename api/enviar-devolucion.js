// /api/enviar-devolucion.js — JAM 2026
// Envía devolución por email al participante después de ser evaluado
// Incluye: puntajes por jurado, audio de evaluación, certificado

const SENDER = "JAM Producciones <info@jamcompetencia.com>";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// sesion.categoria guarda un solo objeto de categoría (una sesión = una categoría),
// pero sesiones viejas pueden traer un array combinado — se soportan ambos formatos.
function formatCategoria(raw) {
  if (!raw) return "";
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v))
      return v.map((item) => `${item.c}: ${item.n}`).join(" - ");
    if (v && typeof v === "object") return `${v.c}: ${v.n}`;
    return "";
  } catch (e) {
    return "";
  }
}

async function supaFetch(path, opts = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  try {
    const { sesion_id } = req.body;
    if (!sesion_id)
      return res.status(400).json({ error: "sesion_id requerido" });

    // 0. Cargar plantillas de email personalizables (con fallback si falla)
    let mailT = {};
    try {
      const cfgRows = await supaFetch(
        `config?clave=eq.email_templates&select=valor_json`,
        { headers: { "Accept-Profile": "evento" } },
      );
      mailT = cfgRows?.[0]?.valor_json || {};
    } catch (e) {
      mailT = {}; // si falla, se usan los textos por defecto de siempre
    }

    // 1. Obtener sesión
    const sesiones = await supaFetch(`sesiones?id=eq.${sesion_id}&select=*`, {
      headers: { "Accept-Profile": "scoring" },
    });
    const sesion = sesiones[0];
    if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" });

    // 2. Obtener puntajes de todos los jurados
    const puntajes = await supaFetch(
      `puntajes?sesion_id=eq.${sesion_id}&select=*&order=juez_num`,
      { headers: { "Accept-Profile": "scoring" } },
    );

    // 3. Buscar email del participante (via lineup → inscripciones)
    const lineup = await supaFetch(
      `lineup?codigo_id=eq.${sesion.codigo_id}&select=inscripcion_id`,
      { headers: { "Accept-Profile": "evento" } },
    );
    const inscId = lineup[0]?.inscripcion_id;
    let email = null;
    let nombreResp = null;
    let integrantesDev = [];
    if (inscId) {
      const inscrip = await supaFetch(
        `inscripciones?id=eq.${inscId}&select=email,nombre,integrantes`,
      );
      email = inscrip[0]?.email;
      nombreResp = inscrip[0]?.nombre;
      // Integrantes del grupo (para mandar la devolución a todos)
      try {
        const raw = inscrip[0]?.integrantes;
        integrantesDev = Array.isArray(raw)
          ? raw
          : typeof raw === "string"
            ? JSON.parse(raw)
            : [];
      } catch {
        integrantesDev = [];
      }
    }
    if (!email)
      return res
        .status(404)
        .json({ error: "Email del participante no encontrado" });

    // Lista de destinatarios: titular + cada integrante con email válido (sin duplicar)
    const destinatariosDev = new Set();
    if (email) destinatariosDev.add(email.trim().toLowerCase());
    integrantesDev.forEach((it) => {
      const e = (it?.email || it?.mail || "").trim().toLowerCase();
      if (e && /@/.test(e)) destinatariosDev.add(e);
    });

    // 4. Obtener nombres de ítems de cada jurado
    const juradoNums = puntajes.map((p) => p.juez_num);
    let juradoItems = {};
    let juradoNombres = {};
    try {
      const jurados = await supaFetch(
        `usuarios?rol=eq.jurado&juez_num=in.(${juradoNums.join(",")})&select=juez_num,items,nombre_display`,
        { headers: { "Accept-Profile": "personal" } },
      );
      for (const j of jurados) {
        juradoItems[j.juez_num] = j.items || [];
        if (j.nombre_display) juradoNombres[j.juez_num] = j.nombre_display;
      }
    } catch (e) {
      console.warn("No se pudieron obtener items de jurados:", e);
    }

    // 5. Calcular totales
    const totalPts = puntajes.reduce((s, p) => s + (p.subtotal || 0), 0);
    const maxPorJurado =
      puntajes.length > 0
        ? Object.keys(puntajes[0].items || {}).length * 10
        : 20;
    const maxTotal = puntajes.length * maxPorJurado;

    // 6. Construir tabla de puntajes con nombres reales
    const instLabel =
      sesion.instancia === "int" || sesion.instancia === "inter"
        ? "Inter América"
        : sesion.instancia === "nac"
          ? "Nacional"
          : "Regional";

    let tablaRows = "";
    for (const p of puntajes) {
      const items = p.items || {};
      const nombres = juradoItems[p.juez_num] || [];
      const itemsStr = Object.entries(items)
        .map(([k, v], idx) => {
          const nombre = nombres[idx] || k;
          return `${nombre}: <strong>${v}</strong>`;
        })
        .join(" · ");
      const hasAudio = p.audio_url && p.audio_url.length > 50;
      const nombreJurado = juradoNombres[p.juez_num] || `Jurado ${p.juez_num}`;
      tablaRows += `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #222;color:#C9A84C;font-weight:700">${esc(nombreJurado)}${hasAudio ? " 🎙" : ""}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #222;color:#eee;font-size:13px">${itemsStr}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #222;color:#fff;font-weight:700;text-align:right">${p.subtotal}</td>
      </tr>`;
    }

    // 6. Email HTML (compatible con Gmail, Outlook, Apple Mail)
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background-color:#080808">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#080808"><tr><td align="center" style="padding:40px 20px">
    <table width="600" cellpadding="0" cellspacing="0" style="font-family:'Segoe UI',Arial,sans-serif;color:#F8F5EE">
      <tr><td align="center" style="padding-bottom:32px">
        <div style="font-size:36px;font-weight:700;letter-spacing:6px;color:#C9A84C">JAM</div>
        <div style="font-size:11px;color:#888888;letter-spacing:2px;text-transform:uppercase">${esc(instLabel)} &middot; 2026</div>
      </td></tr>
      <tr><td style="background-color:#141414;border:1px solid #333333;border-radius:16px;padding:24px;margin-bottom:24px">
        <div style="font-size:10px;color:#A08840;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px">DEVOLUCI&Oacute;N DE EVALUACI&Oacute;N</div>
        <div style="font-size:13px;color:#C9A84C;margin-bottom:4px">${esc(sesion.codigo_id)}</div>
        <div style="font-size:24px;font-weight:600;color:#F8F5EE;margin-bottom:4px">${esc(sesion.nombre_grupo)}</div>
        <div style="font-size:13px;color:#999999">${esc(sesion.pais || "")} &middot;
        ${esc(formatCategoria(sesion.categoria))}</div>
      </td></tr>
      ${mailT.saludo_devolucion ? `<tr><td height="16"></td></tr>
      <tr><td style="background-color:#141414;border:1px solid #333333;border-radius:16px;padding:20px 24px">
        <div style="font-size:14px;color:#F8F5EE;line-height:1.5">${esc(mailT.saludo_devolucion)}</div>
      </td></tr>` : ""}
      <tr><td height="16"></td></tr>
      <tr><td style="background-color:#141414;border:1px solid #333333;border-radius:16px;padding:24px">
        <div style="font-size:14px;font-weight:600;color:#F8F5EE;margin-bottom:16px">Puntajes por jurado</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          <tr>
            <th style="padding:8px 14px;text-align:left;font-size:11px;color:#888888;border-bottom:1px solid #333333">JURADO</th>
            <th style="padding:8px 14px;text-align:left;font-size:11px;color:#888888;border-bottom:1px solid #333333">&Iacute;TEMS</th>
            <th style="padding:8px 14px;text-align:right;font-size:11px;color:#888888;border-bottom:1px solid #333333">SUBTOTAL</th>
          </tr>
          ${tablaRows}
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr><td align="center" style="padding:16px;background-color:#1a1600;border:1px solid #4a3800;border-radius:12px">
          <div style="font-size:12px;color:#999999">Puntaje Total</div>
          <div style="font-size:42px;font-weight:600;color:#C9A84C;line-height:1.2">${totalPts}</div>
          <div style="font-size:13px;color:#777777">/ ${maxTotal} puntos</div>
        </td></tr></table>
      </td></tr>
      <tr><td height="16"></td></tr>
      ${mailT.cierre_devolucion ? `<tr><td align="center" style="padding:16px 20px 4px;font-size:13px;color:#C9A84C">${esc(mailT.cierre_devolucion)}</td></tr>` : ""}
      <tr><td align="center" style="padding:20px;font-size:12px;color:#555555">
        JAM Producciones &middot; Dance Competition 2026<br>
        Este email fue generado autom&aacute;ticamente.
      </td></tr>
    </table>
    </td></tr></table>
    </body></html>`;

    // 7. Generar certificado de participación PDF
    const PDFDocument = require("pdfkit");
    const certBuffer = await new Promise((resolve) => {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margin: 60,
      });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      // Fondo
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#080808");

      // Borde dorado
      doc
        .rect(30, 30, doc.page.width - 60, doc.page.height - 60)
        .lineWidth(2)
        .stroke("#C9A84C");
      doc
        .rect(38, 38, doc.page.width - 76, doc.page.height - 76)
        .lineWidth(0.5)
        .stroke("rgba(201,168,76,0.3)");

      // Header
      doc
        .font("Helvetica-Bold")
        .fontSize(42)
        .fillColor("#C9A84C")
        .text("JAM", 0, 80, { align: "center" });
      doc
        .fontSize(14)
        .fillColor("#888888")
        .text("DANCE COMPETITION 2026", 0, 130, { align: "center" });
      doc
        .fontSize(11)
        .fillColor("#666666")
        .text(instLabel.toUpperCase(), 0, 152, { align: "center" });

      // Línea decorativa
      doc
        .moveTo(doc.page.width / 2 - 80, 178)
        .lineTo(doc.page.width / 2 + 80, 178)
        .lineWidth(1)
        .stroke("#C9A84C");

      // Certificado
      doc
        .fontSize(16)
        .fillColor("#AAAAAA")
        .text("CERTIFICADO DE PARTICIPACIÓN", 0, 200, { align: "center" });

      // Nombre del participante
      doc
        .fontSize(36)
        .fillColor("#F8F5EE")
        .text(sesion.nombre_grupo || "—", 0, 240, { align: "center" });

      // Código y categoría
      doc
        .fontSize(12)
        .fillColor("#C9A84C")
        .text(sesion.codigo_id + "  ·  " + (sesion.pais || ""), 0, 290, {
          align: "center",
        });

      // Armamos el texto limpio de la categoría
      const categoriaLimpia = formatCategoria(sesion.categoria);

      doc
        .fontSize(11)
        .fillColor("#888888")
        .text(categoriaLimpia, 0, 310, { align: "center" });

      // Puntaje
      doc
        .moveTo(doc.page.width / 2 - 60, 340)
        .lineTo(doc.page.width / 2 + 60, 340)
        .lineWidth(0.5)
        .stroke("#333333");
      doc
        .fontSize(14)
        .fillColor("#AAAAAA")
        .text("Puntaje obtenido", 0, 355, { align: "center" });
      doc
        .fontSize(48)
        .fillColor("#C9A84C")
        .text(String(totalPts), 0, 375, { align: "center" });
      doc
        .fontSize(12)
        .fillColor("#666666")
        .text("/ " + maxTotal + " puntos", 0, 430, { align: "center" });

      // Fecha
      const fecha = new Date().toLocaleDateString("es-AR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      doc
        .fontSize(10)
        .fillColor("#555555")
        .text(fecha, 0, 470, { align: "center" });

      // Footer
      doc
        .fontSize(8)
        .fillColor("#444444")
        .text(
          "JAM Producciones · Palais Rouge · Buenos Aires, Argentina",
          0,
          doc.page.height - 70,
          { align: "center" },
        );

      doc.end();
    });

    // 8. Enviar con Resend
    const { Resend } = require("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Preparar attachments (audio si existe)
    const attachments = [];
    for (const p of puntajes) {
      if (p.audio_url) {
        try {
          if (p.audio_url.startsWith("data:")) {
            const mimeMatch = p.audio_url.match(/^data:(audio\/[^;]+);/);
            const mime = mimeMatch ? mimeMatch[1] : "audio/mp4";
            const ext =
              mime.includes("mp4") || mime.includes("m4a")
                ? "m4a"
                : mime.includes("ogg")
                  ? "ogg"
                  : "m4a";
            const b64 = p.audio_url.split(",")[1];
            if (b64 && b64.length > 100) {
              attachments.push({
                filename: `evaluacion-jurado-${p.juez_num}.${ext}`,
                content: Buffer.from(b64, "base64"),
              });
            }
          } else if (p.audio_url.startsWith("http")) {
            const audioRes = await fetch(p.audio_url);
            if (audioRes.ok) {
              attachments.push({
                filename: `evaluacion-jurado-${p.juez_num}.m4a`,
                content: Buffer.from(await audioRes.arrayBuffer()),
              });
            }
          }
        } catch (e) {
          console.warn("Audio jurado " + p.juez_num + ":", e);
        }
      }
    }

    const audioCount = attachments.length;

    // Agregar certificado PDF a attachments
    attachments.push({
      filename: `Certificado-JAM-2026-${sesion.codigo_id}.pdf`,
      content: certBuffer,
    });

    const audioNote =
      audioCount > 0
        ? `<div style="background:#141414;border:1px solid rgba(76,175,125,.2);border-radius:16px;padding:20px;margin-bottom:24px;text-align:center"><div style="font-size:14px;font-weight:600;margin-bottom:8px">🎙 Devoluciones en audio</div><div style="font-size:13px;color:rgba(248,245,238,.5)">${audioCount} audio/s adjunto/s. Revisá los archivos de este email.</div></div>`
        : "";

    const sendResult = await resend.emails.send({
      from: SENDER,
      to: Array.from(destinatariosDev),
      subject: mailT.asunto_devolucion
        ? `${mailT.asunto_devolucion} — ${sesion.nombre_grupo} (${sesion.codigo_id})`
        : `JAM 2026 — Devolución: ${sesion.nombre_grupo} (${sesion.codigo_id})`,
      html: audioNote
        ? html.replace("JAM Producciones", audioNote + "JAM Producciones")
        : html,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    return res.status(200).json({
      ok: true,
      emailId: sendResult.data?.id,
      to: Array.from(destinatariosDev),
      destinatarios: destinatariosDev.size,
      total: totalPts,
      jurados: puntajes.length,
    });
  } catch (e) {
    console.error("Error enviar-devolucion:", e);
    return res.status(500).json({ error: e.message });
  }
};
