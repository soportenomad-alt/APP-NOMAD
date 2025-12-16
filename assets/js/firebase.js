// NOMAD Firebase bridge (classic script + dynamic imports)
// Motivo: cuando firebase.js se carga como <script type="module"> puede fallar en algunos entornos
// (p. ej. pruebas locales / bloqueos de módulo). Con este enfoque, el script funciona como "defer"
// normal y usa import() dinámico para el SDK modular.

(function(){
  const TAG = "[NOMAD]";
  const FIREBASE_VER = "10.12.5";
  const APP_NAME = "NOMAD";

  function log(){ try{ console.log(TAG, ...arguments); }catch(e){} }
  function err(){ try{ console.error(TAG, ...arguments); }catch(e){} }
  function toast(msg){
    try{ window.dispatchEvent(new CustomEvent("nomad:toast", { detail: String(msg||"") })); }catch(e){}
  }

  // Firebase config (del proyecto app-nomad-eb33c)
  const firebaseConfig = {
    apiKey: "AIzaSyDpXhEN1p-n3gyAnRnqJ1QbVgC7k5A4hKU",
    authDomain: "app-nomad-eb33c.firebaseapp.com",
    projectId: "app-nomad-eb33c",
    storageBucket: "app-nomad-eb33c.firebasestorage.app",
    messagingSenderId: "988144072536",
    appId: "1:988144072536:web:34519ce6d9c1a5bc7ad72d"
  };

  // Colecciones (para que lo veas tanto en "cotizaciones" como en tus seguimientos/resultados)
  const MAIN_COLLECTION = "cotizaciones";
  const MIRROR_COLLECTIONS = ["seguimientos", "resultados"].filter(Boolean);

  function getDeviceId(){
    const key = "nomad_device_id_v1";
    let id = "";
    try{ id = localStorage.getItem(key) || ""; }catch(e){}
    if(!id){
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ("dev_" + Math.random().toString(16).slice(2) + Date.now());
      try{ localStorage.setItem(key, id); }catch(e){}
    }
    return id;
  }

  function makeFolio(){
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const rand = Math.floor(1000 + Math.random()*9000);
    return `NMD-${yy}${mm}-${rand}`;
  }

  // Exponer un objeto base para que app.js pueda detectar que existe, aunque aún esté cargando.
  // waitForFirebase() en app.js busca db o saveCheckout; aquí ponemos stubs y los reemplazamos al estar listos.
  const NOMAD_FIRE = (window.NOMAD_FIRE = window.NOMAD_FIRE || {});
  NOMAD_FIRE.__loading = true;
  NOMAD_FIRE.getDeviceId = getDeviceId;

  let __authReadyResolve;
  const authReady = new Promise((res) => { __authReadyResolve = res; });
  NOMAD_FIRE.authReady = authReady;

  async function boot(){
    log("firebase.js loaded (dynamic import)");

    // Carga SDK modular con import() dinámico
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VER}/`;
    let initializeApp, getAuth, signInAnonymously, onAuthStateChanged;
    let getFirestore, collection, addDoc, setDoc, doc, serverTimestamp, query, where, limit, onSnapshot;
    try{
      ({ initializeApp } = await import(base + "firebase-app.js"));
      ({ getAuth, signInAnonymously, onAuthStateChanged } = await import(base + "firebase-auth.js"));
      ({
        getFirestore,
        collection,
        addDoc,
        setDoc,
        doc,
        serverTimestamp,
        query,
        where,
        limit,
        onSnapshot
      } = await import(base + "firebase-firestore.js"));
    }catch(e){
      err("No se pudo cargar Firebase SDK (imports)", e);
      toast("Firebase SDK no cargó (revisa consola)");
      __authReadyResolve(null);
      NOMAD_FIRE.__loading = false;
      NOMAD_FIRE.__error = e;
      return;
    }

    // Init
    let app, db, auth;
    try{
      app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      auth = getAuth(app);
      NOMAD_FIRE.db = db;
      NOMAD_FIRE.auth = auth;
    }catch(e){
      err("No se pudo inicializar Firebase", e);
      toast("Firebase init falló (revisa consola)");
      __authReadyResolve(null);
      NOMAD_FIRE.__loading = false;
      NOMAD_FIRE.__error = e;
      return;
    }

    // Auth anónimo (recomendado si luego pones reglas con request.auth != null)
    try{
      onAuthStateChanged(auth, (user) => {
        if(user){
          try{ log("Auth listo:", user.uid); }catch(e){}
          __authReadyResolve(user);
        }
      });
    }catch(e){
      // No bloqueamos por esto
    }

    try{
      signInAnonymously(auth)
        .then((cred) => {
          try{ log("Auth anónimo OK:", cred?.user?.uid); }catch(e){}
          // onAuthStateChanged resolverá authReady
        })
        .catch((e) => {
          // Si el dominio no está autorizado (p. ej. pruebas desde file://), esto puede fallar.
          // Aun así, con reglas públicas debería poder escribir.
          err("Auth anónimo error:", e);
          toast("Auth: " + (e?.message || "No se pudo iniciar sesión"));
          __authReadyResolve(null);
        });
    }catch(e){
      __authReadyResolve(null);
    }

    async function saveCheckout(payload){
      const deviceId = getDeviceId();
      const patient = payload?.patient || {};
      const items = Array.isArray(payload?.items) ? payload.items : [];

      const data = {
        deviceId,
        folio: makeFolio(),
        expediente: (patient.expediente || "").toString().trim(),
        sede: (patient.sede || "").toString().trim(),
        patientNombre: (patient.nombre || "").toString().trim(),

        patient,
        items,
        subtotal: Number(payload?.subtotal || 0),
        total: Number(payload?.total || 0),
        timestamp: payload?.timestamp || new Date().toISOString(),

        status: "Pendiente",
        createdAt: serverTimestamp(),
        clientTs: Date.now(),
        app: APP_NAME,
        uiVersion: (window && window.NOMAD_UI_VERSION) ? window.NOMAD_UI_VERSION : undefined
      };

      // Guardar en colección principal
      const ref = await addDoc(collection(db, MAIN_COLLECTION), data);
      const id = ref.id;

      // Espejo en otras colecciones (opcional) con mismo ID
      if(MIRROR_COLLECTIONS.length){
        await Promise.all(MIRROR_COLLECTIONS.map((c) => {
          return setDoc(doc(db, c, id), { ...data, mainCollection: MAIN_COLLECTION, mainId: id }, { merge:true })
            .catch(() => null);
        }));
      }

      return id;
    }

    function watchHistory({ expediente = "" } = {}, cb = () => {}){
      const deviceId = getDeviceId();
      const exp = (expediente || "").toString().trim();

      // Query simple (sin índices compuestos)
      const q = exp
        ? query(collection(db, MAIN_COLLECTION), where("expediente", "==", exp), limit(20))
        : query(collection(db, MAIN_COLLECTION), where("deviceId", "==", deviceId), limit(20));

      return onSnapshot(q, (snap) => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        cb(rows);
      }, (e) => {
        toast("Firebase: " + (e?.message || "No se pudo leer el historial"));
        cb([]);
      });
    }

    // Export API
    NOMAD_FIRE.saveCheckout = saveCheckout;
    NOMAD_FIRE.watchHistory = watchHistory;
    NOMAD_FIRE.__loading = false;

    try{ window.dispatchEvent(new Event("nomad:firebase-ready")); }catch(e){}
    log("Firebase ready (project):", firebaseConfig.projectId);
    toast("Firebase conectado");
  }

  // Arrancar
  boot().catch((e) => {
    err("Firebase boot fatal", e);
    try{ __authReadyResolve(null); }catch(_){}
    NOMAD_FIRE.__loading = false;
    NOMAD_FIRE.__error = e;
    toast("Firebase boot falló (revisa consola)");
  });
})();
