/* Mesa de PDF — extras: comprimir (no app.js), marca d'água/carimbo, numerar páginas, assinar e cortar.
   Tudo roda no navegador. Usa os ganchos de window.MesaCore (app.js). */
(() => {
  "use strict";
  const C = window.MesaCore; if (!C) return;
  const { S, prefs, savePrefs, $, say, mutate, byId, idx, fileOf, drawBase, rotCrop, baseToDisp, dispToBase, pageRot } = C;
  const PT = 595;   // largura de referência (A4, em pontos) para as prévias
  const COLORS = { gray: [.45, .45, .45], red: [.8, .1, .1], blue: [.1, .25, .8], black: [0, 0, 0] };
  const CSS_COLORS = { gray: "115,115,115", red: "204,26,26", blue: "26,64,204", black: "0,0,0" };
  const LATIN = /^[ -~ -ÿ]+$/;

  prefs.wm = Object.assign({ on: false, type: "text", text: "CONFIDENCIAL", color: "gray", box: false, size: 64, op: 25, angle: 45, pos: "center" }, prefs.wm || {});
  prefs.num = Object.assign({ on: false, fmt: "Página {n} de {t}", pos: "bc", size: 10, start: 1, skip: false }, prefs.num || {});
  let wmImg = null;   // { bytes, png, el, w, h, name } — fica só na memória
  const sigId = () => "s" + (S.sigSeq = (S.sigSeq || 0) + 1);

  /* ================= utilidades de diálogo ================= */
  const openers = new Map();
  function openDlg(d, opener) { openers.set(d.id, opener || document.activeElement); d.showModal(); }
  document.querySelectorAll(".xdlg").forEach(d => d.addEventListener("close", () => { const o = openers.get(d.id); if (o && o.isConnected && !o.disabled) o.focus(); }));
  const bindOut = (inp, out, fmt) => { const f = () => { out.textContent = fmt ? fmt(inp.value) : inp.value; }; inp.addEventListener("input", f); f(); return f; };
  const firstPage = () => S.pages.find(p => !p.lock) || null;
  const targetPages = () => { const sel = S.pages.filter(p => S.sel.has(p.id) && !p.lock); return sel.length ? sel : S.pages.filter(p => !p.lock); };
  async function pageCanvas(p, cv, side) {   // página real (sem corte/assinatura) numa tela
    if (!p) { cv.width = Math.round(side * .707); cv.height = side; const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cv.width, cv.height); return; }
    try { await drawBase(p, side, cv); } catch (e) { cv.width = Math.round(side * .707); cv.height = side; const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cv.width, cv.height); }
  }

  /* ================= desenho das prévias (mesma regra do PDF) ================= */
  function paintWm(cv, W) {
    const w = cv.width, h = cv.height, ctx = cv.getContext("2d"), sc = w / PT, a = -W.angle * Math.PI / 180;
    const cy = W.pos === "top" ? .16 : W.pos === "bottom" ? .84 : .5;
    ctx.save(); ctx.globalAlpha = W.op / 100; ctx.translate(w / 2, h * cy); ctx.rotate(a);
    if (W.type === "image" && wmImg) { const iw = Math.min(W.size / 160, 1) * w, ih = iw * wmImg.h / wmImg.w; ctx.drawImage(wmImg.el, -iw / 2, -ih / 2, iw, ih); }
    else if (W.type === "text" && W.text) {
      const size = W.size * sc; ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; const col = CSS_COLORS[W.color] || CSS_COLORS.gray;
      ctx.fillStyle = `rgb(${col})`; ctx.strokeStyle = `rgb(${col})`; ctx.fillText(W.text, 0, 0);
      if (W.box) { const tw = ctx.measureText(W.text).width, pad = size * .3; ctx.lineWidth = Math.max(1, size * .06); ctx.strokeRect(-tw / 2 - pad, -size * .5 - pad * .6, tw + 2 * pad, size + pad * 1.2); }
    }
    ctx.restore();
  }
  const numLabel = (fmt, n, t) => fmt.replace("{n}", n).replace("{t}", t);
  function paintNum(cv, N, n, t) {
    const w = cv.width, h = cv.height, ctx = cv.getContext("2d"), sc = w / PT, size = N.size * sc, m = 28 * sc, txt = numLabel(N.fmt, n, t);
    ctx.save(); ctx.font = `${size}px Helvetica, Arial, sans-serif`; ctx.fillStyle = "#222"; ctx.textBaseline = "alphabetic";
    const tw = ctx.measureText(txt).width, x = N.pos[1] === "c" ? (w - tw) / 2 : N.pos[1] === "l" ? m : w - m - tw, y = N.pos[0] === "t" ? m + size * .8 : h - m;
    ctx.fillText(txt, x, y); ctx.restore();
  }
  C.hooks.zoomOverlay = (cv, p, k, total) => {
    if (prefs.wm.on && !p.lock) paintWm(cv, prefs.wm);
    if (prefs.num.on && !p.lock && !(prefs.num.skip && k === 0)) paintNum(cv, prefs.num, prefs.num.start + k, prefs.num.start + total - 1);
  };

  /* ================= marca d'água ================= */
  const flag = (el, err, msg) => { err.textContent = msg; err.hidden = false; if (el) { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", err.id); el.focus(); } };
  const unflag = (...els) => els.forEach(el => { if (el) { el.removeAttribute("aria-invalid"); } });
  const wd = $("#wmdlg"), W = {};
  ["text", "color", "box", "size", "op", "angle", "pos", "file", "fname", "prev", "err", "sizel", "sizeo", "opo", "textbox", "imgbox"].forEach(k => { W[k] = $("#wm-" + k); });
  const wmType = () => (document.querySelector("input[name=wmtype]:checked") || {}).value || "text";
  function wmRead() { return { on: true, type: wmType(), text: W.text.value.trim(), color: W.color.value, box: W.box.checked, size: +W.size.value, op: +W.op.value, angle: +W.angle.value, pos: W.pos.value }; }
  async function wmPrev() { await pageCanvas(firstPage(), W.prev, 360); paintWm(W.prev, wmRead()); }
  function wmSizeMode() {
    const img = wmType() === "image"; W.textbox.hidden = img; W.imgbox.hidden = !img;
    W.sizel.textContent = img ? "Largura (% da página)" : "Tamanho do texto";
    W.size.min = img ? 10 : 12; W.size.max = img ? 100 : 160; W.size.value = img ? Math.min(100, Math.max(10, Math.round(prefs.wm.type === "image" ? prefs.wm.size : 50))) : (prefs.wm.type === "text" ? prefs.wm.size : 64);
    W.sizeo.textContent = W.size.value + (img ? " %" : " pt");
  }
  $("#wmbtn").addEventListener("click", e => {
    const P = prefs.wm; W.text.value = P.text; W.color.value = P.color; W.box.checked = P.box; W.op.value = P.op; W.angle.value = P.angle; W.pos.value = P.pos; W.err.hidden = true;
    document.querySelector(`input[name=wmtype][value=${P.type}]`).checked = true; wmSizeMode(); if (P.type === "text") W.size.value = P.size; else W.size.value = Math.min(100, P.size);
    W.sizeo.textContent = W.size.value + (wmType() === "image" ? " %" : " pt"); W.opo.textContent = W.op.value + " %"; W.fname.textContent = wmImg ? "Imagem: " + wmImg.name : "";
    openDlg(wd, e.currentTarget); wmPrev();
  });
  document.querySelectorAll("input[name=wmtype]").forEach(r => r.addEventListener("change", () => { wmSizeMode(); wmPrev(); }));
  [W.text, W.color, W.box, W.op, W.angle, W.pos].forEach(el => el.addEventListener("input", () => { W.opo.textContent = W.op.value + " %"; wmPrev(); }));
  W.size.addEventListener("input", () => { W.sizeo.textContent = W.size.value + (wmType() === "image" ? " %" : " pt"); wmPrev(); });
  document.querySelectorAll("#wmdlg .chipbtn").forEach(b => b.addEventListener("click", () => { W.text.value = b.dataset.t; wmPrev(); }));
  W.file.addEventListener("change", async () => {
    const f = W.file.files[0]; if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { W.err.textContent = "Use uma imagem PNG ou JPG."; W.err.hidden = false; return; }
    if (f.size > 5 * 1048576) { W.err.textContent = "Imagem acima de 5 MB. Use uma menor."; W.err.hidden = false; return; }
    const bytes = new Uint8Array(await f.arrayBuffer()), url = URL.createObjectURL(f), el = new Image();
    el.onload = () => { wmImg = { bytes, png: f.type === "image/png", el, w: el.naturalWidth, h: el.naturalHeight, name: f.name }; W.fname.textContent = "Imagem: " + f.name; W.err.hidden = true; wmPrev(); };
    el.onerror = () => { W.err.textContent = "Não consegui abrir essa imagem."; W.err.hidden = false; }; el.src = url;
  });
  $("#wm-form").addEventListener("submit", e => {
    e.preventDefault(); const v = wmRead(); W.err.hidden = true;
    if (v.type === "text") { unflag(W.text, W.file); if (!v.text) { flag(W.text, W.err, "Digite o texto da marca d’água."); return; } if (!LATIN.test(v.text)) { flag(W.text, W.err, "Esta marca aceita apenas letras, números e acentos comuns (sem emojis ou símbolos especiais)."); return; } }
    else if (!wmImg) { flag(W.file, W.err, "Escolha uma imagem PNG ou JPG."); return; }
    Object.assign(prefs.wm, v); savePrefs(); wd.close(); S.exported = false; C.updateUI(); C.render(); say("Marca d’água ativada. Ela entra em todas as páginas ao baixar.");
  });
  $("#wm-off").addEventListener("click", () => { prefs.wm.on = false; savePrefs(); wd.close(); C.updateUI(); say("Marca d’água desativada."); });
  $("#wm-cancel").addEventListener("click", () => wd.close());

  /* ================= numeração ================= */
  const nd = $("#numdlg"), N = { fmt: $("#num-fmt"), pos: $("#num-pos"), size: $("#num-size"), start: $("#num-start"), skip: $("#num-skip"), prev: $("#num-prev"), sizeo: $("#num-sizeo") };
  const numRead = () => ({ on: true, fmt: N.fmt.value, pos: N.pos.value, size: +N.size.value, start: Math.max(1, Math.min(9999, parseInt(N.start.value, 10) || 1)), skip: N.skip.checked });
  async function numPrev() { await pageCanvas(firstPage(), N.prev, 360); const v = numRead(); const t = Math.max(1, S.pages.length) + v.start - 1; if (!(v.skip && true)) paintNum(N.prev, v, v.start, t); else paintNum(N.prev, v, v.start + 1, t); }
  $("#numbtn").addEventListener("click", e => { const P = prefs.num; N.fmt.value = P.fmt; N.pos.value = P.pos; N.size.value = P.size; N.start.value = P.start; N.skip.checked = P.skip; N.sizeo.textContent = P.size + " pt"; openDlg(nd, e.currentTarget); numPrev(); });
  [N.fmt, N.pos, N.start, N.skip].forEach(el => el.addEventListener("input", numPrev)); N.size.addEventListener("input", () => { N.sizeo.textContent = N.size.value + " pt"; numPrev(); });
  $("#num-form").addEventListener("submit", e => { e.preventDefault(); Object.assign(prefs.num, numRead()); savePrefs(); nd.close(); S.exported = false; C.updateUI(); C.render(); say("Numeração ativada. Ela entra em todas as páginas ao baixar."); });
  $("#num-off").addEventListener("click", () => { prefs.num.on = false; savePrefs(); nd.close(); C.updateUI(); say("Numeração desativada."); });
  $("#num-cancel").addEventListener("click", () => nd.close());

  /* ================= comprimir ================= */
  const pcomp = $("#pcomp"); pcomp.value = prefs.comp || "none";
  pcomp.addEventListener("change", () => { prefs.comp = pcomp.value; savePrefs(); C.updateUI(); });

  /* ================= cortar ================= */
  const cd = $("#cropdlg"), CR = { link: $("#crop-link"), prev: $("#crop-prev"), r: { t: $("#crop-t-r"), r: $("#crop-r-r"), b: $("#crop-b-r"), l: $("#crop-l-r") }, o: { t: $("#crop-t-o"), r: $("#crop-r-o"), b: $("#crop-b-o"), l: $("#crop-l-o") } };
  let cropPage = null, cropBase = null;
  const crVals = () => ({ t: +CR.r.t.value / 100, r: +CR.r.r.value / 100, b: +CR.r.b.value / 100, l: +CR.r.l.value / 100 });
  function crShow() { for (const k of "trbl") CR.o[k].textContent = CR.r[k].value + " %"; }
  function crPaint() {
    const cv = CR.prev; if (!cropBase) return; cv.width = cropBase.width; cv.height = cropBase.height; const ctx = cv.getContext("2d"); ctx.drawImage(cropBase, 0, 0);
    const c = crVals(), w = cv.width, h = cv.height; ctx.fillStyle = "rgba(10,8,6,.62)";
    ctx.fillRect(0, 0, w, c.t * h); ctx.fillRect(0, h - c.b * h, w, c.b * h); ctx.fillRect(0, c.t * h, c.l * w, h * (1 - c.t - c.b)); ctx.fillRect(w - c.r * w, c.t * h, c.r * w, h * (1 - c.t - c.b));
    ctx.strokeStyle = "#f0b254"; ctx.lineWidth = 2; ctx.strokeRect(c.l * w, c.t * h, w * (1 - c.l - c.r), h * (1 - c.t - c.b));
  }
  $("#crop").addEventListener("click", async e => {
    const t = targetPages(); if (!t.length) { C.showAlert("Adicione páginas à mesa para cortar."); return; }
    cropPage = t[0]; const sel = S.pages.some(p => S.sel.has(p.id) && !p.lock);
    $("#crop-for").textContent = sel ? `Vale para ${t.length} ${t.length === 1 ? "página selecionada" : "páginas selecionadas"}.` : `Nenhuma página selecionada: vale para todas (${t.length}).`;
    const cur = cropPage.crop ? rotCrop(cropPage.crop, pageRot(cropPage)) : { t: 0, r: 0, b: 0, l: 0 };
    for (const k of "trbl") CR.r[k].value = Math.round(cur[k] * 100); CR.link.checked = !cropPage.crop || (cur.t === cur.r && cur.r === cur.b && cur.b === cur.l); crShow();
    const cv = document.createElement("canvas"); await pageCanvas({ ...cropPage, crop: null, sig: null }, cv, 420); cropBase = cv; crPaint(); openDlg(cd, e.currentTarget);
  });
  for (const k of "trbl") CR.r[k].addEventListener("input", () => { if (CR.link.checked) for (const j of "trbl") CR.r[j].value = CR.r[k].value; crShow(); crPaint(); });
  $("#crop-form").addEventListener("submit", e => {
    e.preventDefault(); const d = crVals(), targets = targetPages(), none = !(d.t || d.r || d.b || d.l);
    if (d.t + d.b >= .9 || d.l + d.r >= .9) { C.showAlert("Corte grande demais: deixe pelo menos 10% de cada dimensão da página."); cd.close(); return; }
    mutate(none ? "Remover corte" : "Cortar páginas", () => targets.forEach(p => { if (none) delete p.crop; else p.crop = rotCrop(d, (360 - pageRot(p)) % 360); }), none ? "Corte removido." : `Corte aplicado em ${targets.length} ${targets.length === 1 ? "página" : "páginas"}.`);
    cd.close();
  });
  $("#crop-off").addEventListener("click", () => { const targets = targetPages(); mutate("Remover corte", () => targets.forEach(p => { delete p.crop; }), "Corte removido."); cd.close(); });
  $("#crop-cancel").addEventListener("click", () => cd.close());

  /* ================= assinar ================= */
  const sd = $("#signdlg"), pad = $("#sg-pad"), pctx = pad.getContext("2d"), SG = { err: $("#sg-err") };
  let drawn = false, drawing = false, ghost = $("#sg-ghost"), D = null, signPage = null, stagePX = 0;
  const trimToPng = cv => {   // recorta o espaço vazio e devolve { url, w, h }
    const ctx = cv.getContext("2d"), w = cv.width, h = cv.height, d = ctx.getImageData(0, 0, w, h).data; let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null; const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    const o = document.createElement("canvas"); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1; o.getContext("2d").drawImage(cv, x0, y0, o.width, o.height, 0, 0, o.width, o.height); return { url: o.toDataURL("image/png"), w: o.width, h: o.height };
  };
  function padReset() { pctx.clearRect(0, 0, pad.width, pad.height); drawn = false; pctx.lineCap = "round"; pctx.lineJoin = "round"; pctx.lineWidth = 4; pctx.strokeStyle = $("#sg-ink").value; }
  const padPos = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.addEventListener("pointerdown", e => { drawing = true; pad.setPointerCapture(e.pointerId); const [x, y] = padPos(e); pctx.strokeStyle = $("#sg-ink").value; pctx.beginPath(); pctx.moveTo(x, y); pctx.lineTo(x + .1, y + .1); pctx.stroke(); drawn = true; e.preventDefault(); });
  pad.addEventListener("pointermove", e => { if (!drawing) return; const [x, y] = padPos(e); pctx.lineTo(x, y); pctx.stroke(); });
  ["pointerup", "pointercancel"].forEach(t => pad.addEventListener(t, () => { drawing = false; }));
  $("#sg-clear").addEventListener("click", padReset);
  const sgMode = () => (document.querySelector("input[name=sgmode]:checked") || {}).value;
  function sgModeShow() { const m = sgMode(); $("#sg-draw").hidden = m !== "draw"; $("#sg-type").hidden = m !== "type"; $("#sg-img").hidden = m !== "img"; SG.err.hidden = true; if (m === "type") typePrev(); }
  document.querySelectorAll("input[name=sgmode]").forEach(r => r.addEventListener("change", sgModeShow));
  function typePrev() {
    const cv = $("#sg-typeprev"), ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height); const t = $("#sg-name").value.trim(); if (!t) return;
    let size = 84; ctx.font = `italic ${size}px "Snell Roundhand","Segoe Script","Brush Script MT","Lucida Handwriting","Apple Chancery",cursive`;
    while (ctx.measureText(t).width > cv.width - 40 && size > 24) { size -= 4; ctx.font = ctx.font.replace(/\d+px/, size + "px"); }
    ctx.fillStyle = "#1d3fbf"; ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillText(t, cv.width / 2, cv.height / 2);
  }
  $("#sg-name").addEventListener("input", typePrev);
  let imgSig = null;
  $("#sg-file").addEventListener("change", () => {
    const f = $("#sg-file").files[0]; if (!f) return; const el = new Image(), url = URL.createObjectURL(f);
    el.onload = () => { const cv = $("#sg-imgprev"), ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height); const s = Math.min(cv.width / el.naturalWidth, cv.height / el.naturalHeight, 1), w = el.naturalWidth * s, h = el.naturalHeight * s; ctx.drawImage(el, (cv.width - w) / 2, (cv.height - h) / 2, w, h); imgSig = el; SG.err.hidden = true; };
    el.onerror = () => { SG.err.textContent = "Não consegui abrir essa imagem."; SG.err.hidden = false; }; el.src = url;
  });
  function whiteToAlpha(cv) {   // foto de assinatura em papel branco: o branco vira transparente
    const ctx = cv.getContext("2d"), im = ctx.getImageData(0, 0, cv.width, cv.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) { const m = Math.min(d[i], d[i + 1], d[i + 2]); if (m > 235) d[i + 3] = 0; else if (m > 190) d[i + 3] = Math.round(d[i + 3] * (235 - m) / 45); }
    ctx.putImageData(im, 0, 0);
  }
  function makeSig() {
    SG.err.hidden = true; unflag(pad, $("#sg-name"), $("#sg-file")); const m = sgMode(); let src = null;
    if (m === "draw") { if (!drawn) { flag(pad, SG.err, "Desenhe a assinatura na área acima."); return null; } src = pad; }
    else if (m === "type") { if (!$("#sg-name").value.trim()) { flag($("#sg-name"), SG.err, "Digite seu nome."); return null; } src = $("#sg-typeprev"); }
    else { if (!imgSig) { flag($("#sg-file"), SG.err, "Escolha uma imagem."); return null; } const cv = document.createElement("canvas"), k = Math.min(1, 900 / Math.max(imgSig.naturalWidth, imgSig.naturalHeight)); cv.width = Math.round(imgSig.naturalWidth * k); cv.height = Math.round(imgSig.naturalHeight * k); cv.getContext("2d").drawImage(imgSig, 0, 0, cv.width, cv.height); whiteToAlpha(cv); src = cv; }
    const t = trimToPng(src); if (!t) { SG.err.textContent = "Não encontrei traços na assinatura. Use uma imagem com fundo claro e traço escuro."; SG.err.hidden = false; return null; }
    const id = sigId(), img = new Image(); img.src = t.url; const rec = { id, url: t.url, img, w: t.w, h: t.h }; S.sigs.set(id, rec); S.curSig = id; return rec;
  }
  function placePage() { return signPage && byId(signPage.id) ? signPage : null; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  async function placeLoad() {
    const p = placePage(); if (!p) return; const k = idx(p.id), sg = S.sigs.get(S.curSig); if (!sg) return;
    $("#sg-where").textContent = `Página ${k + 1} de ${S.pages.length}${p.sig ? " — já tem assinatura" : ""}`;
    $("#sg-prev").disabled = !S.pages.slice(0, k).some(q => !q.lock); $("#sg-next").disabled = !S.pages.slice(k + 1).some(q => !q.lock);
    const cur = p.sig && S.sigs.get(p.sig.s) ? p.sig : null; D = cur ? { x: cur.x, y: cur.y, w: cur.w } : (D ? { ...D } : { x: .75, y: .86, w: .26 });
    const cv = $("#sg-page"), side = Math.min(460, Math.round(innerWidth * .8)); await pageCanvas({ ...p, sig: null, crop: null }, cv, side); stagePX = cv.width;
    ghost.src = sg.url; $("#sg-rm").disabled = !p.sig; placeSync();
  }
  function placeSync() {
    const p = placePage(), sg = S.sigs.get(S.curSig); if (!p || !sg || !D) return; const r = pageRot(p), cv = $("#sg-page"), [dx, dy] = baseToDisp(D.x, D.y, r), bw = r % 180 ? cv.height : cv.width, wpx = D.w * bw, hpx = wpx * sg.h / sg.w;
    const st = $("#sg-stage"), sx = cv.clientWidth / cv.width; st.style.width = cv.clientWidth + "px";
    Object.assign(ghost.style, { width: wpx * sx + "px", height: hpx * sx + "px", left: dx * cv.clientWidth + "px", top: dy * cv.clientHeight + "px", transform: `translate(-50%,-50%) rotate(${r}deg)` });
    $("#sg-x").value = Math.round(D.x * 100); $("#sg-y").value = Math.round(D.y * 100); $("#sg-w").value = Math.round(D.w * 100); $("#sg-xo").textContent = $("#sg-x").value + " %"; $("#sg-yo").textContent = $("#sg-y").value + " %"; $("#sg-wo").textContent = $("#sg-w").value + " %";
  }
  ["x", "y", "w"].forEach(k => $("#sg-" + k).addEventListener("input", () => { D[k] = +$("#sg-" + k).value / 100; D.x = clamp(D.x, 0, 1); D.y = clamp(D.y, 0, 1); D.w = clamp(D.w, .05, .7); placeSync(); }));
  let drag = null;
  ghost.addEventListener("pointerdown", e => { drag = { id: e.pointerId }; ghost.setPointerCapture(e.pointerId); e.preventDefault(); });
  ghost.addEventListener("pointermove", e => {
    if (!drag) return; const p = placePage(), cv = $("#sg-page"), r = cv.getBoundingClientRect(); if (!p) return;
    const fx = clamp((e.clientX - r.left) / r.width, 0, 1), fy = clamp((e.clientY - r.top) / r.height, 0, 1), [bx, by] = dispToBase(fx, fy, pageRot(p)); D.x = bx; D.y = by; placeSync();
  });
  ["pointerup", "pointercancel"].forEach(t => ghost.addEventListener(t, () => { drag = null; }));
  ghost.addEventListener("keydown", e => {
    const st = e.shiftKey ? .05 : .01, p = placePage(); if (!p) return; let used = true; const [dx, dy] = baseToDisp(D.x, D.y, pageRot(p));
    let nx = dx, ny = dy; if (e.key === "ArrowLeft") nx -= st; else if (e.key === "ArrowRight") nx += st; else if (e.key === "ArrowUp") ny -= st; else if (e.key === "ArrowDown") ny += st;
    else if (e.key === "+" || e.key === "=") D.w = clamp(D.w + .01, .05, .7); else if (e.key === "-") D.w = clamp(D.w - .01, .05, .7); else used = false;
    if (!used) return; e.preventDefault(); if (nx !== dx || ny !== dy) { const [bx, by] = dispToBase(clamp(nx, 0, 1), clamp(ny, 0, 1), pageRot(p)); D.x = bx; D.y = by; } placeSync();
  });
  const sigData = () => ({ s: S.curSig, x: +D.x.toFixed(4), y: +D.y.toFixed(4), w: +D.w.toFixed(4) });
  $("#sg-apply").addEventListener("click", () => { const p = placePage(); if (!p) return; mutate("Assinar", () => { p.sig = sigData(); }, `Assinatura aplicada na página ${idx(p.id) + 1}.`); $("#sg-rm").disabled = false; $("#sg-where").textContent = `Página ${idx(p.id) + 1} de ${S.pages.length} — já tem assinatura`; });
  $("#sg-all").addEventListener("click", () => { const t = S.pages.filter(q => !q.lock); mutate("Assinar todas", () => t.forEach(q => { q.sig = sigData(); }), `Assinatura aplicada em ${t.length} ${t.length === 1 ? "página" : "páginas"}.`); });
  $("#sg-rm").addEventListener("click", () => { const p = placePage(); if (!p || !p.sig) return; mutate("Remover assinatura", () => { delete p.sig; }, "Assinatura removida desta página."); $("#sg-rm").disabled = true; $("#sg-where").textContent = `Página ${idx(p.id) + 1} de ${S.pages.length}`; });
  const nav = dir => { const k = idx(signPage.id); const list = dir < 0 ? S.pages.slice(0, k).reverse() : S.pages.slice(k + 1); const q = list.find(x => !x.lock); if (q) { signPage = q; placeLoad(); } };
  $("#sg-prev").addEventListener("click", () => nav(-1)); $("#sg-next").addEventListener("click", () => nav(1));
  $("#sg-done").addEventListener("click", () => sd.close());
  $("#sg-cancel").addEventListener("click", () => sd.close());
  $("#sg-new").addEventListener("click", () => { $("#sg-make").hidden = false; $("#sg-place").hidden = true; padReset(); sgModeShow(); });
  $("#sg-use").addEventListener("click", async () => { const rec = makeSig(); if (!rec) return; $("#sg-make").hidden = true; $("#sg-place").hidden = false; if (!rec.img.complete) await new Promise(r => { rec.img.onload = r; }); placeLoad(); $("#sg-x").focus(); });
  $("#sign").addEventListener("click", e => {
    const first = S.pages.find(p => S.sel.has(p.id) && !p.lock) || S.pages.find(p => !p.lock); if (!first) { C.showAlert("Adicione páginas à mesa (e desbloqueie os PDFs com senha) para assinar."); return; }
    signPage = first; D = null; openDlg(sd, e.currentTarget);
    if (S.curSig && S.sigs.get(S.curSig)) { $("#sg-make").hidden = true; $("#sg-place").hidden = false; placeLoad(); }
    else { $("#sg-make").hidden = false; $("#sg-place").hidden = true; padReset(); sgModeShow(); }
  });
  sd.addEventListener("close", () => { drag = null; });
  window.addEventListener("resize", () => { if (sd.open && !$("#sg-place").hidden) placeSync(); });

  document.querySelectorAll(".xdlg input[type=range]").forEach(r => { const upd = () => setTimeout(() => { const o = document.querySelector(`label[for="${r.id}"] output`); if (o) r.setAttribute("aria-valuetext", o.textContent); }, 0); r.addEventListener("input", upd); upd(); });
  let kb = null; ghost.addEventListener("keyup", () => { clearTimeout(kb); kb = setTimeout(() => say(`Assinatura em ${$("#sg-x").value}% na horizontal, ${$("#sg-y").value}% na vertical, tamanho ${$("#sg-w").value}%.`), 400); });

  /* ================= estado dos botões ================= */
  const short = (t, n) => t.length > n ? t.slice(0, n - 1) + "…" : t;
  const POSN = { bc: "rodapé centro", br: "rodapé direita", bl: "rodapé esquerda", tc: "topo centro", tr: "topo direita", tl: "topo esquerda" };
  C.hooks.resetPrefs = () => { Object.assign(prefs.wm, { on: false, type: "text", text: "CONFIDENCIAL", color: "gray", box: false, size: 64, op: 25, angle: 45, pos: "center" }); Object.assign(prefs.num, { on: false, fmt: "Página {n} de {t}", pos: "bc", size: 10, start: 1, skip: false }); wmImg = null; $("#pcomp").value = "none"; C.updateUI(); };
  $("#fxjump").addEventListener("click", () => { const x = $("#export"); x.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth", block: "start" }); const g = $("#pcomp"); setTimeout(() => g.focus({ preventScroll: true }), 350); });
  C.hooks.ui = () => {
    const any = S.pages.some(p => !p.lock);
    $("#sign").disabled = S.busy || !any; $("#crop").disabled = S.busy || !any;
    for (const [id, on, label] of [["wm", prefs.wm.on, "ligada"], ["num", prefs.num.on, "ligada"]]) { $("#" + id + (id === "wm" ? "btn" : "btn")).setAttribute("aria-pressed", on); }
    const sel = S.pages.filter(p => S.sel.has(p.id) && !p.lock), tg = sel.length ? `${sel.length} selec.` : "todas";
    $("#crop").textContent = `Cortar (${tg})`; $("#crop").setAttribute("aria-label", sel.length ? `Cortar bordas de ${sel.length} ${sel.length === 1 ? "página selecionada" : "páginas selecionadas"}` : "Cortar bordas de todas as páginas");
    const sp = S.pages.find(p => S.sel.has(p.id) && !p.lock) || S.pages.find(p => !p.lock); $("#sign").textContent = sp ? `Assinar (pág. ${S.pages.indexOf(sp) + 1})` : "Assinar"; $("#sign").setAttribute("aria-label", sp ? `Assinar a página ${S.pages.indexOf(sp) + 1}` : "Assinar página");
    $("#wmstate").textContent = prefs.wm.on ? "· " + (prefs.wm.type === "image" ? "imagem" : short(prefs.wm.text, 14)) : ""; $("#numstate").textContent = prefs.num.on ? "· " + POSN[prefs.num.pos] : "";
    const bits = []; if (prefs.comp && prefs.comp !== "none") bits.push("compressão " + { light: "leve", medium: "média", strong: "forte" }[prefs.comp]); if (prefs.wm.on) bits.push("marca d’água"); if (prefs.num.on) bits.push("numeração");
    const nc = S.pages.filter(p => p.crop).length, ns = S.pages.filter(p => p.sig).length; if (nc) bits.push(`corte em ${nc} pág.`); if (ns) bits.push(`assinatura em ${ns} pág.`);
    const fs = $("#fxsum"); fs.hidden = !bits.length; fs.textContent = bits.length ? "Será aplicado ao baixar: " + bits.join(", ") + "." : "";
    $("#pcomp").disabled = S.busy; $("#wmbtn").disabled = S.busy; $("#numbtn").disabled = S.busy;
  };

  /* ================= aplicar no PDF (gancho de exportação) ================= */
  const fonts = new WeakMap();
  async function font(out, lib, bold) { let m = fonts.get(out); if (!m) { m = {}; fonts.set(out, m); } const k = bold ? "b" : "r"; if (!m[k]) m[k] = await out.embedFont(bold ? lib.StandardFonts.HelveticaBold : lib.StandardFonts.Helvetica); return m[k]; }
  const embedCache = new WeakMap();
  async function embedPng(out, key, loader) { let m = embedCache.get(out); if (!m) { m = new Map(); embedCache.set(out, m); } if (!m.has(key)) m.set(key, await loader()); return m.get(key); }
  /* mapeia coordenadas da página como aparece (origem embaixo à esquerda, y para cima) para o espaço bruto da página, dado o giro r (horário) */
  function mapper(box, r) {
    const { x: x0, y: y0, width: Wr, height: Hr } = box; r = ((r % 360) + 360) % 360;
    const dims = r % 180 ? [Hr, Wr] : [Wr, Hr];
    const f = r === 0 ? (X, Y) => [X, Y] : r === 90 ? (X, Y) => [Wr - Y, X] : r === 180 ? (X, Y) => [Wr - X, Hr - Y] : (X, Y) => [Y, Hr - X];
    return { dims, map: (X, Y) => { const [ux, uy] = f(X, Y); return { x: x0 + ux, y: y0 + uy }; } };
  }
  const rad = d => d * Math.PI / 180, rot2 = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

  C.hooks.decorate = async ({ out, page, p, meta, k, total, lib }) => {
    if (!page) return; const { degrees, rgb } = lib;
    /* 1) assinatura (antes do corte: a posição vale para a página inteira) */
    if (p.sig) {
      const sg = S.sigs.get(p.sig.s);
      if (sg) {
        const emb = await embedPng(out, "sig:" + sg.id, async () => { const b = await (await fetch(sg.url)).arrayBuffer(); return out.embedPng(new Uint8Array(b)); });
        const box = page.getMediaBox(), mapRot = meta.kind === "pdf" ? meta.native : 0, M = mapper(box, mapRot), [Wd, Hd] = M.dims;
        const theta = meta.kind === "pdf" ? 0 : -(meta.r || 0);   // páginas "planas": o conteúdo já foi girado, a assinatura gira junto
        const [bx, by] = meta.kind === "pdf" ? [p.sig.x, p.sig.y] : baseToDisp(p.sig.x, p.sig.y, meta.r || 0);
        const baseW = meta.kind === "pdf" ? Wd : ((meta.r || 0) % 180 ? Hd : Wd), w = p.sig.w * baseW, h = w * sg.h / sg.w;
        const cx = bx * Wd, cy = (1 - by) * Hd, a = rad(theta), [ox, oy] = rot2(-w / 2, -h / 2, a), pt = M.map(cx + ox, cy + oy);
        page.drawImage(emb, { x: pt.x, y: pt.y, width: w, height: h, rotate: degrees(theta + mapRot) });
      }
    }
    /* 2) corte */
    if (p.crop) {
      const c = meta.kind === "pdf" ? rotCrop(p.crop, (360 - meta.native) % 360) : rotCrop(p.crop, meta.r || 0), b = page.getMediaBox();
      const nx = b.x + c.l * b.width, ny = b.y + c.b * b.height, nw = b.width * (1 - c.l - c.r), nh = b.height * (1 - c.t - c.b);
      page.setMediaBox(nx, ny, nw, nh); page.setCropBox(nx, ny, nw, nh);
    }
    /* 3) marca d'água e 4) numeração: sempre na vertical da página como aparece */
    const total2 = meta.kind === "pdf" ? meta.total : 0, M = mapper(page.getMediaBox(), total2), [Wd, Hd] = M.dims;
    const WM = prefs.wm;
    if (WM.on) {
      const cyF = WM.pos === "top" ? .84 : WM.pos === "bottom" ? .16 : .5, op = WM.op / 100, ang = WM.angle, a = rad(ang);
      if (WM.type === "image" && wmImg) {
        const emb = await embedPng(out, "wm:img", () => wmImg.png ? out.embedPng(wmImg.bytes) : out.embedJpg(wmImg.bytes)), w = Math.min(WM.size / 100, 1) * Wd, h = w * wmImg.h / wmImg.w, [ox, oy] = rot2(-w / 2, -h / 2, a), pt = M.map(Wd / 2 + ox, Hd * cyF + oy);
        page.drawImage(emb, { x: pt.x, y: pt.y, width: w, height: h, opacity: op, rotate: degrees(ang + total2) });
      } else if (WM.type === "text" && WM.text) {
        const f = await font(out, lib, true), size = WM.size, tw = f.widthOfTextAtSize(WM.text, size), col = COLORS[WM.color] || COLORS.gray, c = rgb(col[0], col[1], col[2]);
        const [ox, oy] = rot2(-tw / 2, -size * .33, a), pt = M.map(Wd / 2 + ox, Hd * cyF + oy);
        page.drawText(WM.text, { x: pt.x, y: pt.y, size, font: f, color: c, opacity: op, rotate: degrees(ang + total2) });
        if (WM.box) {
          const pad = size * .3, [rx, ry] = rot2(-tw / 2 - pad, -size * .5 - pad * .6, a), q = M.map(Wd / 2 + rx, Hd * cyF + ry);
          page.drawRectangle({ x: q.x, y: q.y, width: tw + 2 * pad, height: size + pad * 1.2, borderColor: c, borderWidth: Math.max(1, size * .06), borderOpacity: op, rotate: degrees(ang + total2) });
        }
      }
    }
    const NU = prefs.num;
    if (NU.on && !(NU.skip && k === 0)) {
      const f = await font(out, lib, false), txt = numLabel(NU.fmt, NU.start + k, NU.start + total - 1), size = NU.size, tw = f.widthOfTextAtSize(txt, size), m = 28;
      const X = NU.pos[1] === "c" ? (Wd - tw) / 2 : NU.pos[1] === "l" ? m : Wd - m - tw, Y = NU.pos[0] === "t" ? Hd - m - size * .8 : m, pt = M.map(X, Y);
      page.drawText(txt, { x: pt.x, y: pt.y, size, font: f, color: rgb(.13, .13, .13), rotate: degrees(total2) });
    }
  };

  C.hooks.ui();
})();
