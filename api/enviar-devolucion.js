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
    // poner_en_pista a veces no encuentra el elemento original (con el
    // código "c") y reconstruye la categoría solo con género+nombre —
    // en ese caso no hay código que mostrar, mejor omitir el prefijo
    // que mostrar literalmente "undefined: ".
    const one = (item) =>
      item?.c != null ? `${item.c}: ${item.n}` : `${item.n}`;
    if (Array.isArray(v)) return v.map(one).join(" - ");
    if (v && typeof v === "object") return one(v);
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
    let sedeNombre = "";
    let integrantesDev = [];
    if (inscId) {
      const inscrip = await supaFetch(
        `inscripciones?id=eq.${inscId}&select=email,nombre,integrantes,sede_nombre`,
      );
      email = inscrip[0]?.email;
      nombreResp = inscrip[0]?.nombre;
      sedeNombre = inscrip[0]?.sede_nombre || "";
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
    // Antes se asumía que todos los jurados puntuaban con la misma
    // cantidad de ítems (se tomaba solo del primer puntaje) — pero
    // dPresetRegional permite configurar cada jurado con una cantidad
    // distinta, así que el "/ X puntos" que recibía el participante podía
    // quedar mal si los jurados no eran todos iguales. Ahora se suma la
    // cantidad real de ítems de CADA jurado.
    const maxTotal =
      puntajes.reduce(
        (s, p) => s + Object.keys(p.items || {}).length * 10,
        0,
      ) || puntajes.length * 20;

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
      // Preferir el nombre guardado en el momento en que el jurado cerró su
      // planilla (columna juez_nombre, cargada por un trigger en la base) —
      // antes esto buscaba SIEMPRE el nombre actual de personal.usuarios
      // por juez_num, así que un reenvío después de que ese número de
      // jurado pasara a otra persona (nueva sede) mostraba el nombre
      // equivocado. El lookup en vivo queda solo como respaldo para filas
      // viejas anteriores a este cambio.
      const nombreJurado =
        p.juez_nombre || juradoNombres[p.juez_num] || `Jurado ${p.juez_num}`;
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
    const path = require("path");
    const tangerineFontPath = path.join(__dirname, "..", "fonts", "Tangerine-Regular.ttf");

    // Nacional, Regional/Sedes e Inter América usan una plantilla con imagen
    // de fondo, donde solo varía el nombre del participante (y, en Inter
    // América, la fecha — el diseño de Nacional y Regional ya la trae
    // impresa en la imagen). Repechaje conserva el certificado vectorial
    // de siempre.
    const esConPlantilla =
      sesion.instancia === "nac" ||
      sesion.instancia === "reg" ||
      sesion.instancia === "int" ||
      sesion.instancia === "inter";

    // Un certificado por persona, con su propio nombre — no uno solo con
    // el nombre del grupo/pareja/trío. Si hay integrantes cargados (pareja,
    // trío, grupo) se genera uno por integrante, emparejado con su propio
    // email (para el envío individual del paso 8); si no (individual, o
    // dato legado sin integrantes) se usa nombre_grupo + el email de
    // contacto de la inscripción, como siempre.
    const personasCertificado =
      integrantesDev.length > 0
        ? integrantesDev
            .map((it) => ({
              nombre: (it?.nombre || "").trim(),
              email: (it?.email || it?.mail || "").trim().toLowerCase(),
            }))
            .filter((p) => p.nombre)
        : [];
    if (personasCertificado.length === 0)
      personasCertificado.push({
        nombre: sesion.nombre_grupo || "—",
        email: (email || "").trim().toLowerCase(),
      });

    const certBuffers = await Promise.all(
      personasCertificado.map((p) =>
        esConPlantilla
          ? generarCertificadoConPlantilla(sesion, p.nombre)
          : generarCertificadoRegional(
              sesion,
              instLabel,
              totalPts,
              maxTotal,
              p.nombre,
            ),
      ),
    );

    async function generarCertificadoConPlantilla(sesion, nombreCert) {
      const esNac = sesion.instancia === "nac";
      const esReg = sesion.instancia === "reg";
      const templatePath = path.join(
        __dirname,
        "..",
        "imgs",
        esNac
          ? "certificado-nac.jpg"
          : esReg
            ? "certificado-reg.jpg"
            : "certificado-inter.jpeg",
      );
      const imgW = esNac ? 1684 : esReg ? 1600 : 1536;
      const imgH = esNac ? 1232 : esReg ? 1131 : 1024;
      const pageW = 800;
      const pageH = pageW * (imgH / imgW);

      return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [pageW, pageH], margin: 0 });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));

        doc.image(templatePath, 0, 0, { width: pageW, height: pageH });
        doc.registerFont("Tangerine", tangerineFontPath);

        const nombre = nombreCert || sesion.nombre_grupo || "—";

        // Ratio ascender/em de Tangerine (medido con doc._font.ascender=750
        // sobre 1000 unidades/em) — para anclar el nombre por su línea de
        // base real en vez de por una caja centrada en la fuente.
        const TANGERINE_ASCENT = 0.75;

        // Compartida por las 3 plantillas: mide el string y achica la
        // tipografía hasta que entre en el ancho disponible, en vez de un
        // tamaño fijo que puede desbordar sobre el resto del certificado
        // (¡Tangerine, siendo un font script, no pesa/mide igual que
        // Times-Bold — importa especialmente acá!).
        function fitFontSize(str, fontName, maxSize, minSize, maxWidth) {
          doc.font(fontName);
          let size = maxSize;
          while (
            size > minSize &&
            doc.fontSize(size).widthOfString(str) > maxWidth
          ) {
            size -= 0.5;
          }
          return size;
        }

        if (esReg) {
          // La plantilla trae 5 renglones en blanco para completar (medidos
          // en px sobre la imagen nativa 1600x1131, escalados x0.5 a este
          // pageW/pageH de 800): día/mes, sede, nombre del participante,
          // puntaje y categoría. Si se reemplaza la imagen de nuevo, hay
          // que remedir estas coordenadas contra el nuevo archivo.
          const fecha = new Date(sesion.finalizada_at || Date.now());
          const dia = fecha.getDate();
          const mes = fecha.getMonth() + 1;
          const categoriaLimpia = formatCategoria(sesion.categoria);

          doc.fillColor("#1a1a1a");

          // Techo de tamaño de cada campo — el piso (10/9 más abajo en
          // cada llamada a fitFontSize) sigue actuando de red de
          // seguridad para strings largos, así que subir estos techos
          // agranda la letra en el caso normal sin arriesgar que un
          // nombre/sede/categoría larga se pise con el resto del
          // certificado: fitFontSize la va a achicar hasta que entre.
          const DIA_MES_MAX = 18;
          const SEDE_MAX = 19;
          const NOMBRE_MAX = 30; // Tangerine (script) necesita más pt que Times-Bold para el mismo peso visual
          const PUNTAJE_MAX = 19;
          const CAT_MAX = 17;

          const diaSize = fitFontSize(String(dia), "Helvetica-Bold", DIA_MES_MAX, 10, 50);
          const mesSize = fitFontSize(String(mes), "Helvetica-Bold", DIA_MES_MAX, 10, 50);
          doc
            .font("Helvetica-Bold")
            .fontSize(diaSize)
            .text(String(dia), 250, 256.5 + (DIA_MES_MAX - diaSize) / 2, {
              width: 57.5,
              align: "center",
              lineBreak: false,
            });
          doc
            .font("Helvetica-Bold")
            .fontSize(mesSize)
            .text(String(mes), 317.5, 256.5 + (DIA_MES_MAX - mesSize) / 2, {
              width: 56.5,
              align: "center",
              lineBreak: false,
            });

          const sedeStr = sedeNombre || "—";
          const sedeSize = fitFontSize(sedeStr, "Times-Bold", SEDE_MAX, 9, 195);
          doc
            .font("Times-Bold")
            .fontSize(sedeSize)
            .text(sedeStr, 505, 254.5 + (SEDE_MAX - sedeSize) / 2, {
              width: 207.5,
              align: "center",
              lineBreak: false,
            });

          // El nombre se ancla por BASELINE (no por una caja centrada como
          // el resto de los campos): Tangerine tiene un ascender bien más
          // alto que Times-Bold (0.75 vs 0.683 del em), así que la vieja
          // fórmula "centrada en una caja" dejaba la línea de base por
          // debajo del renglón impreso en vez de asentada arriba de él.
          // Renglón de "CERTIFICA QUE" medido en la imagen: y=307.5pt.
          const nombreSize = fitFontSize(nombre, "Tangerine", NOMBRE_MAX, 12, 200);
          doc
            .font("Tangerine")
            .fontSize(nombreSize)
            .text(nombre, 207.5, 303.5 - nombreSize * TANGERINE_ASCENT, {
              width: 210,
              align: "center",
              lineBreak: false,
            });

          const puntajeSize = fitFontSize(String(totalPts), "Helvetica-Bold", PUNTAJE_MAX, 10, 40);
          doc
            .font("Helvetica-Bold")
            .fontSize(puntajeSize)
            .text(String(totalPts), 670, 289.5 + (PUNTAJE_MAX - puntajeSize) / 2, {
              width: 42.5,
              align: "center",
              lineBreak: false,
            });

          const catStr = categoriaLimpia || "—";
          const catSize = fitFontSize(catStr, "Times-Bold", CAT_MAX, 9, 375);
          doc
            .font("Times-Bold")
            .fontSize(catSize)
            .text(catStr, 322.5, 328 + (CAT_MAX - catSize) / 2, {
              width: 390,
              align: "center",
              lineBreak: false,
            });
        } else if (esNac) {
          // Renglón dorado bajo "RECONOCIMIENTO" medido en la imagen: y=344.4pt.
          // Techo 38 (no 44): a 44pt los ascendentes de Tangerine en
          // mayúsculas con floritura (M, J) llegan a tocar "RECONOCIMIENTO"
          // arriba — el ancho casi nunca es el límite real acá.
          const nacSize = fitFontSize(nombre, "Tangerine", 38, 16, pageW * 0.8);
          doc
            .font("Tangerine")
            .fontSize(nacSize)
            .fillColor("#1a1a1a")
            .text(nombre, 0, 339.4 - nacSize * TANGERINE_ASCENT, {
              align: "center",
              width: pageW,
              lineBreak: false,
            });
        } else {
          // Renglón de "A: ____" medido en la imagen: y=359.4pt.
          const intSize = fitFontSize(nombre, "Tangerine", 26, 12, pageW * 0.4);
          doc
            .font("Tangerine")
            .fontSize(intSize)
            .fillColor("#1a1a1a")
            .text(nombre, pageW * 0.3, 355.4 - intSize * TANGERINE_ASCENT, {
              align: "center",
              width: pageW * 0.44,
              lineBreak: false,
            });

          const fecha = new Date(
            sesion.finalizada_at || Date.now(),
          ).toLocaleDateString("es-AR", {
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          doc
            .font("Times-Italic")
            .fontSize(9)
            .fillColor("#555555")
            .text(`Buenos Aires, Argentina — ${fecha}`, 0, pageH * 0.808, {
              align: "center",
              width: pageW,
            });
        }

        doc.end();
      });
    }

    // Pese al nombre, ya solo se usa para Repechaje — Regional/Sedes pasó a
    // la plantilla de imagen (generarCertificadoConPlantilla).
    async function generarCertificadoRegional(sesion, instLabel, totalPts, maxTotal, nombreCert) {
     return new Promise((resolve) => {
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
        .text(nombreCert || sesion.nombre_grupo || "—", 0, 240, { align: "center" });

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
    }

    // 8. Enviar con Resend
    const { Resend } = require("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Adjuntos de audio: son la devolución del jurado sobre la performance
    // completa (no de una persona en particular), así que van igual en el
    // email de todos.
    const audioAttachments = [];
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
              audioAttachments.push({
                filename: `evaluacion-jurado-${p.juez_num}.${ext}`,
                content: Buffer.from(b64, "base64"),
              });
            }
          } else if (p.audio_url.startsWith("http")) {
            const audioRes = await fetch(p.audio_url);
            if (audioRes.ok) {
              // La extension real depende de que formato grabo el
              // navegador del jurado (jSubirAudio guarda .ogg/.webm/.m4a
              // segun corresponda) -- no siempre es m4a, y adjuntarlo con
              // la extension incorrecta puede trabar la reproduccion en
              // algunos clientes de mail.
              const extMatch = p.audio_url.match(/\.(ogg|webm|m4a)(?:\?|$)/i);
              const ext = extMatch ? extMatch[1].toLowerCase() : "m4a";
              audioAttachments.push({
                filename: `evaluacion-jurado-${p.juez_num}.${ext}`,
                content: Buffer.from(await audioRes.arrayBuffer()),
              });
            }
          }
        } catch (e) {
          console.warn("Audio jurado " + p.juez_num + ":", e);
        }
      }
    }

    const audioCount = audioAttachments.length;
    const audioNote =
      audioCount > 0
        ? `<div style="background:#141414;border:1px solid rgba(76,175,125,.2);border-radius:16px;padding:20px;margin-bottom:24px;text-align:center"><div style="font-size:14px;font-weight:600;margin-bottom:8px">🎙 Devoluciones en audio</div><div style="font-size:13px;color:rgba(248,245,238,.5)">${audioCount} audio/s adjunto/s. Revisá los archivos de este email.</div></div>`
        : "";
    const htmlFinal = audioNote
      ? html.replace("JAM Producciones", audioNote + "JAM Producciones")
      : html;
    const subject = mailT.asunto_devolucion
      ? `${mailT.asunto_devolucion} — ${sesion.nombre_grupo} (${sesion.codigo_id})`
      : `JAM 2026 — Devolución: ${sesion.nombre_grupo} (${sesion.codigo_id})`;

    function slugify(nombre) {
      return (
        nombre
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "") // sin acentos
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "participante"
      );
    }

    // Un email por persona, con SOLO su propio certificado adjunto — nadie
    // del grupo ve el certificado de sus compañeros.
    // Agrupar por email (no por persona): si dos integrantes comparten la
    // misma casilla (p. ej. hermanos sin mail propio), van juntos en UN
    // email con AMBOS certificados adjuntos, en vez de que el segundo se
    // pierda o le llegue un mail duplicado a la misma casilla.
    const gruposPorEmail = new Map();
    personasCertificado.forEach((persona, i) => {
      if (!persona.email || !/@/.test(persona.email)) return;
      if (!gruposPorEmail.has(persona.email)) gruposPorEmail.set(persona.email, []);
      gruposPorEmail.get(persona.email).push({ nombre: persona.nombre, buf: certBuffers[i] });
    });

    // Armar todos los envíos primero y despacharlos en paralelo (en vez de
    // un await secuencial por persona) — con un grupo grande, esperar cada
    // send uno detrás del otro puede sumar varios segundos y arriesgar el
    // timeout de la function serverless. Antes esto era siempre UN solo
    // envío sin importar el tamaño del grupo; ahora que es uno por
    // persona, el tiempo total tiene que mantenerse acotado al del envío
    // más lento, no a la suma de todos.
    const envios = Array.from(gruposPorEmail, ([destEmail, personas]) => ({
      to: destEmail,
      nombres: personas.map((p) => p.nombre),
      attachments: [
        ...audioAttachments,
        ...personas.map((p) => ({
          filename: `Certificado-JAM-2026-${sesion.codigo_id}-${slugify(p.nombre)}.pdf`,
          content: p.buf,
        })),
      ],
    }));

    // Salvaguarda: si el email de contacto de la inscripción no coincide
    // con el de ningún integrante (p. ej. lo cargó un responsable que no
    // baila), igual se le avisa — con todos los certificados, porque no es
    // "otro participante" sino quien gestionó la inscripción.
    const emailsCubiertos = new Set(gruposPorEmail.keys());
    const contacto = (email || "").trim().toLowerCase();
    if (contacto && /@/.test(contacto) && !emailsCubiertos.has(contacto)) {
      envios.push({
        to: contacto,
        nombres: [nombreResp || "Responsable"],
        contactoFallback: true,
        attachments: [
          ...audioAttachments,
          ...certBuffers.map((buf, i) => ({
            filename: `Certificado-JAM-2026-${sesion.codigo_id}-${slugify(personasCertificado[i].nombre)}.pdf`,
            content: buf,
          })),
        ],
      });
    }

    const resultados = await Promise.allSettled(
      envios.map((envio) =>
        resend.emails.send({
          from: SENDER,
          to: [envio.to],
          subject,
          html: htmlFinal,
          attachments: envio.attachments,
        }),
      ),
    );

    // El SDK de Resend NO rechaza la promesa ante errores de la API (email
    // inválido, rate limit, remitente no verificado, etc.) — siempre
    // resuelve, y hay que revisar el campo `.error` a mano. Un
    // Promise.allSettled con status "fulfilled" no alcanza solo: eso
    // únicamente detecta fallas de red (promesa rechazada). Sin este
    // chequeo, un envío rechazado por la API figuraría como exitoso.
    const enviados = resultados.map((r, i) => {
      const envio = envios[i];
      if (r.status === "fulfilled" && !r.value.error) {
        return {
          to: envio.to,
          nombres: envio.nombres,
          ok: true,
          emailId: r.value.data?.id,
          contactoFallback: envio.contactoFallback || undefined,
        };
      }
      const errorMsg =
        r.status === "fulfilled"
          ? r.value.error?.message || "Error desconocido de Resend"
          : r.reason?.message || String(r.reason);
      return {
        to: envio.to,
        nombres: envio.nombres,
        ok: false,
        error: errorMsg,
        contactoFallback: envio.contactoFallback || undefined,
      };
    });

    if (!enviados.some((r) => r.ok))
      return res.status(500).json({ error: "No se pudo enviar ningún email", enviados });

    return res.status(200).json({
      ok: true,
      enviados,
      total: totalPts,
      jurados: puntajes.length,
    });
  } catch (e) {
    console.error("Error enviar-devolucion:", e);
    return res.status(500).json({ error: e.message });
  }
};
