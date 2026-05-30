// /api/notify.js — JAM 2026 v16
// FIX v16: mail al admin SIEMPRE + sin botón "Subí tu música" en mail al participante

import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const SENDER = "JAM Producciones <info@jamcompetencia.com>";
const ADMIN_EMAIL = "info@jamcompetencia.com";
const SITE = process.env.SITE_URL || "https://jam-inscripciones.vercel.app";

const INSTANCIA_CFG = {
  reg:  { label: "Sedes",          code: "JAM-REG",   offset: 1 },
  rep:  { label: "Repechaje",      code: "JAM-REP",   offset: 10 },
  nac:  { label: "Final Nacional", code: "JAM-NAC",   offset: 200 },
  int:  { label: "Final Inter América", code: "JAM-INTER", offset: 1000 }
};

const PAGO_VIAMONTE = {
  alias: "VIAMONTE2600",
  cbu: "000000310009572128629",
  titular: "Liliana Naomi Tanabe"
};

const PAGO_PREX = {
  plataforma: "Prex",
  cuenta: "35722990",
  titular: "Nelson Gastón Vidarte"
};

const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const escEq = u => u;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: ins, error: errIns } = await supa.from("inscripciones").select("*").eq("id", id).single();
    if (errIns || !ins) return res.status(404).json({ error: "Inscripción no encontrada" });

    const cfg = INSTANCIA_CFG[ins.instancia] || INSTANCIA_CFG.reg;
    const { data: allInst } = await supa.from("inscripciones").select("id,created_at").eq("instancia", ins.instancia).order("created_at", { ascending: true });
    let pos = 1;
    if (allInst) {
      const idx = allInst.findIndex(x => x.id === ins.id);
      pos = idx >= 0 ? idx + 1 : 1;
    }
    const num = String(cfg.offset + (Math.max(pos, 1) - 1)).padStart(4, "0");
    const codigo_legible = cfg.code + "-" + num;

    let integrantes = [];
    try {
      const raw = ins.integrantes;
      if (raw) integrantes = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch(e) {}
    if (!Array.isArray(integrantes)) integrantes = [];

    let categorias = [];
    try {
      const raw = ins.categorias;
      if (raw) categorias = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch(e) {}
    if (!Array.isArray(categorias)) categorias = [];

    const nombre_grupo = ins.nombre_grupo || ins.nombre || "Participante";
    const fecha = ins.created_at ? new Date(ins.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "—";
    const monto = (ins.moneda || "ARS") + " " + Number(ins.monto_total || 0).toLocaleString("es-AR");

    const intHtml = integrantes.length ? integrantes.map((it, idx) => {
      const subCode = codigo_legible + "-" + (idx + 1);
      const nm = (it && (it.nombre || it.name)) || "Integrante " + (idx + 1);
      return '<tr><td style="padding:10px 12px;background:#1a1600;border-left:3px solid #C9A84C">' +
        '<div style="font-family:\'Courier New\',monospace;font-size:12px;color:#C9A84C;letter-spacing:1px;font-weight:600;margin-bottom:3px">' + esc(subCode) + '</div>' +
        '<div style="font-family:Georgia,serif;font-size:16px;color:#F8F5EE;font-weight:600">' + esc(nm) + '</div>' +
        '<div style="font-size:11px;color:#888;margin-top:2px">' + esc(nombre_grupo) + '</div>' +
        '</td></tr>';
    }).join("") : "";

    const catHtml = categorias.length ? categorias.map(c => {
      const n = c.c != null ? "N° " + c.c : "";
      const g = c.g ? " · " + String(c.g).toUpperCase() : "";
      const nm = c.n || c.nombre || "Categoría";
      return '<tr><td style="padding:10px 12px;background:#1a1600;border-left:3px solid #C9A84C">' +
        '<div style="font-family:\'Courier New\',monospace;font-size:11px;color:#C9A84C;margin-bottom:3px;font-weight:600">' + esc(n + g) + '</div>' +
        '<div style="font-family:Georgia,serif;font-size:16px;color:#F8F5EE;font-weight:600">' + esc(nm) + '</div>' +
        '</td></tr>';
    }).join("") : "";

    const isInter = ins.instancia === "int";
    const pagoHtml = isInter ? `
      <div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0">
        <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:14px;text-align:center">Datos para pagar · Inter América</div>
        <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
          <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Plataforma de pago</div>
          <div style="font-family:Georgia,serif;font-size:22px;color:#F8F5EE;font-weight:700">${PAGO_PREX.plataforma}</div>
        </div>
        <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
          <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Cuenta / Alias Prex</div>
          <div style="font-family:'Courier New',monospace;font-size:14px;color:#E8A838">${PAGO_PREX.cuenta}</div>
        </div>
        <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px">
          <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Titular responsable</div>
          <div style="font-family:Georgia,serif;font-size:15px;color:#E8A838">${PAGO_PREX.titular}</div>
        </div>
        <div style="font-size:12px;color:rgba(248,245,238,.6);text-align:center;margin-top:14px;line-height:1.5">La instancia Inter América se abona <strong style="color:#C9A84C">exclusivamente</strong> vía Prex.</div>
      </div>
    ` : `
      <div style="background:#1a1600;border:2px solid #C9A84C;border-radius:14px;padding:22px;margin:24px 0">
        <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:14px;text-align:center">Datos para pagar (transferencia)</div>
        <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
          <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Alias</div>
          <div style="font-family:'Courier New',monospace;font-size:18px;color:#F8F5EE;font-weight:700">${PAGO_VIAMONTE.alias}</div>
        </div>
        <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px;margin-bottom:8px">
          <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">CBU</div>
          <div style="font-family:'Courier New',monospace;font-size:14px;color:#F8F5EE">${PAGO_VIAMONTE.cbu}</div>
        </div>
        <div style="background:#0A0A0A;border:1px dashed rgba(201,168,76,.5);padding:12px 14px;border-radius:10px">
          <div style="font-size:10px;color:rgba(248,245,238,.5);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Titular</div>
          <div style="font-family:Georgia,serif;font-size:15px;color:#F8F5EE">${PAGO_VIAMONTE.titular}</div>
        </div>
      </div>
    `;

    const checkUrl = escEq(SITE + "/check?id=" + ins.id);
    const musicaUrl = ins.musica_token ? escEq(SITE + "/musica?token=" + ins.musica_token) : null;
    const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(SITE + "/check?id=" + ins.id);
    const subj = "Inscripción JAM 2026 confirmada — " + codigo_legible;

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
  <p style="margin:0 0 16px;color:#444">Hola <strong>${esc(ins.nombre || nombre_grupo)}</strong>, tu inscripción a <strong>${esc(cfg.label)}</strong> fue recibida correctamente.</p>
  ${integrantes.length ? '<h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Integrantes (' + integrantes.length + ')</h3><table style="width:100%;border-collapse:separate;border-spacing:0 6px;margin-bottom:20px">' + intHtml + '</table>' : ''}
  ${categorias.length ? '<h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Categorías inscriptas (' + categorias.length + ')</h3><table style="width:100%;border-collapse:separate;border-spacing:0 6px;margin-bottom:20px">' + catHtml + '</table>' : ''}
  <h3 style="font-family:Georgia,serif;color:#C9A84C;font-size:18px;margin:24px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px">Datos</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${esc(ins.nombre)}</strong></td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Modalidad</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${esc(ins.modalidad || "—")}</strong> <span style="color:#888;font-size:12px">(${ins.cant_personas || 1} persona${(ins.cant_personas || 1) > 1 ? "s" : ""})</span></td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Monto</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#C9A84C;font-weight:700">${esc(monto)}</td></tr>
    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Fecha</td><td style="padding:8px 0;text-align:right">${esc(fecha)}</td></tr>
  </table>
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

    const intText = integrantes.length ? "\n\nINTEGRANTES (" + integrantes.length + ")\n" + integrantes.map((it, idx) => {
      return (codigo_legible + "-" + (idx + 1)) + "\n" + ((it && (it.nombre || it.name)) || "Integrante " + (idx + 1)) + "\n" + nombre_grupo;
    }).join("\n\n") : "";
    const catText = categorias.length ? "\n\nCATEGORÍAS (" + categorias.length + ")\n" + categorias.map(c => "N° " + (c.c || "?") + " · " + (c.g || "").toUpperCase() + "\n" + (c.n || c.nombre || "Categoría")).join("\n") : "";
    const pagoText = isInter
      ? "\n\nDatos para pagar · Inter América\nPlataforma: " + PAGO_PREX.plataforma + "\nCuenta/Alias Prex: " + PAGO_PREX.cuenta + "\nTitular: " + PAGO_PREX.titular
      : "\n\nDatos para pagar (transferencia)\nAlias: " + PAGO_VIAMONTE.alias + "\nCBU: " + PAGO_VIAMONTE.cbu + "\nTitular: " + PAGO_VIAMONTE.titular;
    const textParticipante = "JAM 2026\nInscripción confirmada\nCódigo: " + codigo_legible + "\n" + nombre_grupo + "\n" + cfg.label + intText + catText + "\n\nResponsable: " + ins.nombre + "\nMonto: " + monto + pagoText + "\n\nVer: " + checkUrl;

    // ENVIAR mail al participante
    let mail_participante = { ok: false };
    try {
      const r = await resend.emails.send({
        from: SENDER,
        to: [ins.email],
        subject: subj,
        html: htmlParticipante,
        text: textParticipante
      });
      mail_participante = { ok: !r.error, id: r.data?.id, error: r.error?.message };
    } catch(e) {
      mail_participante = { ok: false, error: e.message };
    }

    // ENVIAR mail al sede (solo REG)
    let mail_sede = null;
    if (ins.instancia === "reg" && ins.sede_email_org) {
      try {
        const sedeHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">' +
          '<div style="background:#0A0A0A;padding:24px;text-align:center"><div style="font-family:Georgia,serif;font-size:36px;color:#C9A84C;letter-spacing:6px;font-weight:700">JAM</div><div style="color:rgba(248,245,238,.5);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:4px">Nueva inscripción en tu sede</div></div>' +
          '<div style="padding:24px"><p>Se inscribió un nuevo participante en la sede <strong>' + esc(ins.sede_nombre || "—") + '</strong>.</p>' +
          '<table style="width:100%;border-collapse:collapse;margin-top:16px">' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Código</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;color:#C9A84C;font-weight:700">' + esc(codigo_legible) + '</td></tr>' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>' + esc(ins.nombre) + '</strong></td></tr>' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.email) + '</td></tr>' +
          '<tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase">Monto</td><td style="padding:8px 0;text-align:right;color:#C9A84C;font-weight:700">' + esc(monto) + '</td></tr>' +
          '</table>' +
          '<p style="margin-top:20px;text-align:center"><a href="' + checkUrl + '" style="background:#C9A84C;color:#0A0A0A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Ver inscripción →</a></p>' +
          '</div></div>';
        const r = await resend.emails.send({
          from: SENDER,
          to: [ins.sede_email_org],
          subject: "Nueva inscripción " + codigo_legible + " — " + nombre_grupo,
          html: sedeHtml,
          text: "Nueva inscripción en sede " + (ins.sede_nombre || "") + "\nCódigo: " + codigo_legible + "\nResponsable: " + ins.nombre + "\nMonto: " + monto + "\nVer: " + checkUrl
        });
        mail_sede = { ok: !r.error, id: r.data?.id, error: r.error?.message };
      } catch(e) {
        mail_sede = { ok: false, error: e.message };
      }
    }

    // ENVIAR mail al admin (SIEMPRE) - NUEVO en v15
    let mail_admin = { ok: false };
    try {
      const adminHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#222">' +
        '<div style="background:#0A0A0A;padding:24px;text-align:center"><div style="font-family:Georgia,serif;font-size:36px;color:#C9A84C;letter-spacing:6px;font-weight:700">JAM</div><div style="color:rgba(248,245,238,.5);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:4px">Panel director · Nueva inscripción</div></div>' +
        '<div style="padding:24px">' +
        '<p style="margin:0 0 14px"><strong style="color:#C9A84C">Nueva inscripción registrada</strong></p>' +
        '<table style="width:100%;border-collapse:collapse">' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Instancia</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>' + esc(cfg.label) + '</strong></td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Código</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;color:#C9A84C;font-weight:700">' + esc(codigo_legible) + '</td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Nombre/Grupo</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>' + esc(nombre_grupo) + '</strong></td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Responsable</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.nombre) + '</td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.email) + '</td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Celular</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.celular || "—") + '</td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">País</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.pais || "—") + '</td></tr>' +
        (ins.sede_nombre ? '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Sede</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.sede_nombre) + '</td></tr>' : '') +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Modalidad</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + esc(ins.modalidad || "—") + ' (' + (ins.cant_personas || 1) + ' pers.)</td></tr>' +
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:12px;text-transform:uppercase">Categorías</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">' + categorias.length + '</td></tr>' +
        '<tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase">Monto</td><td style="padding:8px 0;text-align:right;color:#C9A84C;font-weight:700;font-size:16px">' + esc(monto) + '</td></tr>' +
        '</table>' +
        '<p style="margin-top:24px;text-align:center"><a href="' + checkUrl + '" style="background:#C9A84C;color:#0A0A0A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.5px">Ver inscripción →</a> &nbsp; <a href="' + SITE + '/admin" style="background:transparent;color:#C9A84C;border:1px solid #C9A84C;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.5px">Panel admin →</a></p>' +
        '</div></div>';
      const adminText = "JAM · Nueva inscripción\nInstancia: " + cfg.label + "\nCódigo: " + codigo_legible + "\nNombre: " + nombre_grupo + "\nResponsable: " + ins.nombre + "\nEmail: " + ins.email + "\nCelular: " + (ins.celular || "—") + "\nPaís: " + (ins.pais || "—") + (ins.sede_nombre ? "\nSede: " + ins.sede_nombre : "") + "\nModalidad: " + (ins.modalidad || "—") + " (" + (ins.cant_personas || 1) + " pers.)\nCategorías: " + categorias.length + "\nMonto: " + monto + "\n\nVer: " + checkUrl + "\nPanel: " + SITE + "/admin";
      const r = await resend.emails.send({
        from: SENDER,
        to: [ADMIN_EMAIL],
        subject: "[Admin JAM] Nueva inscripción " + codigo_legible + " — " + nombre_grupo,
        html: adminHtml,
        text: adminText
      });
      mail_admin = { ok: !r.error, id: r.data?.id, error: r.error?.message };
    } catch(e) {
      mail_admin = { ok: false, error: e.message };
    }

    return res.status(200).json({
      ok: true,
      id: ins.id,
      codigo_legible,
      instancia: ins.instancia,
      integrantes_count: integrantes.length,
      categorias_count: categorias.length,
      mail_participante,
      mail_sede,
      mail_admin
    });
  } catch(e) {
    return res.status(500).json({ error: e.message || "Internal error" });
  }
}
