const $ = (q, el=document) => el.querySelector(q);
const $$ = (q, el=document) => Array.from(el.querySelectorAll(q));

const screens = $$("[data-screen]");
const navBtns = $$("[data-nav]");
const topTitle = $("#topTitle");
const topSub = $("#topSub");
const searchInput = $("#globalSearch");
const toast = $("#toast");
const sheet = $("#sheet");

const UI_VERSION = "v6";
console.info("[NOMAD] UI", UI_VERSION);



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
    $("#cartCount").textContent = state.cart.size.toString();
    renderCatalog();
    renderQuote();
  }

  // remoto después
  try{
    const { items, source } = await loadCatalogFromRemote();
    state.catalog = items;
    state.cart.clear();
    state.catalogSource = source;
    $("#cartCount").textContent = state.cart.size.toString();
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
};

function money(n){
  return new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" }).format(n || 0);
}

function showToast(msg){
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2200);
}

function setScreen(next){
  state.screen = next;
  screens.forEach(s => s.classList.toggle("active", s.dataset.screen === next));
  navBtns.forEach(b => b.classList.toggle("active", b.dataset.nav === next));

  // Update topbar title/subtitle
  const titleMap = {
    home: ["NOMAD", "Genética clínica · Programas · Clínicas"],
    catalog: ["Catálogo", "Paneles y estudios disponibles"],
    quote: ["Cotizar", "Estimación rápida con desglose"],
    results: ["Resultados", "Seguimiento y estatus"],
    profile: ["Perfil", "Cuenta y preferencias"]
  };
  const [t, sub] = titleMap[next] || ["NOMAD", "Genética clínica"];
  topTitle.textContent = t;
  topSub.textContent = sub;

  // Search placeholder changes
  const phMap = {
    home: "Buscar panel, muestra, ID, paciente…",
    catalog: "Buscar panel o biomarcador…",
    quote: "Buscar estudio para agregar…",
    results: "Buscar folio o paciente…",
    profile: "Buscar ajuste…"
  };
  searchInput.placeholder = phMap[next] || "Buscar…";
  searchInput.value = "";

  // render screen specific
  if(next === "catalog") renderCatalog();
  if(next === "quote") renderQuote();
  if(next === "results") renderResults();
}

navBtns.forEach(b => b.addEventListener("click", () => setScreen(b.dataset.nav)));

$("#btnQuickCatalog").addEventListener("click", () => setScreen("catalog"));
$("#btnQuickQuote").addEventListener("click", () => setScreen("quote"));
$("#btnQuickResults").addEventListener("click", () => setScreen("results"));
$("#btnQuickSupport").addEventListener("click", () => {
  showToast("Soporte: demo@nomadgenetics.com");
});

$("#btnBell").addEventListener("click", () => showToast("Notificaciones: sin novedades"));
$("#btnScan").addEventListener("click", () => showToast("Escáner: disponible en app nativa"));

searchInput.addEventListener("input", () => {
  if(state.screen === "catalog") renderCatalog(searchInput.value);
  if(state.screen === "quote") renderQuote(searchInput.value);
  if(state.screen === "results") renderResults(searchInput.value);
});

function renderCatalog(q=""){
  const list = $("#catalogList");
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
      renderQuote(searchInput.value); // keep in sync
      showToast(state.cart.has(id) ? "Agregado a cotización" : "Removido de cotización");
      $("#cartCount").textContent = state.cart.size.toString();
    });
  });
}

function renderQuote(q=""){
  const pick = $("#quotePick");
  const cartList = $("#quoteCart");
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
  const disc = Number($("#discount").value || 0);
  const iva = Number($("#iva").value || 0);
  const discountAmt = subtotal * (disc/100);
  const taxed = (subtotal - discountAmt);
  const ivaAmt = taxed * (iva/100);
  const total = taxed + ivaAmt;

  cartList.innerHTML = items.map(it => `
    <div class="minirow">
      <div>
        <b>${it.name}</b>
        <div class="hint">${it.tags.join(" · ")}</div>
      </div>
      <span>${money(it.price)}</span>
    </div>
  `).join("") || `<div class="hint">Aún no agregas estudios. Ve al Catálogo o usa el selector de arriba.</div>`;

  $("#qSubtotal").textContent = money(subtotal);
  $("#qDiscount").textContent = `-${money(discountAmt)} (${disc || 0}%)`;
  $("#qIVA").textContent = `+${money(ivaAmt)} (${iva || 0}%)`;
  $("#qTotal").textContent = money(total);

  const btnPreview = $("#btnPreview");
  btnPreview.disabled = items.length === 0;

  btnPreview.onclick = () => openSheet({ subtotal, discountAmt, ivaAmt, total, items });
}

