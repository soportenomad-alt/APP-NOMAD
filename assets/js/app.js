const $ = (q, el=document) => el.querySelector(q);
const $$ = (q, el=document) => Array.from(el.querySelectorAll(q));


// --- Firebase readiness helper (firebase.js is a module and may load after app.js)
function waitForFirebase(timeoutMs = 8000){
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if(window.NOMAD_FIRE && window.NOMAD_FIRE.__error){
        reject(window.NOMAD_FIRE.__error);
        return;
      }
      if(window.NOMAD_FIRE && (window.NOMAD_FIRE.db || window.NOMAD_FIRE.saveCheckout)){
        resolve(window.NOMAD_FIRE);
        return;
      }
      if(Date.now() - start > timeoutMs){
        reject(new Error("Firebase no cargó (NOMAD_FIRE)"));
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}


const screens = $$("[data-screen]");
const navBtns = $$("[data-nav]");
const topTitle = $("#topTitle");
const topSub = $("#topSub");
const searchInput = $("#globalSearch");
const toast = $("#toast");
const sheet = $("#sheet");

// Helpers to avoid null errors (when a screen/element is not present)
const on = (el, evt, fn) => { if(el) el.addEventListener(evt, fn); };
const setText = (el, val) => { if(el) el.textContent = val; };

const UI_VERSION = "v6.3";
console.info("[NOMAD] UI", UI_VERSION);
// Exponer versión para que Firebase la adjunte a cada registro (útil para debugging)
try{ window.NOMAD_UI_VERSION = UI_VERSION; }catch(e){}



// === Catálogo remoto (precios y nombres) ===
// Toma el catálogo oficial desde tu GitHub Pages y lo “inyecta” a esta interfaz.
// Si no se puede cargar (offline / CORS), se usa la lista demo.
const REMOTE_CATALOG_URL = "https://soporteti-desing.github.io/catalogo-Nomad/";
const REMOTE_CATALOG_APPJS = REMOTE_CATALOG_URL + "app.js";
const REMOTE_JSON_CANDIDATES = [
  REMOTE_CATALOG_URL + "catalog.json",
  REMOTE_CATALOG_URL + "catalogo.json",
  REMOTE_CATALOG_URL + "data.json",
  REMOTE_CATALOG_URL + "pruebas.json",
  REMOTE_CATALOG_URL + "assets/catalog.json",
  REMOTE_CATALOG_URL + "assets/pruebas.json",
  REMOTE_CATALOG_URL + "data/catalog.json",
  REMOTE_CATALOG_URL + "data/pruebas.json",
];
// CORS-safe (recomendado): tomar JSON directo desde raw.githubusercontent.com
const RAW_JSON_CANDIDATES = [
  "https://raw.githubusercontent.com/SoporteTI-desing/catalogo-Nomad/main/data.json",
];

// Copia local (para que SIEMPRE se vea el catálogo aunque no haya internet)
const LOCAL_JSON_CANDIDATES = [
  "assets/data/catalogo_nomad_oficial.json",
];


const CATALOG_CACHE_KEY = "nomad_catalog_cache_v3";
const CATALOG_CACHE_TTL_HOURS = 24 * 7; // 7 días

function slugify(str=""){
  return str
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || ("item-" + Math.random().toString(16).slice(2));
}

function parsePrice(v){
  // acepta number o string tipo "$55,680.00 MXN"
  if(typeof v === "number") return v;
  const s = String(v || "");
  const m = s.match(/-?[0-9][0-9.,]*/);
  if(!m) return 0;
  // Heurística es-MX: separador miles "," y decimal "."
  const cleaned = m[0].replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

async function tryFetchJson(url){
  const res = await fetch(url, { cache:"no-store" });
  if(!res.ok) throw new Error("HTTP " + res.status);
  const txt = await res.text();
  // puede venir como JSON directo o como objeto en texto
  const data = JSON.parse(txt);
  return data;
}

function normalizeRemoteItems(raw){
  // Acepta: array directo; o {items:[...]} / {data:[...]} / {catalog:[...]}
  const arr = Array.isArray(raw) ? raw :
    (raw?.items || raw?.data || raw?.catalog || raw?.pruebas || raw?.tests || []);
  if(!Array.isArray(arr)) return [];

  const out = [];
  for(const r of arr){
    const name = r?.name || r?.title || r?.prueba || r?.test || r?.nombre || r?.titulo;
    if(!name) continue;

    const price = parsePrice(
      r?.price_val ?? r?.priceNomad ?? r?.price_nomad ?? r?.price ?? r?.precio ?? r?.cost ?? r?.costo ?? r?.mxn ?? r?.amount
    );
    // si viene en texto "MXN" o "$", parsePrice lo saca
    const desc = r?.desc || r?.description || r?.descripcion || "";
    const tags = Array.isArray(r?.tags) ? r.tags : (Array.isArray(r?.categorias) ? r.categorias : []);
    out.push({
      id: slugify(r?.id || name),
      name: String(name),
      desc: String(desc || ""),
      tags: tags.map(t => String(t)).filter(Boolean),
      price: price,
      link: String(r?.link || r?.url || r?.enlace || ""),
      image: String(r?.image || r?.img || r?.imagen || ""),
    });
  }

  // de-dup por id
  const seen = new Set();
  return out.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}

function extractArrayLiteral(jsText){
  // Busca una asignación típica: const pruebas = [ ... ];
  const patterns = [
    /\b(const|let|var)\s+(pruebas|tests|catalog|catalogo|data|items)\s*=\s*\[/i,
    /\b(pruebas|tests|catalog|catalogo|data|items)\s*:\s*\[/i,
  ];
  let start = -1;
  for(const rx of patterns){
    const m = jsText.match(rx);
    if(m){
      start = jsText.indexOf("[", m.index);
      break;
    }
  }
  if(start < 0) return null;

  // bracket matching con manejo de strings
  let i = start;
  let depth = 0;
  let inStr = false;
  let strCh = "";
  let esc = false;

  for(; i < jsText.length; i++){
    const ch = jsText[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(ch === "\\"){ esc = true; continue; }
      if(ch === strCh){ inStr = false; strCh = ""; continue; }
      continue;
    }else{
      if(ch === "'" || ch === '"' || ch === "`"){ inStr = true; strCh = ch; continue; }
      if(ch === "["){ depth++; continue; }
      if(ch === "]"){
        depth--;
        if(depth === 0){
          return jsText.slice(start, i+1);
        }
      }
    }
  }
  return null;
}

function safeJsonFromJsArrayLiteral(arrayLiteral){
  // Intento 1: JSON.parse directo (si ya viene como JSON)
  try{ return JSON.parse(arrayLiteral); } catch(e){}

  // Intento 2: “jsonificar” claves sin comillas + comillas simples
  let s = arrayLiteral;

  // quitar trailing commas
  s = s.replace(/,\s*([}\]])/g, "$1");

  // convertir comillas simples a dobles (simple heuristic)
  // Nota: en este catálogo normalmente no hay apóstrofes raros
  s = s.replace(/'(\\.|[^'\\])*'/g, (m) => {
    const inner = m.slice(1,-1).replace(/\\'/g,"'").replace(/"/g,'\\"');
    return '"' + inner + '"';
  });

  // poner comillas en keys: { id: ... } -> { "id": ... }
  s = s.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

  try{ return JSON.parse(s); } catch(e){ return null; }
}

