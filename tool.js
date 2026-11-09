/* VF Tools — helper para ferramentas. Dá a você:
   - armazenamento próprio com try/catch:  VFTool.get("k", padrão) / VFTool.set("k", valor)
     (chave "vf-tools:<id>:v1"; nunca mexe na chave do site "vf-tools:v1")
   - tema compartilhado: preferência da ferramenta > tema do site > escuro
   - VFTool.toast("mensagem") para avisos curtos
   Defina o id no <html data-tool="meu-id">. */
window.VFTool = (() => {
  const root = document.documentElement;
  const ID = root.dataset.tool || "minha-ferramenta";
  const KEY = `vf-tools:${ID}:v1`, SITE = "vf-tools:v1";
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch { return {}; } };
  const state = read(KEY);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const get = (k, d) => (k in state ? state[k] : d);
  const set = (k, v) => { state[k] = v; save(); };
  const clear = () => { Object.keys(state).forEach(k => delete state[k]); try { localStorage.removeItem(KEY); } catch {} };

  // Tema: escolha local > tema do site (mesmo domínio no GitHub Pages) > escuro
  const theme = () => state.theme || read(SITE).theme || "dark";
  const applyTheme = () => {
    const t = theme(); root.dataset.theme = t;
    const m = document.querySelector("meta[name=theme-color]"); if (m) m.content = t === "light" ? "#f7f1e7" : "#14110f";
  };
  applyTheme();
  const btn = document.getElementById("theme");
  if (btn) btn.onclick = () => { set("theme", theme() === "dark" ? "light" : "dark"); applyTheme(); };

  const toast = msg => {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("p"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2500);
  };
  window.VFStore = { get: () => state, save };   // usado pelo Doggy (help.js) para lembrar que o tour já foi visto
  return { id: ID, get, set, clear, toast, theme };
})();
