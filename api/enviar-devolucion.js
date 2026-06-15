// /api/enviar-devolucion.js — JAM 2026
// Envía devolución por email al participante después de ser evaluado
// Incluye: puntajes por jurado, audio de evaluación, certificado

const SENDER = "JAM Producciones <info@jamcompetencia.com>";

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { sesion_id } = req.body;
    if (!sesion_id) return res.status(400).json({ error: "sesion_id requerido" });

    // 1. Obtener sesión
    const sesiones = await supaFetch(
      `sesiones?id=eq.${sesion_id}&select=*`,
      { headers: { "Accept-Profile": "scoring" } }
    );
    const sesion = sesiones[0];
    if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" });

    // 2. Obtener puntajes de todos los jurados
    const puntajes = await supaFetch(
      `puntajes?sesion_id=eq.${sesion_id}&select=*&order=juez_num`,
      { headers: { "Accept-Profile": "scoring" } }
    );

    // 3. Buscar email del participante (via lineup → inscripciones)
    const lineup = await supaFetch(
      `lineup?codigo_id=eq.${sesion.codigo_id}&select=inscripcion_id`,
      { headers: { "Accept-Profile": "evento" } }
    );
    const inscId = lineup[0]?.inscripcion_id;
    let email = null;
    let nombreResp = null;
    if (inscId) {
      const inscrip = await supaFetch(`inscripciones?id=eq.${inscId}&select=email,nombre`);
      email = inscrip[0]?.email;
      nombreResp = inscrip[0]?.nombre;
    }
    if (!email) return res.status(404).json({ error: "Email del participante no encontrado" });

    // 4. Obtener nombres de ítems de cada jurado
    const juradoNums = puntajes.map(p => p.juez_num);
    let juradoItems = {};
    try {
      const jurados = await supaFetch(
        `usuarios?rol=eq.jurado&juez_num=in.(${juradoNums.join(",")})&select=juez_num,items`,
        { headers: { "Accept-Profile": "personal" } }
      );
      for (const j of jurados) {
        juradoItems[j.juez_num] = j.items || [];
      }
    } catch(e) { console.warn("No se pudieron obtener items de jurados:", e); }

    // 5. Calcular totales
    const totalPts = puntajes.reduce((s, p) => s + (p.subtotal || 0), 0);
    const maxPorJurado = puntajes.length > 0
      ? Object.keys(puntajes[0].items || {}).length * 10
      : 20;
    const maxTotal = puntajes.length * maxPorJurado;

    // 6. Construir tabla de puntajes con nombres reales
    const instLabel = sesion.instancia === "int" || sesion.instancia === "inter"
      ? "Inter América" : sesion.instancia === "nac" ? "Nacional" : "Regional";

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
      tablaRows += `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #222;color:#C9A84C;font-weight:700">Jurado ${p.juez_num}${hasAudio ? ' 🎙' : ''}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #222;color:#eee;font-size:13px">${itemsStr}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #222;color:#fff;font-weight:700;text-align:right">${p.subtotal}</td>
      </tr>`;
    }

    // 6. Email HTML
    const html = `
    <div style="background:#080808;color:#F8F5EE;font-family:'Segoe UI',Arial,sans-serif;padding:40px 20px;max-width:600px;margin:0 auto">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:36px;font-weight:700;letter-spacing:6px;color:#C9A84C">JAM</div>
        <div style="font-size:11px;color:rgba(248,245,238,.4);letter-spacing:2px;text-transform:uppercase">${esc(instLabel)} · 2026</div>
      </div>

      <div style="background:#141414;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;margin-bottom:24px">
        <div style="font-size:10px;color:rgba(201,168,76,.5);letter-spacing:3px;text-transform:uppercase;margin-bottom:8px">DEVOLUCIÓN DE EVALUACIÓN</div>
        <div style="font-size:13px;color:#C9A84C;margin-bottom:4px">${esc(sesion.codigo_id)}</div>
        <div style="font-size:24px;font-weight:600;margin-bottom:4px">${esc(sesion.nombre_grupo)}</div>
        <div style="font-size:13px;color:rgba(248,245,238,.5)">${esc(sesion.pais || "")} · ${esc(sesion.categoria || "")}</div>
      </div>

      <div style="background:#141414;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;margin-bottom:24px">
        <div style="font-size:14px;font-weight:600;margin-bottom:16px">Puntajes por jurado</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="padding:8px 14px;text-align:left;font-size:11px;color:rgba(248,245,238,.4);border-bottom:1px solid #333">JURADO</th>
            <th style="padding:8px 14px;text-align:left;font-size:11px;color:rgba(248,245,238,.4);border-bottom:1px solid #333">ÍTEMS</th>
            <th style="padding:8px 14px;text-align:right;font-size:11px;color:rgba(248,245,238,.4);border-bottom:1px solid #333">SUBTOTAL</th>
          </tr></thead>
          <tbody>${tablaRows}</tbody>
        </table>
        <div style="text-align:center;margin-top:20px;padding:16px;background:#1a1600;border:1px solid rgba(201,168,76,.2);border-radius:12px">
          <div style="font-size:12px;color:rgba(248,245,238,.5)">Puntaje Total</div>
          <div style="font-size:42px;font-weight:600;color:#C9A84C;line-height:1">${totalPts}</div>
          <div style="font-size:13px;color:rgba(248,245,238,.4)">/ ${maxTotal} puntos</div>
        </div>
      </div>

      <div style="text-align:center;padding:20px;font-size:12px;color:rgba(248,245,238,.3)">
        JAM Producciones · Dance Competition 2026<br>
        Este email fue generado automáticamente.
      </div>
    </div>`;

    // 7. Enviar con Resend
    const { Resend } = require("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Preparar attachments (audio si existe)
    const attachments = [];
    for (const p of puntajes) {
      if (p.audio_url) {
        try {
          if (p.audio_url.startsWith("data:")) {
            const b64 = p.audio_url.split(",")[1];
            if (b64 && b64.length > 100) {
              attachments.push({
                filename: `evaluacion-jurado-${p.juez_num}.webm`,
                content: Buffer.from(b64, "base64"),
              });
            }
          } else if (p.audio_url.startsWith("http")) {
            // Audio almacenado como URL externa
            const audioRes = await fetch(p.audio_url);
            if (audioRes.ok) {
              const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
              attachments.push({
                filename: `evaluacion-jurado-${p.juez_num}.webm`,
                content: audioBuffer,
              });
            }
          }
        } catch(e) { console.warn("Error procesando audio jurado " + p.juez_num + ":", e); }
      }
    }

    const audioNote = attachments.length > 0 
      ? `<div style="background:#141414;border:1px solid rgba(76,175,125,.2);border-radius:16px;padding:20px;margin-bottom:24px;text-align:center"><div style="font-size:14px;font-weight:600;margin-bottom:8px">🎙 Devoluciones en audio</div><div style="font-size:13px;color:rgba(248,245,238,.5)">${attachments.length} audio(s) adjunto(s). Revisá los archivos de este email.</div></div>`
      : "";

    const sendResult = await resend.emails.send({
      from: SENDER,
      to: [email],
      subject: `JAM 2026 — Devolución: ${sesion.nombre_grupo} (${sesion.codigo_id})`,
      html: audioNote ? html.replace('JAM Producciones', audioNote + 'JAM Producciones') : html,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    return res.status(200).json({
      ok: true,
      emailId: sendResult.data?.id,
      to: email,
      total: totalPts,
      jurados: puntajes.length,
    });
  } catch (e) {
    console.error("Error enviar-devolucion:", e);
    return res.status(500).json({ error: e.message });
  }
};