async function loadCatalogFromRemote(){
  // 1) JSON candidates (raw -> github pages -> local)
  const allCandidates = [...(RAW_JSON_CANDIDATES||[]), ...(REMOTE_JSON_CANDIDATES||[]), ...(LOCAL_JSON_CANDIDATES||[])];
  for(const url of allCandidates){
    try{
      const raw = await tryFetchJson(url);
      const items = normalizeRemoteItems(raw);
      if(items.length) return { items, source:url };
    }catch(e){}
  }

  // 2) Parsear el app.js remoto
  const res = await fetch(REMOTE_CATALOG_APPJS, { cache:"no-store" });
  if(!res.ok) throw new Error("No se pudo leer app.js remoto: " + res.status);
  const jsText = await res.text();

  const arrLit = extractArrayLiteral(jsText);
  if(!arrLit) throw new Error("No se encontró arreglo de catálogo en app.js remoto");

  const rawArr = safeJsonFromJsArrayLiteral(arrLit);
  if(!rawArr) throw new Error("No se pudo convertir el catálogo remoto a JSON");

  const items = normalizeRemoteItems(rawArr);
  if(!items.length) throw new Error("Catálogo remoto vacío");
  return { items, source: REMOTE_CATALOG_APPJS };
}

function loadCatalogCache(){
  try{
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    const ageHrs = (Date.now() - Number(parsed.ts || 0)) / 36e5;
    if(!parsed?.items || ageHrs > CATALOG_CACHE_TTL_HOURS) return null;
    const items = normalizeRemoteItems(parsed.items);
    return items.length ? items : null;
  }catch(e){
    return null;
  }
}

function saveCatalogCache(items){
  try{
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ ts: Date.now(), items }));
  }catch(e){}
}

async function hydrateCatalog(){
  // cache primero
  const cached = loadCatalogCache();
  if(cached){
    state.catalog = cached;
    state.cart.clear();
    state.catalogSource = "cache";
    setText($("#cartCount"), state.cart.size.toString());
    renderCatalog();
    renderQuote();
  }

  // remoto después
  try{
    const { items, source } = await loadCatalogFromRemote();
    state.catalog = items;
    state.cart.clear();
    state.catalogSource = source;
    setText($("#cartCount"), state.cart.size.toString());
    saveCatalogCache(items);
    renderCatalog();
    renderQuote();
    console.info("[NOMAD] Catálogo cargado:", { source, items: items.length });
    showToast("Catálogo actualizado (precios del catálogo oficial)");
  }catch(e){
    console.warn("[NOMAD] No se pudo cargar catálogo oficial:", e);
    // Si ya había cache, no molestar. Si no, avisar que queda demo.
    if(!cached) showToast("No se pudo cargar catálogo oficial; usando lista demo");
  }
}


const demoCatalog = [
    { id:"oncopanel", name:"OncoPanel Nomad", desc:"Panel ampliado para variantes somáticas relevantes. Cobertura completa, reporte clínico.", tags:["Oncología","NGS","Somático"], price: 14800 },
    { id:"brca", name:"BRCA1/2 + HRD", desc:"Detección de variantes en BRCA y firma de recombinación homóloga (según protocolo).", tags:["Oncología","Hereditario"], price: 8900 },
    { id:"lung", name:"Pulmón · Biomarcadores", desc:"EGFR, ALK, ROS1, KRAS, BRAF y otros marcadores accionables.", tags:["Oncología","Pulmón"], price: 7200 },
    { id:"colon", name:"Colon · RAS/BRAF/MSI", desc:"KRAS/NRAS/BRAF + MSI (según muestra). Optimizado para decisiones terapéuticas.", tags:["Oncología","Colon"], price: 6500 },
    { id:"pgx", name:"Farmacogenómica", desc:"Recomendaciones de dosis y riesgo de eventos adversos por variantes farmacogenéticas.", tags:["PGx","Bienestar"], price: 4200 },
    { id:"carrier", name:"Portadores · Tamiz", desc:"Tamiz de portadores para planeación familiar. Panel configurable.", tags:["Reproductivo","Panel"], price: 5100 }
  
  ];

