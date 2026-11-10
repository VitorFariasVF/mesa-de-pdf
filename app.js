/* Mesa de PDF — juntar, separar, organizar e converter fotos em PDF, tudo no navegador.
   Bibliotecas locais (vendor/): pdf-lib (gerar) e pdf.js (miniaturas). Nada é enviado a servidor. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MB = 1048576, T = window.VFTool;
  const coarse = matchMedia("(pointer:coarse)").matches || innerWidth < 700;
  const LIM = { file: 50 * MB, total: 150 * MB, pages: 200, photos: coarse ? 30 : 60 };
  const reduce = () => matchMedia("(prefers-reduced-motion:reduce)").matches;
  const prefs = Object.assign({ size: "a4", margin: "small", quality: "reduced", comp: "none" }, T.get("prefs", {}));
  const savePrefs = () => T.set("prefs", prefs);
  const fmt = b => b >= MB ? (b / MB).toFixed(b >= 10 * MB ? 0 : 1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";

  /* ---------- Estado ---------- */
  const S = { sigs: new Map(), files: new Map(), pages: [], sel: new Set(), undo: [], redo: [], nid: 1, intent: "", reorder: false, busy: false, anchor: null, focusId: null, exported: false, cancel: false };
  let totalBytes = 0;
  const core = { hooks: {} };   // ganchos para extras.js (assinar, cortar, marca d'água, numeração)
  const byId = id => S.pages.find(p => p.id === id);
  const idx = id => S.pages.findIndex(p => p.id === id);
  const fileOf = p => S.files.get(p.f);
  const clone = a => a.map(p => ({ ...p }));

  /* ---------- Avisos ---------- */
  const live = $("#live");
  const say = m => { live.textContent = ""; setTimeout(() => { live.textContent = m; }, 30); };
  const alertBox = $("#alert");
  const showAlert = msgs => { alertBox.innerHTML = [].concat(msgs).map(m => `<p>${esc(m)}</p>`).join("") + '<button class="link" type="button" id="alert-x">Dispensar</button>'; alertBox.hidden = false; $("#alert-x").onclick = () => { alertBox.hidden = true; }; };
  const hideAlert = () => { alertBox.hidden = true; };

  /* ---------- Bibliotecas sob demanda ---------- */
  const loadScript = src => new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("Falha ao carregar " + src)); document.head.appendChild(s); });
  let libs = null;
  let sharedWorker = null;   // um único worker do pdf.js: o script só é baixado uma vez (e funciona offline depois)
  const loadLibs = () => libs || (libs = Promise.all([loadScript("vendor/pdf-lib.min.js"), loadScript("vendor/pdf.min.js")]).then(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; sharedWorker = new window.pdfjsLib.PDFWorker({ name: "mesa" }); }));

  /* ---------- Entrada de arquivos ---------- */
  const isPdf = f => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
  const isImg = f => /^image\/(jpeg|png|webp|gif|bmp|avif)$/i.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name) || isHeic(f);

  function busy(on, msg) {
    S.busy = on; document.body.setAttribute("aria-busy", on);
    $("#progwrap").hidden = !on; $("#prog").removeAttribute("value"); if (on) say(msg || "Lendo os arquivos"); else $("#prog").value = 0;
    $("#cancel").hidden = true;
  }

  const isPasswordErr = e => !!e && (e.name === "PasswordException" || /password/i.test(e.message || ""));
  /* Registra um PDF já aberto na mesa. Devolve a primeira página criada (com .count) ou null. */
  function addPdf({ id, f, bytes, doc, errors }) {
    if (doc.numPages > LIM.pages) { errors.push(`“${f.name}” tem ${doc.numPages} páginas, acima do limite de ${LIM.pages} por PDF. Separe em partes menores e tente de novo.`); doc.destroy(); return null; }
    S.files.set(id, { id, name: f.name, kind: "pdf", size: f.size, bytes, doc, n: doc.numPages });
    let first = null;
    for (let i = 0; i < doc.numPages; i++) { const p = { id: "p" + S.nid++, f: id, i, r: 0 }; S.pages.push(p); first = first || p; }
    first.count = doc.numPages; return first;
  }
  /* PDF com senha: entra na mesa como uma página-cadeado até ser desbloqueado */
  function addLocked({ id, f, bytes }) {
    S.files.set(id, { id, name: f.name, kind: "pdf", size: f.size, bytes, doc: null, n: 1, locked: true });
    const p = { id: "p" + S.nid++, f: id, i: 0, r: 0, lock: true }; S.pages.push(p); totalBytes += f.size; p.count = 1; return p;
  }
  const lockedCount = pages => pages.filter(p => p.lock).length;

  /* ---------- Desbloquear PDF com senha (modal) ---------- */
  const udlg = $("#unlock"); let unlockFor = null, unlockOpener = null;
  function openUnlock(pageId, opener) {
    const p = byId(pageId); if (!p || !p.lock) return; const f = fileOf(p); unlockFor = f.id; unlockOpener = opener || null;
    $("#unlock-name").textContent = f.name; const input = $("#unlock-pw");
    input.value = ""; input.type = "password"; input.removeAttribute("aria-invalid"); $("#unlock-show").checked = false;
    $("#unlock-err").hidden = true; $("#unlock-err").textContent = ""; $("#unlock-go").disabled = false; $("#unlock-go").textContent = "Desbloquear";
    udlg.showModal(); input.focus();
  }
  function unlockFail(m) { const input = $("#unlock-pw"); $("#unlock-err").textContent = m; $("#unlock-err").hidden = false; input.setAttribute("aria-invalid", "true"); input.focus(); input.select(); }
  async function unlockSubmit(e) {
    e.preventDefault(); const f = S.files.get(unlockFor), go = $("#unlock-go"); if (!f || go.disabled) return;
    const pw = $("#unlock-pw").value; if (!pw) { unlockFail("Digite a senha do PDF."); return; }
    go.disabled = true; go.textContent = "Verificando…"; $("#unlock-err").hidden = true; $("#unlock-pw").removeAttribute("aria-invalid");
    try {
      await loadLibs();
      const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(f.bytes.slice(0)), password: pw, worker: sharedWorker }).promise;
      if (doc.numPages > LIM.pages) { doc.destroy(); unlockFail(`Este PDF tem ${doc.numPages} páginas, acima do limite de ${LIM.pages}.`); }
      else { finishUnlock(f, doc, pw); }
    } catch (x) {
      if (isPasswordErr(x)) unlockFail("Senha incorreta. Confira maiúsculas e minúsculas e tente de novo.");
      else unlockFail("Não consegui abrir este PDF com essa senha. O arquivo pode estar danificado.");
    }
    go.disabled = false; go.textContent = "Desbloquear";
  }
  /* Troca cada página-cadeado do arquivo pelas páginas reais, na mesma posição */
  function finishUnlock(f, doc, pw) {
    snapshot("Desbloquear PDF"); S.redo = []; S.exported = false;
    f.doc = doc; f.n = doc.numPages; f.locked = false; f.password = pw;
    const out = []; let first = null;
    for (const p of S.pages) {
      if (p.lock && p.f === f.id) { S.sel.delete(p.id); for (let i = 0; i < doc.numPages; i++) { const q = { id: "p" + S.nid++, f: f.id, i, r: p.r }; out.push(q); first = first || q; } }
      else out.push(p);
    }
    S.pages = out; S.focusId = first ? first.id : S.focusId; unlockFor = null; udlg.close();
    const h = $("#hint"); h.textContent = `“${f.name}” desbloqueado. Ao baixar, as páginas dele vão como imagem (o texto deixa de ser selecionável).`; h.hidden = false;
    render(); say(`“${f.name}” desbloqueado. ${doc.numPages} ${n1(doc.numPages, "página", "páginas")}.`);
    const b = first && $(`.sel[data-id="${first.id}"]`); if (b) b.focus();
  }
  $("#unlock-form").addEventListener("submit", unlockSubmit);
  $("#unlock-show").addEventListener("change", e => { $("#unlock-pw").type = e.target.checked ? "text" : "password"; });
  $("#unlock-pw").addEventListener("input", () => { $("#unlock-err").hidden = true; $("#unlock-pw").removeAttribute("aria-invalid"); });
  $("#unlock-cancel").addEventListener("click", () => udlg.close());
  $("#unlock-remove").addEventListener("click", () => {
    const id = unlockFor; udlg.close(); if (!id) return;
    mutate("Remover PDF bloqueado", () => { S.pages = S.pages.filter(p => !(p.lock && p.f === id)); pruneSel(); }, "PDF bloqueado removido da mesa.");
  });
  udlg.addEventListener("close", () => { if (unlockOpener && unlockOpener.isConnected) unlockOpener.focus(); unlockOpener = null; });

  async function ingest(list) {
    list = [...list]; if (!list.length) return;
    if (S.busy) { showAlert("Aguarde: ainda estou lendo os arquivos anteriores."); return; }
    hideAlert();
    const errors = []; busy(true, "Lendo os arquivos");
    snapshot("Adicionar arquivos");
    let added = 0, firstNew = null, photoCount = S.pages.filter(p => !p.blank && fileOf(p).kind === "img").length;
    try {
      await loadLibs();
      for (const f of list) {
        if (isHeic(f)) { errors.push(`“${f.name}”: fotos HEIC do iPhone não abrem aqui. Converta para JPG (em Ajustes › Câmera › Formatos, escolha “Mais compatível”) e tente de novo.`); continue; }
        if (!isPdf(f) && !isImg(f)) { errors.push(`“${f.name}” não é PDF nem foto (JPG, PNG ou WebP).`); continue; }
        if (f.size > LIM.file) { errors.push(`“${f.name}” tem ${fmt(f.size)}, acima do limite de ${fmt(LIM.file)}. Divida o arquivo em partes menores e tente de novo.`); continue; }
        if (totalBytes + f.size > LIM.total) { errors.push(`“${f.name}” passaria do limite de ${fmt(LIM.total)} no total. Exporte o que já está na mesa e comece de novo.`); continue; }
        const id = "f" + S.nid++; let lockedBytes = null;
        try {
          if (isPdf(f)) {
            const bytes = await f.arrayBuffer(); lockedBytes = bytes;
            const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), worker: sharedWorker }).promise;
            const r = addPdf({ id, f, bytes, doc, errors });
            if (!r) continue; firstNew = firstNew || r; added += r.count;
          } else {
            if (photoCount >= LIM.photos) { errors.push(`Limite de ${LIM.photos} fotos neste aparelho. “${f.name}” e as seguintes ficaram de fora.`); break; }
            const bmp = await createImageBitmap(f); const w = bmp.width, h = bmp.height; bmp.close();
            S.files.set(id, { id, name: f.name, kind: "img", size: f.size, file: f, w, h, n: 1 });
            const p = { id: "p" + S.nid++, f: id, i: 0, r: 0 }; S.pages.push(p); firstNew = firstNew || p; added++; photoCount++;
          }
          totalBytes += f.size;
        } catch (e) {
          if (isPasswordErr(e) && lockedBytes) { const r = addLocked({ id, f, bytes: lockedBytes }); firstNew = firstNew || r; added++; continue; }
          else if (isPdf(f)) errors.push(`Não consegui abrir “${f.name}”. O arquivo pode estar danificado.`);
          else errors.push(`Não consegui abrir a foto “${f.name}”. Tente salvá-la como JPG ou PNG.`);
        }
      }
    } catch (e) { errors.push("Não consegui carregar as bibliotecas do PDF. Confira a conexão e recarregue a página."); }
    busy(false);
    if (!added) { S.undo.pop(); } else { S.redo = []; S.exported = false; S.focusId = firstNew.id; }
    if (errors.length) showAlert(errors);
    render();
    if (added) {
      const lk = lockedCount(S.pages); if (lk) { const h = $("#hint"); h.textContent = lk === 1 ? "Um PDF tem senha: toque nele (cadeado) para desbloquear." : `${lk} PDFs têm senha: toque em cada cadeado para desbloquear.`; h.hidden = false; }
      say(`${added} ${added === 1 ? "página adicionada" : "páginas adicionadas"}. ${S.pages.length} na mesa.`);
      const b = $(`.sel[data-id="${firstNew.id}"]`); if (b) b.focus({ preventScroll: false });
      applyIntent();
    }
  }

  function applyIntent() {
    const i = S.intent; S.intent = ""; const h = $("#hint");
    h.hidden = true;
    if (i === "split") { setWhat("range"); h.textContent = "Para separar: digite as páginas que quer manter em “Intervalo” (ex.: 1-3, 5) ou selecione páginas e escolha “Só as selecionadas”. Depois baixe o PDF."; h.hidden = false; $("#range").focus(); }
    else if (i === "merge") { h.textContent = "Para juntar: adicione mais arquivos, arraste as páginas para ordenar e baixe o PDF."; h.hidden = false; }
    else if (i === "photos") { h.textContent = "Fotos em PDF: ajuste tamanho da página, margem e qualidade no painel Exportar. Arraste para ordenar."; h.hidden = false; }
  }

  /* ---------- Histórico ---------- */
  function snapshot(label) { S.undo.push({ pages: clone(S.pages), label }); if (S.undo.length > 60) S.undo.shift(); }
  function mutate(label, fn, msg) { snapshot(label); S.redo = []; S.exported = false; fn(); render(); if (msg) say(msg); }
  function doUndo() {
    const h = S.undo.pop(); if (!h) return;
    S.redo.push({ pages: clone(S.pages), label: h.label }); S.pages = h.pages; pruneSel(); render(); say("Desfeito: " + h.label.toLowerCase() + ".");
  }
  function doRedo() {
    const h = S.redo.pop(); if (!h) return;
    S.undo.push({ pages: clone(S.pages), label: h.label }); S.pages = h.pages; pruneSel(); render(); say("Refeito: " + h.label.toLowerCase() + ".");
  }
  const pruneSel = () => { const ids = new Set(S.pages.map(p => p.id)); S.sel.forEach(id => { if (!ids.has(id)) S.sel.delete(id); }); if (!ids.has(S.focusId)) S.focusId = S.pages[0] ? S.pages[0].id : null; };

  /* ---------- Ações nas páginas ---------- */
  const selIds = () => S.pages.filter(p => S.sel.has(p.id)).map(p => p.id);
  const targets = () => { const s = selIds(); return s.length ? s : (S.focusId && byId(S.focusId) ? [S.focusId] : []); };
  const n1 = (n, a, b) => n === 1 ? a : b;

  function rotateSel() { const t = selIds(); if (!t.length) return; mutate("Girar páginas", () => t.forEach(id => { const p = byId(id); p.r = (p.r + 90) % 360; }), `${t.length} ${n1(t.length, "página girada", "páginas giradas")} 90° para a direita.`); }
  function deleteSel(ids) {
    const t = ids || selIds(); if (!t.length) return;
    const first = Math.min(...t.map(idx));
    mutate("Excluir páginas", () => { S.pages = S.pages.filter(p => !t.includes(p.id)); t.forEach(id => S.sel.delete(id)); const nx = S.pages[Math.min(first, S.pages.length - 1)]; S.focusId = nx ? nx.id : null; }, `${t.length} ${n1(t.length, "página excluída", "páginas excluídas")}. ${S.pages.length} na mesa.`);
    const b = S.focusId && $(`.sel[data-id="${S.focusId}"]`); if (b) b.focus();
  }
  function dupSel() {
    const t = selIds(); if (!t.length) return;
    mutate("Duplicar páginas", () => { const out = []; S.pages.forEach(p => { out.push(p); if (t.includes(p.id)) { const c = { ...p, id: "p" + S.nid++ }; out.push(c); } }); S.pages = out; }, `${t.length} ${n1(t.length, "página duplicada", "páginas duplicadas")}.`);
  }
  function addBlank() {
    const t = selIds(); const at = t.length ? Math.max(...t.map(idx)) + 1 : S.pages.length;
    const b = { id: "p" + S.nid++, f: "", i: 0, r: 0, blank: true };
    mutate("Inserir página em branco", () => { S.pages.splice(at, 0, b); S.focusId = b.id; }, `Página em branco inserida na posição ${at + 1}.`);
  }
  function moveBlock(ids, at) { // move as páginas `ids` (em ordem da mesa) para o índice `at` da lista SEM elas
    const set = new Set(ids), moving = S.pages.filter(p => set.has(p.id)), rest = S.pages.filter(p => !set.has(p.id));
    at = Math.max(0, Math.min(rest.length, at)); rest.splice(at, 0, ...moving); S.pages = rest;
  }
  function moveBy(ids, d) {
    if (!ids.length) return; const set = new Set(ids), a = S.pages.slice();
    if (d < 0) for (let i = 1; i < a.length; i++) { if (set.has(a[i].id) && !set.has(a[i - 1].id)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
    else for (let i = a.length - 2; i >= 0; i--) { if (set.has(a[i].id) && !set.has(a[i + 1].id)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
    if (a.every((p, i) => p === S.pages[i])) { say(d < 0 ? "Já está no início." : "Já está no fim."); return; }
    mutate("Mover páginas", () => { S.pages = a; });
    say(`${ids.length} ${n1(ids.length, "página movida", "páginas movidas")}. A primeira está na posição ${idx(ids[0]) + 1} de ${S.pages.length}.`);
    const b = $(`.sel[data-id="${S.focusId}"]`); if (b) b.focus();
  }
  function moveTo() {
    const t = selIds(); if (!t.length) return; const v = parseInt($("#pos").value, 10);
    if (!v || v < 1) { say("Digite a posição de destino, a partir de 1."); $("#pos").focus(); return; }
    const pos = Math.min(v, S.pages.length - t.length + 1);
    mutate("Mover para a posição", () => moveBlock(t, pos - 1), `${t.length} ${n1(t.length, "página movida", "páginas movidas")} para a posição ${pos}.`);
  }
  function selectAll() { if (S.sel.size === S.pages.length) { S.sel.clear(); say("Seleção limpa."); } else { S.pages.forEach(p => S.sel.add(p.id)); say(`${S.pages.length} páginas selecionadas.`); } render(); }

  /* ---------- Miniaturas ---------- */
  const thumbCache = new Map();   // chave -> URL
  let active = 0; const waiters = [];
  const slot = () => new Promise(r => { if (active < 3) { active++; r(); } else waiters.push(r); });
  const free = () => { active--; const w = waiters.shift(); if (w) { active++; w(); } };
  const canvasToUrl = c => new Promise(r => c.toBlob(b => r(URL.createObjectURL(b)), "image/jpeg", .82));

  async function drawPage(p, maxSide, canvas) {
    await drawBase(p, maxSide, canvas);
    if (p.sig) paintSig(canvas, p);   // a assinatura é desenhada antes do corte: a posição vale para a página inteira
    if (p.crop) cropCanvas(canvas, p);
  }
  function paintSig(canvas, p) {
    const sg = S.sigs.get(p.sig.s); if (!sg || !sg.img || !sg.img.complete) return;
    const r = pageRot(p), ctx = canvas.getContext("2d"), cw = canvas.width, ch = canvas.height, bw = r % 180 ? ch : cw, wpx = p.sig.w * bw, hpx = wpx * sg.h / sg.w, [dx, dy] = baseToDisp(p.sig.x, p.sig.y, r);
    ctx.save(); ctx.translate(dx * cw, dy * ch); ctx.rotate(r * Math.PI / 180); ctx.drawImage(sg.img, -wpx / 2, -hpx / 2, wpx, hpx); ctx.restore();
  }
  function cropCanvas(canvas, p) {
    const c = rotCrop(p.crop, pageRot(p)), w = canvas.width, h = canvas.height, sx = Math.round(c.l * w), sy = Math.round(c.t * h), sw = Math.max(1, Math.round(w * (1 - c.l - c.r))), sh = Math.max(1, Math.round(h * (1 - c.t - c.b)));
    const tmp = document.createElement("canvas"); tmp.width = sw; tmp.height = sh; tmp.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    canvas.width = sw; canvas.height = sh; canvas.getContext("2d").drawImage(tmp, 0, 0);
  }
  async function drawBase(p, maxSide, canvas) {
    const ctx = canvas.getContext("2d");
    if (p.blank || p.lock) { canvas.width = Math.round(maxSide * .707); canvas.height = maxSide; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
    const f = fileOf(p);
    if (f.kind === "pdf") {
      const page = await f.doc.getPage(p.i + 1), rot = (page.rotate + p.r) % 360;
      const base = page.getViewport({ scale: 1, rotation: rot }), sc = maxSide / Math.max(base.width, base.height), vp = page.getViewport({ scale: sc, rotation: rot });
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise; page.cleanup();
    } else {
      const bmp = await createImageBitmap(f.file), sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
      const swap = p.r % 180 !== 0; canvas.width = swap ? h : w; canvas.height = swap ? w : h; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(p.r * Math.PI / 180); ctx.drawImage(bmp, -w / 2, -h / 2, w, h); ctx.restore(); bmp.close();
    }
  }
  /* Geometria: corte e assinatura são guardados na orientação "base" da página (sem a rotação do usuário) */
  const rotCrop = (c, r) => { r = ((r % 360) + 360) % 360; return r === 0 ? c : r === 90 ? { t: c.l, r: c.t, b: c.r, l: c.b } : r === 180 ? { t: c.b, r: c.l, b: c.t, l: c.r } : { t: c.r, r: c.b, b: c.l, l: c.t }; };
  const baseToDisp = (x, y, r) => { r = ((r % 360) + 360) % 360; return r === 0 ? [x, y] : r === 90 ? [1 - y, x] : r === 180 ? [1 - x, 1 - y] : [y, 1 - x]; };
  const dispToBase = (x, y, r) => baseToDisp(x, y, (360 - r) % 360);
  const pageRot = p => p.blank ? 0 : p.r;
  const key = p => (p.blank ? "blank" : `${p.f}:${p.i}`) + `:${p.r}:${p.crop ? [p.crop.t, p.crop.r, p.crop.b, p.crop.l].join(",") : ""}:${p.sig ? [p.sig.s, p.sig.x, p.sig.y, p.sig.w].join(",") : ""}`;
  async function ensureThumb(p, img) {
    const k = key(p); let u = thumbCache.get(k);
    if (!u) { await slot(); try { u = thumbCache.get(k); if (!u) { const c = document.createElement("canvas"); await drawPage(p, 240, c); u = await canvasToUrl(c); thumbCache.set(k, u); } } catch (e) { u = ""; } finally { free(); } }
    if (u && img.isConnected) { img.src = u; img.parentElement.classList.add("ok"); const ph = img.parentElement.querySelector(".ph"); if (ph) ph.remove(); }
  }
  const io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); const li = e.target.closest("li"); const p = li && byId(li.dataset.id); if (p) ensureThumb(p, e.target.querySelector("img")); } }), { rootMargin: "300px" }) : null;

  /* ---------- Desenho da mesa ---------- */
  const ICON = { check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>', zoom: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M16 16l5 5M11 8.5v5M8.5 11h5"/></svg>', grip: '<svg viewBox="0 0 24 24"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3.2"/></svg>' };
  const LOCKED = '<svg class="lock-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span class="lock-msg">PDF não disponível<br>Toque para desbloquear</span>';
  const label = (p, pos, sel) => `Página ${pos} de ${S.pages.length}, ${p.blank ? "em branco" : p.lock ? fileOf(p).name + ", PDF com senha, não disponível. Ative para desbloquear" : fileOf(p).name + (fileOf(p).kind === "pdf" ? ", página " + (p.i + 1) + " do arquivo" : "")}${p.r ? ", girada " + p.r + " graus" : ""}${p.crop ? ", cortada" : ""}${p.sig ? ", assinada" : ""}${sel ? ", selecionada" : ""}`;

  function render() {
    const n = S.pages.length, has = n > 0 || S.undo.length > 0;
    $("#empty").hidden = has; $("#bench").hidden = !has; $("#exportbar").hidden = !has; document.body.classList.toggle("has-bar", has);
    document.body.classList.toggle("reorder", S.reorder);
    const grid = $("#pgrid"); if (io) io.disconnect();
    if (!n) { grid.innerHTML = '<li class="empty-grid">Não há páginas na mesa. Adicione arquivos ou use “Desfazer”.</li>'; updateUI(); return; }
    if (!S.focusId || !byId(S.focusId)) S.focusId = S.pages[0].id;
    grid.innerHTML = S.pages.map((p, k) => {
      const sel = S.sel.has(p.id), u = thumbCache.get(key(p)), f = p.blank ? null : fileOf(p);
      return `<li data-id="${p.id}"><div class="pg">
        <button class="sel" type="button" data-id="${p.id}" aria-pressed="${sel}" aria-label="${esc(label(p, k + 1, sel))}" tabindex="${p.id === S.focusId ? 0 : -1}">
          <span class="thumb${p.lock ? " locked" : ""}">${p.lock ? LOCKED : u ? `<img alt="" draggable="false" src="${u}">` : '<span class="ph"></span><img alt="" draggable="false">'}</span>
          <span class="chk" aria-hidden="true">${ICON.check}</span></button>
        <button class="zoom" type="button" data-id="${p.id}" aria-label="Ampliar página ${k + 1}" tabindex="-1">${ICON.zoom}</button>
        <button class="handle" type="button" data-id="${p.id}" aria-label="Arrastar página ${k + 1}" tabindex="-1">${ICON.grip}</button>
        <span class="num" aria-hidden="true">${k + 1}</span>${p.crop || p.sig ? `<span class="tag" aria-hidden="true">${[p.crop ? "cortada" : "", p.sig ? "assinada" : ""].filter(Boolean).join(" · ")}</span>` : ""}
        <span class="nm" aria-hidden="true">${p.blank ? "Página em branco" : esc(f.name) + (f.kind === "pdf" && !p.lock ? " · p. " + (p.i + 1) : "")}</span></div></li>`;
    }).join("");
    if (io) $$(".thumb", grid).forEach(t => { if (!t.querySelector(".ph")) return; io.observe(t); });
    updateUI();
  }

  function setWhat(v) { const r = $(`input[name=what][value="${v}"]`); if (r) { r.checked = true; whatChanged(); } }
  const what = () => ($("input[name=what]:checked") || {}).value || "all";

  function parseRange(txt, n) {
    const out = [], seen = new Set(); txt = txt.trim(); if (!txt) return { ok: false, error: "Digite as páginas, por exemplo 1-3, 5, 8-10." };
    for (const raw of txt.split(",")) {
      const t = raw.trim(); if (!t) return { ok: false, error: "Há uma vírgula sem número." };
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t); if (!m) return { ok: false, error: `Trecho inválido: “${t}”. Use números e hífens, como 1-3, 5.` };
      const a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b < 1 || a > n || b > n) return { ok: false, error: `“${t}” está fora da mesa, que tem ${n} ${n1(n, "página", "páginas")}.` };
      if (b < a) return { ok: false, error: `“${t}” está ao contrário. Escreva do menor para o maior.` };
      for (let i = a; i <= b; i++) if (!seen.has(i)) { seen.add(i); out.push(i - 1); }
    }
    return { ok: true, idx: out };
  }
  function exportList() {
    const w = what();
    if (w === "sel") return { ok: true, pages: S.pages.filter(p => S.sel.has(p.id)) };
    if (w === "range") { const r = parseRange($("#range").value, S.pages.length); return r.ok ? { ok: true, pages: r.idx.map(i => S.pages[i]) } : r; }
    return { ok: true, pages: S.pages.slice() };
  }
  function estimate(pages) {
    let b = 0; const per = {}; pages.forEach(p => { if (p.blank) { b += 1500; return; } if (p.lock) return; const f = fileOf(p); if (f.kind === "img") b += prefs.quality === "original" ? Math.min(f.size, 2.5 * MB) : Math.min(f.size, 350 * 1024); else per[f.id] = (per[f.id] || 0) + 1; });
    Object.entries(per).forEach(([id, c]) => { const f = S.files.get(id); b += f.size * (c / f.n); }); return b;
  }
  function defaultName() {
    const fs = [...new Set(S.pages.filter(p => !p.blank).map(p => p.f))].map(id => S.files.get(id));
    if (fs.length === 1 && fs[0].kind === "pdf") return fs[0].name.replace(/\.pdf$/i, "") + "-editado.pdf";
    if (fs.length && fs.every(f => f.kind === "img")) return "fotos.pdf";
    return "mesa-de-pdf.pdf";
  }
  let nameTouched = false;

  function updateUI() {
    const n = S.pages.length, k = selIds().length, has = k > 0;
    $("#selcount").textContent = n ? `${k} ${n1(k, "selecionada", "selecionadas")} de ${n} ${n1(n, "página", "páginas")}` : "";
    ["rot", "dup", "del", "mvb", "mvf", "mvto"].forEach(id => { $("#" + id).disabled = !has || S.busy; });
    $("#pos").disabled = !has; $("#selall").textContent = n && S.sel.size === n ? "Limpar seleção" : "Selecionar todas";
    $("#undo").disabled = !S.undo.length || S.busy; $("#redo").disabled = !S.redo.length || S.busy; $("#blank").disabled = S.busy; $("#add").disabled = S.busy;
    $("#reorder").setAttribute("aria-pressed", S.reorder);
    $("#selN").textContent = `(${k})`; $(`input[name=what][value="sel"]`).disabled = !has;
    if (!has && what() === "sel") setWhat("all");
    $("#pos").max = n;
    const hasImg = S.pages.some(p => !p.blank && fileOf(p).kind === "img"); $("#imgopts").hidden = !hasImg;
    $("#qualhint").textContent = coarse ? "Neste aparelho, fotos grandes são reduzidas para o navegador não travar." : "";
    const l = exportList(); const cnt = l.ok ? l.pages.length : 0;
    const lkn = l.ok ? lockedCount(l.pages) : 0;
    const msg = n ? (l.ok ? `${cnt} ${n1(cnt, "página", "páginas")} · cerca de ${fmt(estimate(l.pages))}${lkn ? ` · ${lkn} com senha` : ""}` : "") : "";
    $("#summary").textContent = msg; $("#barsum").textContent = msg;
    const rh = $("#rangehint"); if (what() === "range") { rh.textContent = l.ok ? `Vai exportar ${cnt} ${n1(cnt, "página", "páginas")}: ${(parseRange($("#range").value, n).idx || []).map(i => i + 1).join(", ")}` : l.error; rh.style.color = l.ok ? "" : "var(--danger)"; $("#range").setAttribute("aria-invalid", !l.ok); }
    if (!nameTouched) $("#fname").value = defaultName();
    $("#go").disabled = S.busy || !l.ok || !cnt; $("#go2").disabled = $("#go").disabled;
    if (core.hooks.ui) core.hooks.ui();
  }
  function whatChanged() { $("#rangewrap").hidden = what() !== "range"; updateUI(); }

  /* ---------- Seleção, foco e teclado ---------- */
  function toggle(id, shift) {
    if (shift && S.anchor && byId(S.anchor)) { const a = idx(S.anchor), b = idx(id); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(S.pages[i].id); }
    else { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.anchor = id; }
    S.focusId = id; render(); const b = $(`.sel[data-id="${id}"]`); if (b) b.focus(); say(`${S.sel.size} ${n1(S.sel.size, "selecionada", "selecionadas")}.`);
  }
  function cols() { const b = $$("#pgrid .sel"); if (b.length < 2) return 1; const t = b[0].getBoundingClientRect().top; let c = 0; for (const x of b) { if (Math.abs(x.getBoundingClientRect().top - t) < 4) c++; else break; } return Math.max(1, c); }
  function focusIdx(i) { const p = S.pages[Math.max(0, Math.min(S.pages.length - 1, i))]; if (!p) return; $$("#pgrid .sel").forEach(b => b.tabIndex = -1); S.focusId = p.id; const b = $(`.sel[data-id="${p.id}"]`); if (b) { b.tabIndex = 0; b.focus(); } return p; }

  $("#pgrid").addEventListener("click", e => {
    if (suppressClick) { suppressClick = false; return; }
    const z = e.target.closest(".zoom"); if (z) { const zp = byId(z.dataset.id); if (zp && zp.lock) openUnlock(zp.id, z); else openZoom(z.dataset.id, z); return; }
    if (e.target.closest(".handle")) return;
    const s = e.target.closest(".sel"); if (s) { const sp = byId(s.dataset.id); if (sp && sp.lock && !e.shiftKey) openUnlock(sp.id, s); else toggle(s.dataset.id, e.shiftKey); }
  });
  $("#pgrid").addEventListener("keydown", e => {
    const s = e.target.closest(".sel"); if (!s) return; const id = s.dataset.id, i = idx(id);
    const nav = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() }[e.key];
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); const t = S.sel.has(id) ? selIds() : [id]; moveBy(t, e.key === "ArrowLeft" ? -1 : 1); return; }
    if (nav !== undefined) { e.preventDefault(); const p = focusIdx(i + nav); if (e.shiftKey && p) { if (!S.anchor) S.anchor = id; const a = idx(S.anchor), b = idx(p.id); S.sel.clear(); for (let k = Math.min(a, b); k <= Math.max(a, b); k++) S.sel.add(S.pages[k].id); render(); const nb = $(`.sel[data-id="${p.id}"]`); if (nb) nb.focus(); } return; }
    if (e.key === "Home") { e.preventDefault(); focusIdx(0); } else if (e.key === "End") { e.preventDefault(); focusIdx(S.pages.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); openZoom(id, s); }
    else if (e.key === "Delete") { e.preventDefault(); deleteSel(S.sel.size ? undefined : [id]); }
  });
  document.addEventListener("keydown", e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || $("#zoom").open || S.busy) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); } else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); doRedo(); }
    else if (mod && e.key.toLowerCase() === "a" && S.pages.length && document.activeElement.closest("#pgrid")) { e.preventDefault(); S.pages.forEach(p => S.sel.add(p.id)); render(); say(`${S.pages.length} páginas selecionadas.`); }
    else if (e.key === "Escape" && dragState) cancelDrag();
  });

  /* ---------- Arrastar e soltar (ponteiro: mouse e toque) ---------- */
  let dragState = null, suppressClick = false;
  $("#pgrid").addEventListener("dragstart", e => e.preventDefault());   // sem arrasto nativo de imagem: usamos o nosso, por ponteiro
  $("#pgrid").addEventListener("pointerdown", e => {
    suppressClick = false;                                // um novo toque/clique é uma nova interação
    const h = e.target.closest(".handle"), c = e.target.closest(".sel");
    if (e.pointerType !== "mouse" && !h) return;        // no toque, só pela alça (evita brigar com a rolagem)
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!h && !c) return; const id = (h || c).dataset.id;
    dragState = { id, x0: e.clientX, y0: e.clientY, active: false, pid: e.pointerId, suppress: false, fromHandle: !!h };
    if (h) { try { h.setPointerCapture(e.pointerId); } catch (err) { /* ponteiro já encerrado */ } }
  });
  window.addEventListener("pointermove", e => {
    if (!dragState || e.pointerId !== dragState.pid) return;
    if (!dragState.active) { if (Math.hypot(e.clientX - dragState.x0, e.clientY - dragState.y0) < 6) return; startDrag(e); }
    moveDrag(e);
  });
  window.addEventListener("pointerup", e => { if (dragState && e.pointerId === dragState.pid) endDrag(e); });
  window.addEventListener("pointercancel", () => { if (dragState) cancelDrag(); });
  function startDrag(e) {
    const d = dragState; d.active = true; d.suppress = true; document.body.classList.add("drag-active");
    d.ids = S.sel.has(d.id) ? selIds() : [d.id];
    d.ids.forEach(id => { const li = $(`#pgrid li[data-id="${id}"] .pg`); if (li) li.classList.add("dragging"); });
    const g = document.createElement("div"); g.className = "ghost"; const img = $(`#pgrid li[data-id="${d.id}"] img`); g.innerHTML = `<img alt="" src="${img ? img.src : ""}">${d.ids.length > 1 ? `<b>${d.ids.length}</b>` : ""}`; document.body.appendChild(g); d.ghost = g;
    const line = document.createElement("div"); line.className = "dropline"; $("#pgrid").appendChild(line); d.line = line; d.at = null;
    d.raf = requestAnimationFrame(function tick() { if (!dragState || !dragState.active) return; const y = dragState.cy; if (y !== undefined) { if (y < 70) scrollBy(0, -14); else if (y > innerHeight - 70) scrollBy(0, 14); } dragState.raf = requestAnimationFrame(tick); });
    say("Arrastando. Solte entre duas páginas. Esc cancela.");
  }
  function moveDrag(e) {
    const d = dragState; d.cx = e.clientX; d.cy = e.clientY; d.ghost.style.left = e.clientX + 10 + "px"; d.ghost.style.top = e.clientY + 10 + "px";
    const cards = $$("#pgrid li[data-id]"); if (!cards.length) return;
    let best = null, bd = 1e9;
    for (const li of cards) { const r = li.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, dist = Math.hypot(e.clientX - cx, (e.clientY - cy) * 1.4); if (dist < bd) { bd = dist; best = { li, r, before: e.clientX < cx }; } }
    const gr = $("#pgrid").getBoundingClientRect(), r = best.r, x = (best.before ? r.left - 8 : r.right + 6) - gr.left;
    d.line.style.left = x + "px"; d.line.style.top = r.top - gr.top + "px"; d.line.style.height = r.height + "px";
    const i = idx(best.li.dataset.id); d.at = best.before ? i : i + 1;
  }
  function endDrag(e) {
    const d = dragState; if (!d.active) { dragState = null; return; }
    const at = d.at; cleanupDrag();
    if (at === null) return;
    const set = new Set(d.ids); let shift = 0; for (let i = 0; i < Math.min(at, S.pages.length); i++) if (set.has(S.pages[i].id)) shift++;
    const dest = at - shift, before = S.pages.filter(p => set.has(p.id)).map(p => idx(p.id));
    const same = dest === Math.min(...before) && before.every((x, k) => x === before[0] + k);
    if (same) { say("Nada mudou de lugar."); return; }
    mutate("Reordenar páginas", () => { moveBlock(d.ids, dest); S.focusId = d.id; }, `${d.ids.length} ${n1(d.ids.length, "página movida", "páginas movidas")} para a posição ${dest + 1}.`);
    const b = $(`.sel[data-id="${d.id}"]`); if (b) b.focus({ preventScroll: true });
  }
  function cleanupDrag() { const d = dragState; if (!d) return; cancelAnimationFrame(d.raf); if (d.ghost) d.ghost.remove(); if (d.line) d.line.remove(); $$(".pg.dragging").forEach(x => x.classList.remove("dragging")); document.body.classList.remove("drag-active"); if (d.suppress) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 60); } dragState = null; }
  function cancelDrag() { cleanupDrag(); say("Arrasto cancelado."); }

  /* ---------- Ampliar ---------- */
  let zoomId = null, zoomOpener = null;
  async function showZoom() {
    const p = byId(zoomId); if (!p) return; const k = idx(zoomId);
    $("#zt").textContent = `Página ${k + 1} de ${S.pages.length}${p.blank ? " (em branco)" : " — " + fileOf(p).name}`;
    $("#zprev").disabled = k === 0; $("#znext").disabled = k === S.pages.length - 1;
    const c = $("#zcanvas"); c.setAttribute("aria-label", `Página ${k + 1} ampliada`);
    try { await drawPage(p, Math.min(1400, Math.round(Math.min(innerWidth * .9, 940) * Math.min(2, devicePixelRatio || 1))), c); if (core.hooks.zoomOverlay) core.hooks.zoomOverlay(c, p, k, S.pages.length); } catch (e) { showAlert("Não consegui ampliar esta página."); }
  }
  function openZoom(id, opener) { zoomId = id; zoomOpener = opener; const dlg = $("#zoom"); if (!dlg.open) dlg.showModal(); showZoom(); $("#zclose").focus(); }
  $("#zclose").onclick = () => $("#zoom").close();
  $("#zprev").onclick = () => { const i = idx(zoomId); if (i > 0) { zoomId = S.pages[i - 1].id; showZoom(); } };
  $("#znext").onclick = () => { const i = idx(zoomId); if (i < S.pages.length - 1) { zoomId = S.pages[i + 1].id; showZoom(); } };
  $("#zoom").addEventListener("keydown", e => { if (e.key === "ArrowLeft") $("#zprev").click(); else if (e.key === "ArrowRight") $("#znext").click(); });
  $("#zoom").addEventListener("close", () => { const b = $(`.sel[data-id="${zoomId}"]`) || zoomOpener; if (b && b.isConnected) b.focus(); });

  /* ---------- Exportar ---------- */
  const A4 = [595.28, 841.89], LETTER = [612, 792], MARGIN = { none: 0, small: 24, medium: 48 };
  async function prepImage(f, q) {
    const bmp = await createImageBitmap(f.file), max = q === "original" ? (coarse ? 3000 : 4096) : 2000, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc), c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    const png = q === "original" && /png/i.test(f.file.type);
    const blob = await new Promise(r => c.toBlob(r, png ? "image/png" : "image/jpeg", q === "original" ? .95 : .85));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), png, w, h };
  }
  const COMP = { none: null, light: { px: 2000, q: .85 }, medium: { px: 1400, q: .7 }, strong: { px: 1000, q: .55 } };
  async function rasterPage(f, p, cfg) {
    cfg = cfg || { px: coarse ? 1600 : 2400, q: .88 };
    const page = await f.doc.getPage(p.i + 1), rot = (page.rotate + p.r) % 360, base = page.getViewport({ scale: 1, rotation: rot });
    const sc = Math.min(2, cfg.px / Math.max(base.width, base.height)), vp = page.getViewport({ scale: sc, rotation: rot });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise; page.cleanup();
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", cfg.q)); c.width = c.height = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: base.width, h: base.height };
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  async function build(list, onProgress) {
    const { PDFDocument, degrees } = window.PDFLib, out = await PDFDocument.create(), srcs = new Map(), comp = COMP[prefs.comp] || null; let last = null;
    for (let k = 0; k < list.length; k++) {
      if (S.cancel) throw new Error("cancelado");
      const p = list[k]; let meta = { kind: "flat", r: 0 };
      if (p.blank) { const sz = last ? [last.getWidth(), last.getHeight()] : A4; last = out.addPage(sz); }
      else {
        const f = fileOf(p);
        if (f.kind === "pdf" && (f.password || comp)) {   // PDF que tinha senha ou será comprimido: vai como imagem de cada página
          meta = { kind: "flat", r: p.r };
          const im = await rasterPage(f, p, comp), emb = await out.embedJpg(im.bytes), page = out.addPage([im.w, im.h]);
          page.drawImage(emb, { x: 0, y: 0, width: im.w, height: im.h }); last = page;
        } else if (f.kind === "pdf") {
          let src = srcs.get(f.id); if (!src) { src = await PDFDocument.load(f.bytes, f.password ? { password: f.password, updateMetadata: false } : { updateMetadata: false }); srcs.set(f.id, src); }
          const [cp] = await out.copyPages(src, [p.i]), native = ((cp.getRotation().angle % 360) + 360) % 360; cp.setRotation(degrees(((native + p.r) % 360 + 360) % 360)); out.addPage(cp); last = cp;
          meta = { kind: "pdf", native, total: (native + p.r) % 360 };
        } else {
          const im = await prepImage(f, prefs.quality), emb = im.png ? await out.embedPng(im.bytes) : await out.embedJpg(im.bytes);
          const m = MARGIN[prefs.margin]; let pw, ph;
          const rotated = p.r % 180 !== 0, iw = rotated ? im.h : im.w, ih = rotated ? im.w : im.h;
          if (prefs.size === "fit") { const long = 842, s = long / Math.max(iw, ih); pw = iw * s + 2 * m; ph = ih * s + 2 * m; }
          else { const base = prefs.size === "letter" ? LETTER : A4; [pw, ph] = iw > ih ? [base[1], base[0]] : base; }
          const page = out.addPage([pw, ph]), aw = pw - 2 * m, ah = ph - 2 * m, s = Math.min(aw / iw, ah / ih), dw = iw * s, dh = ih * s, x = (pw - dw) / 2, y = (ph - dh) / 2;
          if (p.r === 0) page.drawImage(emb, { x, y, width: dw, height: dh });
          else { // gira no sentido horário em torno do centro da página
            const cx = pw / 2, cy = ph / 2, w0 = rotated ? dh : dw, h0 = rotated ? dw : dh, a = p.r * Math.PI / 180;
            const ox = cx - (w0 / 2) * Math.cos(a) - (h0 / 2) * Math.sin(a), oy = cy + (w0 / 2) * Math.sin(a) - (h0 / 2) * Math.cos(a);
            page.drawImage(emb, { x: ox, y: oy, width: w0, height: h0, rotate: degrees(-p.r) });
          }
          last = page; meta = { kind: "flat", r: p.r };
        }
      }
      if (core.hooks.decorate) await core.hooks.decorate({ out, page: last, p, meta, k, total: list.length, lib: window.PDFLib });
      onProgress((k + 1) / list.length); if (k % 2 === 1) await tick();
    }
    out.setProducer("Mesa de PDF · VF Tools"); out.setCreator("Mesa de PDF · VF Tools");
    return out.save();
  }
  const safeName = n => { n = (n || "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "mesa-de-pdf"; return /\.pdf$/i.test(n) ? n : n + ".pdf"; };
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  async function deliver(bytes, name) {
    const blob = new Blob([bytes], { type: "application/pdf" }), file = new File([blob], name, { type: "application/pdf" });
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (isIOS) window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function doExport() {
    if (S.busy) return; const l = exportList();
    if (!l.ok) { showAlert(l.error); $("#range").focus(); return; } if (!l.pages.length) { showAlert("Não há páginas para exportar."); return; }
    const lk = lockedCount(l.pages);
    if (lk) { showAlert(lk === 1 ? "Há um PDF com senha na mesa. Toque no cadeado para desbloquear (ou remova-o) antes de baixar." : `Há ${lk} PDFs com senha na mesa. Desbloqueie (toque no cadeado) ou remova antes de baixar.`); const b = $(".thumb.locked"); if (b) b.closest(".sel").focus(); return; }
    hideAlert(); S.cancel = false; S.busy = true; document.body.setAttribute("aria-busy", "true"); updateUI();
    $("#progwrap").hidden = false; $("#cancel").hidden = false; const prog = $("#prog"); prog.value = 0; say("Gerando o PDF");
    try {
      await loadLibs(); const bytes = await build(l.pages, v => { prog.value = Math.round(v * 100); });
      await deliver(bytes, safeName($("#fname").value)); S.exported = true;
      say(`PDF pronto: ${l.pages.length} ${n1(l.pages.length, "página", "páginas")}, ${fmt(bytes.length)}.`); T.toast("PDF pronto.");
    } catch (e) { if (e && e.message === "cancelado") { say("Exportação cancelada."); T.toast("Cancelado."); } else showAlert("Não consegui gerar o PDF. Algum arquivo pode estar danificado ou protegido. Tente de novo sem ele."); }
    S.busy = false; document.body.setAttribute("aria-busy", "false"); $("#progwrap").hidden = true; updateUI();
  }

  /* ---------- Controles ---------- */
  const pick = (accept, multiple = true) => { const f = $("#file"); f.accept = accept; f.multiple = multiple; f.value = ""; f.click(); };
  const ACC = { all: "application/pdf,image/*,.pdf", pdf: "application/pdf,.pdf", img: "image/*" };
  $("#pick").onclick = () => pick(ACC.all); $("#add").onclick = () => pick(ACC.all);
  $("#file").onchange = e => ingest(e.target.files);
  $$("#intents [data-intent]").forEach(b => b.onclick = () => { const i = b.dataset.intent; S.intent = i; pick(i === "photos" ? ACC.img : i === "split" ? ACC.pdf : ACC.all, i !== "split"); });
  $("#selall").onclick = selectAll; $("#rot").onclick = rotateSel; $("#dup").onclick = dupSel; $("#blank").onclick = addBlank; $("#del").onclick = () => deleteSel();
  $("#mvb").onclick = () => moveBy(selIds(), -1); $("#mvf").onclick = () => moveBy(selIds(), 1); $("#mvto").onclick = moveTo;
  $("#pos").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); moveTo(); } });
  $("#undo").onclick = doUndo; $("#redo").onclick = doRedo;
  $("#reorder").onclick = () => { S.reorder = !S.reorder; render(); say(S.reorder ? "Modo reordenar ligado: use a alça de cada página para arrastar." : "Modo reordenar desligado."); };
  $$("input[name=what]").forEach(r => r.onchange = whatChanged); $("#range").addEventListener("input", updateUI);
  $("#fname").addEventListener("input", () => { nameTouched = true; });
  ["psize", "pmargin", "pqual"].forEach(id => { const el = $("#" + id), k = { psize: "size", pmargin: "margin", pqual: "quality" }[id]; el.value = prefs[k]; el.onchange = () => { prefs[k] = el.value; savePrefs(); updateUI(); }; });
  $("#go").onclick = doExport; $("#go2").onclick = doExport;
  $("#cancel").onclick = () => { S.cancel = true; };
  $("#reset").onclick = () => {
    if (S.pages.length && !confirm("Começar de novo? As páginas que estão na mesa serão descartadas.")) return;
    S.pages = []; S.sel.clear(); S.undo = []; S.redo = []; S.files.forEach(f => { if (f.doc) f.doc.destroy(); }); S.files.clear(); totalBytes = 0; thumbCache.forEach(u => URL.revokeObjectURL(u)); thumbCache.clear(); S.exported = false; nameTouched = false; setWhat("all"); $("#range").value = ""; $("#hint").hidden = true; hideAlert(); render(); say("Mesa limpa."); $("#pick").focus();
  };
  $("#resetdata").onclick = () => { if (confirm("Isso remove as preferências desta ferramenta neste navegador (tamanho, margem, qualidade, compressão, marca d’água e numeração). Continuar?")) { T.clear(); Object.assign(prefs, { size: "a4", margin: "small", quality: "reduced", comp: "none" }); if (core.hooks.resetPrefs) core.hooks.resetPrefs(); ["psize", "pmargin", "pqual"].forEach(id => { $("#" + id).value = prefs[{ psize: "size", pmargin: "margin", pqual: "quality" }[id]]; }); T.toast("Dados apagados."); } };
  $("#y").textContent = new Date().getFullYear();

  /* Soltar arquivos em qualquer lugar da página */
  let depth = 0; const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragenter", e => { if (hasFiles(e)) { depth++; document.body.classList.add("dropping"); } });
  window.addEventListener("dragleave", e => { if (hasFiles(e) && --depth <= 0) { depth = 0; document.body.classList.remove("dropping"); } });
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; document.body.classList.remove("dropping"); ingest(e.dataTransfer.files); });
  window.addEventListener("beforeunload", e => { if (S.pages.length && !S.exported) { e.preventDefault(); e.returnValue = ""; } });

  render(); whatChanged();
  Object.assign(core, { S, prefs, savePrefs, $, $$, esc, say, showAlert, hideAlert, mutate, byId, idx, fileOf, render, drawPage, drawBase, selIds, n1, rotCrop, baseToDisp, dispToBase, pageRot, updateUI, COMP });
  window.MesaCore = core;
  window.__mesa = { S, ingest, render };   // para testes
})();
