// NOMAD Firebase bridge (classic script + dynamic imports)
// Versión ajustada para separar cotizaciones por usuario real de la app
// y SIN autenticación anónima en este proyecto web.

(function(){
  const TAG = "[NOMAD]";
  const FIREBASE_VER = "10.12.5";
  const APP_NAME = "NOMAD";

  function log(){ try{ console.log(TAG, ...arguments); }catch(e){} }
  function err(){ try{ console.error(TAG, ...arguments); }catch(e){} }
  function toast(msg){
    try{ window.dispatchEvent(new CustomEvent("nomad:toast", { detail: String(msg||"") })); }catch(e){}
  }

  const firebaseConfig = {
    apiKey: "AIzaSyDpXhEN1p-n3gyAnRnqJ1QbVgC7k5A4hKU",
    authDomain: "app-nomad-eb33c.firebaseapp.com",
    projectId: "app-nomad-eb33c",
    storageBucket: "app-nomad-eb33c.firebasestorage.app",
    messagingSenderId: "988144072536",
    appId: "1:988144072536:web:34519ce6d9c1a5bc7ad72d"
  };

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

  function safeLocal(key){
    try{ return (localStorage.getItem(key) || "").toString().trim(); }catch(e){ return ""; }
  }

  function safeUrlParam(name){
    try{ return (new URLSearchParams(window.location.search).get(name) || "").toString().trim(); }catch(e){ return ""; }
  }

  function getProfileContext(){
    const ownerUid = safeLocal("nomad_profile_uid") || safeUrlParam("uid");
    const ownerEmail = (safeLocal("nomad_profile_email") || safeUrlParam("email")).toLowerCase();
    const ownerUsername = safeLocal("nomad_profile_username") || safeUrlParam("username");
    const ownerRole = safeLocal("nomad_profile_role") || safeUrlParam("role");
    const ownerName = safeLocal("nomad_profile_name") || safeUrlParam("name");
    const ownerKey = ownerUid || ownerEmail || [ownerRole, ownerUsername, getDeviceId()].filter(Boolean).join("|");
    return { ownerUid, ownerEmail, ownerUsername, ownerRole, ownerName, ownerKey };
  }

  function makeFolio(){
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const rand = Math.floor(1000 + Math.random()*9000);
    return `NMD-${yy}${mm}-${rand}`;
  }

  const NOMAD_FIRE = (window.NOMAD_FIRE = window.NOMAD_FIRE || {});
  NOMAD_FIRE.__loading = true;
  NOMAD_FIRE.getDeviceId = getDeviceId;
  NOMAD_FIRE.getProfileContext = getProfileContext;

  let __authReadyResolve;
  const authReady = new Promise((res) => { __authReadyResolve = res; });
  NOMAD_FIRE.authReady = authReady;

  async function boot(){
    log("firebase.js loaded (dynamic import)");

    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VER}/`;
    let initializeApp;
    let getFirestore, collection, addDoc, setDoc, doc, serverTimestamp, query, where, limit, onSnapshot, orderBy;
    try{
      ({ initializeApp } = await import(base + "firebase-app.js"));
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
        onSnapshot,
        orderBy
      } = await import(base + "firebase-firestore.js"));
    }catch(e){
      err("No se pudo cargar Firebase SDK (imports)", e);
      toast("Firebase SDK no cargó (revisa consola)");
      __authReadyResolve(null);
      NOMAD_FIRE.__loading = false;
      NOMAD_FIRE.__error = e;
      return;
    }

    let app, db;
    try{
      app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      NOMAD_FIRE.db = db;
    }catch(e){
      err("No se pudo inicializar Firebase", e);
      toast("Firebase init falló (revisa consola)");
      __authReadyResolve(null);
      NOMAD_FIRE.__loading = false;
      NOMAD_FIRE.__error = e;
      return;
    }

    // Ya NO usamos auth anónima en APP NOMAD.
    __authReadyResolve(getProfileContext());

    async function saveCheckout(payload){
      const deviceId = getDeviceId();
      const patient = payload?.patient || {};
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const profile = getProfileContext();

      const data = {
        deviceId,
        ownerKey: profile.ownerKey,
        ownerUid: profile.ownerUid || "",
        ownerEmail: profile.ownerEmail || "",
        ownerUsername: profile.ownerUsername || "",
        ownerRole: profile.ownerRole || "",
        ownerName: profile.ownerName || "",
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

      const ref = await addDoc(collection(db, MAIN_COLLECTION), data);
      const id = ref.id;

      if(MIRROR_COLLECTIONS.length){
        await Promise.all(MIRROR_COLLECTIONS.map((c) => {
          return setDoc(doc(db, c, id), { ...data, mainCollection: MAIN_COLLECTION, mainId: id }, { merge:true })
            .catch(() => null);
        }));
      }

      return id;
    }

    function buildScopedQuery(profile, expediente){
      const col = collection(db, MAIN_COLLECTION);
      if(profile.ownerUid){
        return expediente
          ? query(col, where("ownerUid", "==", profile.ownerUid), where("expediente", "==", expediente), limit(50))
          : query(col, where("ownerUid", "==", profile.ownerUid), limit(50));
      }
      if(profile.ownerEmail){
        return expediente
          ? query(col, where("ownerEmail", "==", profile.ownerEmail), where("expediente", "==", expediente), limit(50))
          : query(col, where("ownerEmail", "==", profile.ownerEmail), limit(50));
      }
      if(profile.ownerKey){
        return expediente
          ? query(col, where("ownerKey", "==", profile.ownerKey), where("expediente", "==", expediente), limit(50))
          : query(col, where("ownerKey", "==", profile.ownerKey), limit(50));
      }
      const deviceId = getDeviceId();
      return expediente
        ? query(col, where("deviceId", "==", deviceId), where("expediente", "==", expediente), limit(20))
        : query(col, where("deviceId", "==", deviceId), limit(20));
    }

    function watchHistory({ expediente = "" } = {}, cb = () => {}){
      const exp = (expediente || "").toString().trim();
      const profile = getProfileContext();
      const q = buildScopedQuery(profile, exp);

      return onSnapshot(q, (snap) => {
        let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        rows.sort((a,b) => Number(b.clientTs || 0) - Number(a.clientTs || 0));
        cb(rows);
      }, (e) => {
        toast("Firebase: " + (e?.message || "No se pudo leer el historial"));
        cb([]);
      });
    }

    NOMAD_FIRE.saveCheckout = saveCheckout;
    NOMAD_FIRE.watchHistory = watchHistory;
    NOMAD_FIRE.__loading = false;

    try{ window.dispatchEvent(new Event("nomad:firebase-ready")); }catch(e){}
    log("Firebase ready (project):", firebaseConfig.projectId, getProfileContext());
    toast("Firebase conectado por usuario");
  }

  boot().catch((e) => {
    err("Firebase boot fatal", e);
    try{ __authReadyResolve(null); }catch(_){}
    NOMAD_FIRE.__loading = false;
    NOMAD_FIRE.__error = e;
    toast("Firebase boot falló (revisa consola)");
  });
})();