const state = {
  screen: "home",
  catalog: [...demoCatalog],
  cart: new Set(),
  catalogSource: "demo",
  checkout: null,
  payTab: "card",
};

function money(n){
  return new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" }).format(n || 0);
}

function showToast(msg){
  if(!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2200);
}

// Bridge: allow other scripts (e.g. Firebase module) to trigger toasts
window.addEventListener("nomad:toast", (e) => {
  if(e && typeof e.detail === "string" && e.detail.trim()) showToast(e.detail);
});
window.NOMAD_TOAST = showToast;


function setScreen(next){
  // cleanup listeners when leaving screens
  if(state && state._payHistoryUnsub && state.screen === "pay" && next !== "pay"){
    try{ state._payHistoryUnsub(); }catch(e){}
    state._payHistoryUnsub = null;
  }
  if(state && state._resultsUnsub && state.screen === "results" && next !== "results"){
    try{ state._resultsUnsub(); }catch(e){}
    state._resultsUnsub = null;
  }
  state.screen = next;
  screens.forEach(s => s.classList.toggle("active", s.dataset.screen === next));
  navBtns.forEach(b => b.classList.toggle("active", b.dataset.nav === next || (next === "pay" && b.dataset.nav === "quote")));

  // Update topbar title/subtitle
  const titleMap = {
    home: ["NOMAD", "Genética clínica · Programas · Clínicas"],
    catalog: ["Catálogo", "Paneles y estudios disponibles"],
    quote: ["Cotizar", "Cotización rápida"],
    pay: ["Pago", "Tarjeta · Transferencia · Depósito"],
    results: ["Resultados", "Seguimiento y estatus"],
    profile: ["Perfil", "Cuenta y preferencias"]
  };
  const [t, sub] = titleMap[next] || ["NOMAD", "Genética clínica"];
  setText(topTitle, t);
  setText(topSub, sub);

  // Search placeholder changes
  const phMap = {
    home: "Buscar panel, muestra, ID, paciente…",
    catalog: "Buscar panel o biomarcador…",
    quote: "Buscar estudio para agregar…",
    pay: "Pago y comprobantes…",
    results: "Buscar folio o paciente…",
    profile: "Buscar ajuste…"
  };
  if(searchInput){
    searchInput.placeholder = phMap[next] || "Buscar…";
    searchInput.value = "";
  }

  // render screen specific
  if(next === "catalog") renderCatalog();
  if(next === "quote") renderQuote();
  if(next === "pay") renderPayment();
  if(next === "results"){ initResultsLive(); renderResults(); }
}

navBtns.forEach(b => on(b, "click", () => setScreen(b.dataset.nav)));

on($("#btnQuickCatalog"), "click", () => setScreen("catalog"));
on($("#btnQuickQuote"), "click", () => setScreen("quote"));
on($("#btnQuickResults"), "click", () => setScreen("results"));
on($("#btnQuickSupport"), "click", () => {
  showToast("Soporte: demo@nomadgenetics.com");
});

on($("#btnBell"), "click", () => showToast("Notificaciones: sin novedades"));
on($("#btnScan"), "click", () => showToast("Escáner: disponible en app nativa"));

on(searchInput, "input", () => {
  if(state.screen === "catalog") renderCatalog(searchInput.value);
  if(state.screen === "quote") renderQuote(searchInput.value);
  if(state.screen === "results") renderResults(searchInput.value);
});

function renderCatalog(q=""){
  const list = $("#catalogList");
  if(!list) return;
  const query = q.trim().toLowerCase();
  const filtered = state.catalog.filter(it =>
    !query ||
    it.name.toLowerCase().includes(query) ||
    it.desc.toLowerCase().includes(query) ||
    it.tags.join(" ").toLowerCase().includes(query)
  );

  list.innerHTML = filtered.map(it => {
    const inCart = state.cart.has(it.id);
    const tags = it.tags.map(t => `<span class="chip">${t}</span>`).join("");
    return `
      <div class="item">
        <div class="ic" aria-hidden="true">🧬</div>
        <div style="flex:1; min-width:0">
          <div class="row">
            <div style="min-width:0">
              <h4 title="${it.name}">${it.name}</h4>
              <small style="color:rgba(255,255,255,.55)">${money(it.price)} · IVA incluido</small>
            </div>
            <button class="btn small ${inCart ? "ghost":""}" data-add="${it.id}">
              ${inCart ? "Quitar" : "Agregar"}
            </button>
          </div>
          <p>${it.desc}</p>
          <div class="meta">${tags}</div>
        </div>
      </div>
    `;
  }).join("") || `<div class="card pad"><b>Sin resultados</b><div class="hint">Prueba con “oncología”, “NGS”, “BRCA”…</div></div>`;

  $$("[data-add]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.add;
      if(state.cart.has(id)) state.cart.delete(id);
      else state.cart.add(id);
      renderCatalog(searchInput.value);
      if($("#quotePick") && $("#quoteCart")) renderQuote(searchInput ? searchInput.value : ""); // keep in sync
      showToast(state.cart.has(id) ? "Agregado a cotización" : "Removido de cotización");
      setText($("#cartCount"), state.cart.size.toString());
    });
  });
}