$("#btnAddToQuote").addEventListener("click", () => {
  const id = $("#quotePick").value;
  if(!id) return;
  state.cart.add(id);
  $("#cartCount").textContent = state.cart.size.toString();
  renderQuote(searchInput.value);
  showToast("Agregado a cotización");
});

["discount","iva"].forEach(id => {
  $("#"+id).addEventListener("input", () => renderQuote(searchInput.value));
});

function openSheet(summary){
  const { subtotal, discountAmt, ivaAmt, total, items } = summary;
  $("#sheetList").innerHTML = items.map(it => `
    <div class="minirow">
      <span>${it.name}</span>
      <span>${money(it.price)}</span>
    </div>
  `).join("");

  $("#sheetSubtotal").textContent = money(subtotal);
  $("#sheetDiscount").textContent = `-${money(discountAmt)}`;
  $("#sheetIVA").textContent = `+${money(ivaAmt)}`;
  $("#sheetTotal").textContent = money(total);

  sheet.classList.add("show");
}

function closeSheet(){
  sheet.classList.remove("show");
}
$("#sheetClose").addEventListener("click", closeSheet);
sheet.addEventListener("click", (e) => { if(e.target === sheet) closeSheet(); });

$("#btnExport").addEventListener("click", () => {
  const items = state.catalog.filter(it => state.cart.has(it.id));
  const payload = {
    patient: {
      nombre: $("#pName").value || "",
      expediente: $("#pExp").value || "",
      sede: $("#pSite").value || ""
    },
    items: items.map(i => ({ id:i.id, name:i.name, price:i.price, tags:i.tags })),
    discountPct: Number($("#discount").value || 0),
    ivaPct: Number($("#iva").value || 0),
    timestamp: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `NOMAD_cotizacion_${(payload.patient.expediente || "demo")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Exportado a JSON (demo)");
});

$("#btnShare").addEventListener("click", async () => {
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

function renderResults(q=""){
  const list = $("#resultsList");
  const query = q.trim().toLowerCase();
  const data = [
    { folio:"NMD-2409-1182", paciente:"María G.", estudio:"Pulmón · Biomarcadores", status:"En proceso", badge:"warn", fecha:"Hoy 12:40" },
    { folio:"NMD-2409-1129", paciente:"Carlos R.", estudio:"BRCA1/2 + HRD", status:"Listo", badge:"good", fecha:"Ayer 18:10" },
    { folio:"NMD-2409-0981", paciente:"Lupita M.", estudio:"OncoPanel Nomad", status:"Recibido", badge:"blue", fecha:"02 Dic" },
    { folio:"NMD-2408-7712", paciente:"José A.", estudio:"Farmacogenómica", status:"Entregado", badge:"good", fecha:"28 Nov" },
  ];
  const filtered = data.filter(d =>
    !query ||
    d.folio.toLowerCase().includes(query) ||
    d.paciente.toLowerCase().includes(query) ||
    d.estudio.toLowerCase().includes(query) ||
    d.status.toLowerCase().includes(query)
  );

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
          <span class="chip">Tracking</span>
          <span class="chip">PDF</span>
          <span class="chip">Historial</span>
        </div>
      </div>
    </div>
  `).join("");

  $$("[data-open]").forEach(b => b.addEventListener("click", () => showToast("Abrir resultado (demo)")));
}

$("#btnInstall").addEventListener("click", () => {
  showToast("Tip: En Chrome móvil → menú ⋮ → “Agregar a pantalla de inicio”");
});



function initHeroCarousel(){
  const root = $("#heroCarousel");
  if(!root) return;

  const track = root.querySelector(".carousel-track");
  const slides = $$(".slide", track);
  const dotsWrap = root.querySelector("[data-dots]");
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
  track.addEventListener("scroll", () => window.requestAnimationFrame(syncFromScroll), { passive:true });

  // pause on hover/touch
  root.addEventListener("mouseenter", () => (isPaused = true));
  root.addEventListener("mouseleave", () => (isPaused = false));
  root.addEventListener("touchstart", () => (isPaused = true), { passive:true });
  root.addEventListener("touchend", () => (isPaused = false), { passive:true });

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
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