function renderQuote(q=""){
  const pick = $("#quotePick");
  const cartList = $("#quoteCart");
  if(!pick || !cartList) return;
  const query = q.trim().toLowerCase();

  const filtered = state.catalog.filter(it =>
    !query || it.name.toLowerCase().includes(query) || it.tags.join(" ").toLowerCase().includes(query)
  );

  pick.innerHTML = filtered.map(it => `
    <option value="${it.id}">${it.name} — ${money(it.price)}</option>
  `).join("");

  // Cart
  const items = state.catalog.filter(it => state.cart.has(it.id));
  const subtotal = items.reduce((a,b)=>a+b.price,0);
  const total = subtotal;

  cartList.innerHTML = items.map(it => `
    <div class="minirow cartline">
      <div style="min-width:0">
        <b>${it.name}</b>
        <div class="hint">${it.tags.join(" · ")}</div>
      </div>
      <div class="right">
        <span>${money(it.price)}</span>
        <button class="iconbtn sm danger" type="button" data-remove="${it.id}" aria-label="Eliminar">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `).join("") || `<div class="hint">Aún no agregas estudios. Ve al Catálogo o usa el selector de arriba.</div>`;

  $$("[data-remove]", cartList).forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remove;
      state.cart.delete(id);
      setText($("#cartCount"), state.cart.size.toString());
      const cc2 = $("#cartCount2");
      if(cc2) cc2.textContent = state.cart.size.toString();
      // Mantener catálogo sincronizado si el usuario vuelve
      renderCatalog(searchInput.value);
      renderQuote(searchInput ? searchInput.value : "");
      showToast("Estudio eliminado");
    });
  });

  setText($("#qSubtotal"), money(subtotal));
  setText($("#qTotal"), money(total));

  const cc2 = $("#cartCount2");
  if(cc2) cc2.textContent = state.cart.size.toString();

  const btnPreview = $("#btnPreview");
  if(btnPreview){
    btnPreview.disabled = items.length === 0;
    btnPreview.onclick = () => openSheet({ subtotal, total, items });
  }

  const btnSave = $("#btnSave");
  if(btnSave) btnSave.disabled = items.length === 0;

  const btnBuy = $("#btnBuy");
  if(btnBuy) btnBuy.disabled = items.length === 0;
}

on($("#btnAddToQuote"), "click", () => {
  const pick = $("#quotePick");
  const id = pick ? pick.value : "";
  if(!id) return;
  state.cart.add(id);
  setText($("#cartCount"), state.cart.size.toString());
  const cc2 = $("#cartCount2");
  if(cc2) cc2.textContent = state.cart.size.toString();
  renderQuote(searchInput ? searchInput.value : "");
  showToast("Agregado a cotización");
});


function openSheet(summary){
  if(!sheet) return;
  const { subtotal, total, items } = summary;

  const sheetList = $("#sheetList");
  if(sheetList) sheetList.innerHTML = items.map(it => `
    <div class="minirow">
      <span>${it.name}</span>
      <span>${money(it.price)}</span>
    </div>
  `).join("");

  setText($("#sheetSubtotal"), money(subtotal));
  setText($("#sheetTotal"), money(total));

  if(sheet) sheet.classList.add("show");
}

function closeSheet(){
  if(!sheet) return;
  sheet.classList.remove("show");
}
on($("#sheetClose"), "click", closeSheet);
on(sheet, "click", (e) => { if(e.target === sheet) closeSheet(); });

// === Acciones del resumen (PDF + Enviar) ===
function buildQuoteText(payload){
  const { patient, items, subtotal, total } = payload;
  const dateStr = new Date().toLocaleString("es-MX");
  const lines = [];
  lines.push(`Cotización NOMAD (${dateStr})`);
  if(patient?.nombre) lines.push(`Paciente: ${patient.nombre}`);
  if(patient?.expediente) lines.push(`Expediente: ${patient.expediente}`);
  if(patient?.sede) lines.push(`Sede: ${patient.sede}`);
  lines.push("");
  lines.push("Estudios:");
  items.forEach((it, idx) => lines.push(`${idx+1}. ${it.name} — ${money(it.price)}`));
  lines.push("");
  lines.push(`Subtotal: ${money(subtotal)}`);
  lines.push(`Total: ${money(total)}`);
  return lines.join("\n");
}

async function copyToClipboard(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch(e){
    // fallback
    try{
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    }catch(e2){
      return false;
    }
  }
}

function openWhatsAppWithText(text){
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function generateQuotePDF(){
  const payload = buildCheckoutPayload();
  if(!payload.items.length){
    showToast("No hay estudios para generar PDF");
    return;
  }

  // Guardamos el payload en localStorage para que print.html lo lea
  try{
    localStorage.setItem("nomad_print_payload_v1", JSON.stringify(payload));
  }catch(e){}

  const url = new URL("print.html", window.location.href).href;
  const w = window.open(url, "_blank");
  if(!w){
    showToast("Bloqueado por el navegador. Permite ventanas emergentes.");
    return;
  }
}

async function sendQuote(){
  const payload = buildCheckoutPayload();
  if(!payload.items.length){
    showToast("No hay estudios para enviar");
    return;
  }

  // Guardamos el payload para que print.html lo use y genere/comparta el PDF
  try{
    localStorage.setItem("nomad_print_payload_v1", JSON.stringify(payload));
  }catch(e){}

  const url = new URL("print.html?mode=share", window.location.href).href;
  const w = window.open(url, "_blank");
  if(!w){
    showToast("El navegador bloqueó la ventana. Permite popups para compartir/descargar el PDF.");
  }
}

on($("#btnSheetPdf"), "click", generateQuotePDF);
on($("#btnSheetSend"), "click", sendQuote);

const PAY_WHATSAPP = "5215543508976"; // Cambia aquí tu WhatsApp para comprobantes (formato: 52 + número)

function buildCheckoutPayload(){
  const items = state.catalog.filter(it => state.cart.has(it.id));
  const subtotal = items.reduce((a,b)=>a+b.price,0);
  const total = subtotal;

  return {
    patient: {
      nombre: $("#pName")?.value || "",
      expediente: $("#pExp")?.value || "",
      sede: $("#pSite")?.value || ""
    },
    items: items.map(i => ({ id:i.id, name:i.name, price:i.price, tags:i.tags })),
    subtotal,
    total,
    timestamp: new Date().toISOString()
  };
}

async function saveCheckoutToFirebase(payload, silent=false){
try{
  let fire = window.NOMAD_FIRE;
  if(!fire){
    try{
      fire = await waitForFirebase();
    }catch(e){
      try{ console.error("[NOMAD] Firebase no listo:", e); }catch(_){}
      if(!silent) window.dispatchEvent(new CustomEvent("nomad:toast", { detail: "Firebase no cargó (revisa consola)" }));
      return null;
    }
  }
  if(fire && typeof fire.saveCheckout === "function"){
    if(fire.authReady){ try{ await fire.authReady; }catch(e){} }
    try{ console.log("[NOMAD] Guardando cotización en Firebase…"); }catch(e){}
    const id = await fire.saveCheckout(payload);
    try{ localStorage.setItem("nomad_last_checkout_id", id); }catch(e){}
    if(!silent) window.dispatchEvent(new CustomEvent("nomad:toast", { detail: "Cotización guardada en Firebase" }));
    return id;
  }else{
    if(!silent) window.dispatchEvent(new CustomEvent("nomad:toast", { detail: "Firebase no está configurado" }));
  }

  }catch(err){
    if(!silent){
      const msg = (err && err.message) ? err.message : "No se pudo guardar en Firebase";
      window.dispatchEvent(new CustomEvent("nomad:toast", { detail: msg }));
    }
  }
  return null;
}

const btnSave = $("#btnSave");
if(btnSave){
  btnSave.addEventListener("click", async () => {
    try{ console.log("[NOMAD] Click Guardar"); }catch(e){}
    const payload = buildCheckoutPayload();
    if(!payload.items.length){
      showToast("Agrega al menos un estudio");
      return;
    }
    const p = payload.patient || {};
    if(!(p.nombre||"").toString().trim() || !(p.expediente||"").toString().trim() || !(p.sede||"").toString().trim()){
      showToast("Completa Nombre, Expediente y Sede");
      return;
    }
    state.checkout = payload;
    await saveCheckoutToFirebase(payload);
  });
}

const btnBuy = $("#btnBuy");
if(btnBuy){
  btnBuy.addEventListener("click", async () => {
    try{ console.log("[NOMAD] Click Generar cotización"); }catch(e){}
    const payload = buildCheckoutPayload();
    if(!payload.items.length){
      showToast("Agrega al menos un estudio");
      return;
    }
    const p = payload.patient || {};
    if(!(p.nombre||"").toString().trim() || !(p.expediente||"").toString().trim() || !(p.sede||"").toString().trim()){
      showToast("Completa Nombre, Expediente y Sede");
      return;
    }
    state.checkout = payload;

    // Guardar primero (best-effort) y luego abrir la interfaz de pago
    await saveCheckoutToFirebase(payload);

    setScreen("pay");
  });
}

const btnBack = $("#btnBackToQuote");
if(btnBack){
  btnBack.addEventListener("click", (e) => {
    e.preventDefault();
    setScreen("quote");
  });
}

function renderPayment(){
  // si alguien entra directo, armamos el payload desde el carrito
  if(!state.checkout) state.checkout = buildCheckoutPayload();

  const sum = $("#paySummary");
  const { patient, items, subtotal, total } = state.checkout;

  sum.innerHTML = `
    <div class="row">
      <div>
        <h3>Resumen de compra</h3>
        <small>${items.length} estudio(s) · ${patient.sede || "Sede no indicada"}</small>
      </div>
      <span class="badge blue"><i class="fa-solid fa-receipt" aria-hidden="true"></i> ${money(total)}</span>
    </div>
    <div class="hr"></div>
    ${items.map(it => `
      <div class="minirow">
        <span>${it.name}</span>
        <span>${money(it.price)}</span>
      </div>
    `).join("")}
    <div class="hr"></div>
    <div class="minirow"><span>Subtotal</span><b>${money(subtotal)}</b></div>
    <div class="minirow"><span>Total</span><b>${money(total)}</b></div>
  
    <div class="hr"></div>
    <div class="row" style="align-items:flex-start">
      <div>
        <h3 style="margin:0">Historial (en vivo)</h3>
        <small>Últimas cotizaciones guardadas</small>
      </div>
      <button class="btn ghost" type="button" id="btnTrackNow"><i class="fa-solid fa-location-dot"></i>&nbsp;Seguimiento</button>
    </div>
    <div id="payHistory" style="margin-top:10px"></div>
`;

  initPayHistory();

  // tabs
  const tabs = $$(".segbtn", $("#payTabs"));
  tabs.forEach(b => b.classList.toggle("active", b.dataset.paytab === state.payTab));
  tabs.forEach(b => b.setAttribute("aria-selected", b.dataset.paytab === state.payTab ? "true" : "false"));

  tabs.forEach(b => {
    b.onclick = () => {
      state.payTab = b.dataset.paytab;
      renderPayment();
    };
  });

  renderPayPanel(state.payTab);
}


function renderPayHistory(rows){
  const box = $("#payHistory");
  if(!box) return;

  if(!Array.isArray(rows) || rows.length === 0){
    box.innerHTML = `<div class="hint">Sin historial aún. Presiona “Comprar” para guardar una cotización.</div>`;
    return;
  }

  const sorted = rows.slice().sort((a,b) => (b.clientTs||0) - (a.clientTs||0));
  box.innerHTML = sorted.map(r => {
    const when = r.clientTs ? new Date(r.clientTs).toLocaleString("es-MX") : "";
    const exp = (r.expediente || "Sin expediente").toString();
    const count = Array.isArray(r.items) ? r.items.length : 0;
    const total = typeof r.total === "number" ? r.total : 0;

    return `
      <div class="card pad" style="margin-top:10px">
        <div class="row" style="align-items:flex-start">
          <div style="min-width:0">
            <h3 style="margin:0; font-size:15px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${exp}</h3>
            <small style="color:rgba(255,255,255,.6)">${when} · ${count} estudio(s)</small>
          </div>
          <span class="badge cyan">${money(total)}</span>
        </div>
        <div class="actions" style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap">
          <button class="btn ghost" type="button" data-htrack="${r.id}">
            <i class="fa-solid fa-location-dot"></i>&nbsp;Seguimiento
          </button>
          <button class="btn ghost" type="button" data-hpdf="${r.id}">
            <i class="fa-solid fa-file-pdf"></i>&nbsp;PDF
          </button>
          <button class="btn" type="button" data-huse="${r.id}">
            <i class="fa-solid fa-cart-shopping"></i>&nbsp;Usar esta
          </button>
        </div>
      </div>
    `;
  }).join("");

  // attach actions
  $$("[data-htrack]").forEach(b => b.onclick = () => {
    const id = b.getAttribute("data-htrack");
    showToast("Seguimiento: " + id);
    setScreen("results");
  });

  $$("[data-hpdf]").forEach(b => b.onclick = () => {
    const id = b.getAttribute("data-hpdf");
    const found = sorted.find(x => x.id === id);
    if(!found){ showToast("No encontrado"); return; }
    try{ localStorage.setItem("nomad_print_payload_v1", JSON.stringify(found)); }catch(e){}
    window.open(new URL("print.html", window.location.href).href, "_blank");
  });

  $$("[data-huse]").forEach(b => b.onclick = () => {
    const id = b.getAttribute("data-huse");
    const found = sorted.find(x => x.id === id);
    if(!found){ showToast("No encontrado"); return; }
    // Rehidratar checkout local con esa cotización
    state.checkout = {
      patient: {
        nombre: found.patientNombre || found.patient?.nombre || "",
        expediente: found.expediente || "",
        sede: found.sede || ""
      },
      items: Array.isArray(found.items) ? found.items : [],
      subtotal: typeof found.subtotal === "number" ? found.subtotal : (typeof found.total === "number" ? found.total : 0),
      total: typeof found.total === "number" ? found.total : 0,
      timestamp: found.timestamp || new Date(found.clientTs || Date.now()).toISOString()
    };
    showToast("Cotización cargada");
    setScreen("pay");
  });
}

async function initPayHistory(){
  const sum = $("#paySummary");
  const btnTrack = $("#btnTrackNow");
  if(btnTrack){
    btnTrack.onclick = () => {
      showToast("Seguimiento");
      setScreen("results");
    };
  }

  let fire = window.NOMAD_FIRE;
  if(!fire){ try{ fire = await waitForFirebase(); }catch(e){} }
  const { patient } = state.checkout || buildCheckoutPayload();

  if(!fire || typeof fire.watchHistory !== "function"){
    const box = $("#payHistory");
    if(box) box.innerHTML = `<div class="hint">Conecta Firebase para ver el historial en vivo.</div>`;
    return;
  }

  // (re)subscribe
  if(state._payHistoryUnsub){
    try{ state._payHistoryUnsub(); }catch(e){}
    state._payHistoryUnsub = null;
  }

  state._payHistoryUnsub = fire.watchHistory({ expediente: (patient && patient.expediente) ? patient.expediente : "" }, (rows) => {
    renderPayHistory(rows);
  });
}


function renderPayPanel(tab){
  const panel = $("#payPanel");
  const { patient, items, total } = state.checkout || buildCheckoutPayload();

  const ref = (patient.expediente || "NOMAD").toString().trim() || "NOMAD";
  const msg = encodeURIComponent(
    `NOMAD · Comprobante de pago\n` +
    `Paciente: ${patient.nombre || "-"}\n` +
    `Expediente: ${patient.expediente || "-"}\n` +
    `Sede: ${patient.sede || "-"}\n` +
    `Total: ${money(total)}\n` +
    `Estudios: ${items.map(i => i.name).join(", ")}`
  );

  if(tab === "card"){
    panel.innerHTML = `
      <div class="hint">Pago con tarjeta (demo). Se puede integrar Stripe/Conekta para cobro real.</div>
      <div class="form" style="margin-top:10px">
        <div class="field">
          <label>Nombre en la tarjeta</label>
          <input class="input" placeholder="Ej. Dr. Juan Pérez" />
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>Número</label>
            <input class="input" inputmode="numeric" placeholder="0000 0000 0000 0000" />
          </div>
          <div class="field" style="flex:0.6">
            <label>Vence</label>
            <input class="input" inputmode="numeric" placeholder="MM/AA" />
          </div>
          <div class="field" style="flex:0.4">
            <label>CVC</label>
            <input class="input" inputmode="numeric" placeholder="123" />
          </div>
        </div>
        <button class="btn" type="button" id="btnPayNow"><i class="fa-solid fa-lock"></i>&nbsp;Pagar ahora (demo)</button>
      </div>
    `;
    $("#btnPayNow").onclick = () => showToast("Demo: integrar pasarela (Stripe/Conekta)");
    return;
  }

  if(tab === "transfer"){
    panel.innerHTML = `
      <div class="hint">Transferencia bancaria</div>
      <div class="paycode" style="display:grid; grid-template-columns:1.2fr .8fr; gap:12px; align-items:start">
        <div>
          <div><b>Beneficiario:</b> NOMAD INNOVATIONS, S.A. de C.V.</div>
          <div><b>Banco:</b> Banbajío</div>
          <div><b>Cuenta:</b> 0242675280201</div>
          <div><b>CLABE interbancaria:</b> 030420900017142148</div>
          <div><b>Referencia:</b> ${ref}</div>
        </div>
        <div style="text-align:right">
          <img src="assets/img/qr-nomad.png" alt="QR" style="width:110px; height:110px; border-radius:10px; border:1px solid rgba(255,255,255,.08); background:#fff; padding:6px" />
        </div>
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn ghost" type="button" id="btnCopyClabe"><i class="fa-solid fa-copy"></i>&nbsp;Copiar CLABE</button>
        <button class="btn" type="button" id="btnSendProof"><i class="fa-brands fa-whatsapp"></i>&nbsp;Enviar comprobante</button>
      </div>
    `;
    $("#btnCopyClabe").onclick = async () => {
      try{ await navigator.clipboard.writeText("030420900017142148"); showToast("CLABE copiada"); }
      catch(e){ showToast("No se pudo copiar"); }
    };
    $("#btnSendProof").onclick = () => window.open(`https://wa.me/${PAY_WHATSAPP}?text=${msg}`, "_blank");
    return;
  }

  // deposit
  panel.innerHTML = `
    <div class="hint">Depósito en ventanilla / practicaja</div>
    <div class="paycode" style="display:grid; grid-template-columns:1.2fr .8fr; gap:12px; align-items:start">
      <div>
        <div><b>Beneficiario:</b> NOMAD INNOVATIONS, S.A. de C.V.</div>
        <div><b>Banco:</b> Banbajío</div>
        <div><b>Cuenta:</b> 0242675280201</div>
        <div><b>CLABE interbancaria:</b> 030420900017142148</div>
        <div><b>Referencia:</b> ${ref}</div>
      </div>
      <div style="text-align:right">
        <img src="assets/img/qr-nomad.png" alt="QR" style="width:110px; height:110px; border-radius:10px; border:1px solid rgba(255,255,255,.08); background:#fff; padding:6px" />
      </div>
    </div>
    <div class="actions" style="margin-top:12px">
      <button class="btn ghost" type="button" id="btnSendProof2"><i class="fa-brands fa-whatsapp"></i>&nbsp;Enviar comprobante</button>
      <button class="btn" type="button" id="btnMarkPaid"><i class="fa-solid fa-circle-check"></i>&nbsp;Marcar como pagado (demo)</button>
    </div>
  `;
  $("#btnSendProof2").onclick = () => window.open(`https://wa.me/${PAY_WHATSAPP}?text=${msg}`, "_blank");
  $("#btnMarkPaid").onclick = () => showToast("Demo: registrar pago en backend/Firebase");
}


on($("#btnShare"), "click", async () => {
  try{
    const txt = "NOMAD · Cotización (demo): revisa tu lista de estudios y total en la app.";
    if(navigator.share){
      await navigator.share({ title:"NOMAD Cotización", text:txt });
      showToast("Compartido");
    }else{
      await navigator.clipboard.writeText(txt);
      showToast("Copiado al portapapeles");
    }
  }catch(err){
    showToast("No se pudo compartir");
  }
});

async function initResultsLive(){
  let fire = window.NOMAD_FIRE;
  if(!fire){ try{ fire = await waitForFirebase(); }catch(e){ return; } }
  if(!fire || typeof fire.watchHistory !== "function"){
    // keep demo list if no firebase
    return;
  }
  // wait auth if required by rules
  if(fire.authReady){
    try{ await fire.authReady; }catch(e){}
  }

  // (re)subscribe
  if(state._resultsUnsub){
    try{ state._resultsUnsub(); }catch(e){}
    state._resultsUnsub = null;
  }

  state._resultsUnsub = fire.watchHistory({ expediente: "" }, (rows) => {
    state.resultsRows = Array.isArray(rows) ? rows : [];
    renderResults(searchInput ? searchInput.value : "");
  });
}

function _fmtFecha(ts){
  try{
    if(!ts) return "";
    if(typeof ts === "string") return ts;
    if(typeof ts === "number") return new Date(ts).toLocaleString("es-MX");
    if(ts && typeof ts.toDate === "function") return ts.toDate().toLocaleString("es-MX");
    if(ts && typeof ts.seconds === "number") return new Date(ts.seconds*1000).toLocaleString("es-MX");
    return "";
  }catch(e){ return ""; }
}

function _badgeForStatus(s){
  const v = (s || "").toString().toLowerCase();
  if(v.includes("listo") || v.includes("entregado") || v.includes("final")) return "good";
  if(v.includes("recib")) return "blue";
  if(v.includes("proceso") || v.includes("pend") || v.includes("en ") ) return "warn";
  return "chip";
}

function renderResults(q=""){
  const list = $("#resultsList");
  if(!list) return;

  const query = (q || "").trim().toLowerCase();
  const rows = Array.isArray(state.resultsRows) ? state.resultsRows : [];

  // If no firebase data, keep a small demo list
  let data = [];
  if(rows.length){
    data = rows.map(r => {
      const paciente = r.patientNombre || r.patient?.nombre || "Paciente";
      const folio = r.folio || r.folioNomad || r.id || "NMD";
      const status = r.status || "Pendiente";
      const fecha = _fmtFecha(r.createdAt) || _fmtFecha(r.timestamp) || "";
      const items = Array.isArray(r.items) ? r.items : [];
      const names = items.map(x => x?.name).filter(Boolean);
      const estudio = names.length ? (names.slice(0,2).join(", ") + (names.length>2 ? ` + ${names.length-2} más` : "")) : (r.estudio || "Cotización");
      return { folio, paciente, estudio, status, badge:_badgeForStatus(status), fecha, raw:r };
    });
  }else{
    data = [
      { folio:"NMD-2409-1182", paciente:"María G.", estudio:"Pulmón · Biomarcadores", status:"En proceso", badge:"warn", fecha:"Hoy 12:40" },
      { folio:"NMD-2409-1129", paciente:"Carlos R.", estudio:"BRCA1/2 + HRD", status:"Listo", badge:"good", fecha:"Ayer 18:10" },
      { folio:"NMD-2409-0981", paciente:"Lupita M.", estudio:"OncoPanel Nomad", status:"Recibido", badge:"blue", fecha:"02 Dic" },
    ];
  }

  const filtered = data.filter(d => {
    if(!query) return true;
    return (
      (d.folio||"").toLowerCase().includes(query) ||
      (d.paciente||"").toLowerCase().includes(query) ||
      (d.estudio||"").toLowerCase().includes(query) ||
      (d.status||"").toLowerCase().includes(query)
    );
  });

  if(!rows.length){
    // show hint above demo list
    list.innerHTML = `
      <div class="hint" style="margin-bottom:12px">
        Aún no hay movimientos de Firebase para este dispositivo. Guarda una cotización para verla aquí.
      </div>
    ` + filtered.map(d => `
      <div class="item">
        <div class="ic" aria-hidden="true">📄</div>
        <div style="flex:1; min-width:0">
          <div class="row">
            <div style="min-width:0">
              <h4>${d.folio}</h4>
              <small style="color:rgba(255,255,255,.55)">${d.paciente} · ${d.fecha}</small>
            </div>
            <span class="badge ${d.badge}">${d.status}</span>
          </div>
          <p>${d.estudio}</p>
          <div class="meta">
            <span class="chip">Tracking</span>
            <span class="chip">PDF</span>
            <span class="chip">Historial</span>
          </div>
        </div>
      </div>
    `).join("");
    return;
  }

  list.innerHTML = filtered.map(d => `
    <div class="item">
      <div class="ic" aria-hidden="true">📄</div>
      <div style="flex:1; min-width:0">
        <div class="row">
          <div style="min-width:0">
            <h4>${d.folio}</h4>
            <small style="color:rgba(255,255,255,.55)">${d.paciente} · ${d.fecha}</small>
          </div>
          <span class="badge ${d.badge}">${d.status}</span>
        </div>
        <p>${d.estudio}</p>
        <div class="meta">
          <button class="chip" data-rtrack="${d.folio}">Tracking</button>
          <button class="chip" data-rpdf="${d.folio}">PDF</button>
          <button class="chip" data-rhist="${d.folio}">Historial</button>
        </div>
      </div>
    </div>
  `).join("");

  $$("[data-rtrack]").forEach(b => b.addEventListener("click", () => showToast("Tracking: " + b.dataset.rtrack)));
  $$("[data-rpdf]").forEach(b => b.addEventListener("click", () => showToast("PDF: " + b.dataset.rpdf)));
  $$("[data-rhist]").forEach(b => b.addEventListener("click", () => showToast("Historial: " + b.dataset.rhist)));
}


function initHeroCarousel(){
  const root = $("#heroCarousel");
  if(!root) return;

  const track = root.querySelector(".carousel-track");
  if(!track) return;
  const slides = $$(".slide", track);
  const dotsWrap = root.querySelector("[data-dots]");
  if(!dotsWrap) return;
  const prevBtn = root.querySelector("[data-prev]");
  const nextBtn = root.querySelector("[data-next]");

  let idx = 0;
  let autoplay = null;
  let isPaused = false;

  // build dots
  dotsWrap.innerHTML = "";
  slides.forEach((_, i) => {
    const d = document.createElement("button");
    d.className = "dot";
    d.type = "button";
    d.setAttribute("aria-label", `Ir a la tarjeta ${i+1}`);
    d.addEventListener("click", () => go(i, true));
    dotsWrap.appendChild(d);
  });

  const dots = $$(".dot", dotsWrap);

  function clamp(i){
    const n = slides.length;
    return (i % n + n) % n;
  }

  function go(i, user=false){
    idx = clamp(i);
    const left = slides[idx].offsetLeft;
    track.scrollTo({ left, behavior: user ? "smooth" : "smooth" });
    update();
  }

  function update(){
    dots.forEach((d, i) => d.classList.toggle("active", i === idx));
  }

  function syncFromScroll(){
    // pick the closest slide to the current scroll
    const x = track.scrollLeft;
    let best = 0, bestDist = Infinity;
    slides.forEach((s, i) => {
      const dist = Math.abs(s.offsetLeft - x);
      if(dist < bestDist){ bestDist = dist; best = i; }
    });
    idx = best;
    update();
  }

  function start(){
    stop();
    autoplay = setInterval(() => {
      if(isPaused) return;
      go(idx + 1);
    }, 6500);
  }

  function stop(){
    if(autoplay) clearInterval(autoplay);
    autoplay = null;
  }

  prevBtn?.addEventListener("click", () => go(idx - 1, true));
  nextBtn?.addEventListener("click", () => go(idx + 1, true));
  on(track, "scroll", () => window.requestAnimationFrame(syncFromScroll));

  // pause on hover/touch
  on(root, "mouseenter", () => (isPaused = true));
  on(root, "mouseleave", () => (isPaused = false));
  on(root, "touchstart", () => (isPaused = true));
  on(root, "touchend", () => (isPaused = false));

  update();
  start();
}

// initial
hydrateCatalog();
renderResults();
setScreen("home");
initHeroCarousel();
// Service Worker
if("serviceWorker" in navigator){
  // Avoid caching issues during local development
  if(location.hostname === "localhost" || location.hostname === "127.0.0.1"){
    navigator.serviceWorker.getRegistrations().then((regs)=> regs.forEach(r=>r.unregister())).catch(()=>{});
  }else{
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(()=>{}));
  }
}

