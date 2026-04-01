APP NOMAD AJUSTADO SIN AUTH ANONIMA

Cambios:
- Se eliminó signInAnonymously() del archivo assets/js/firebase.js
- Las cotizaciones ahora se guardan con ownerUid / ownerEmail / ownerRole / ownerKey
- El historial y resultados filtran por ownerUid primero
- Se actualizó sw.js para forzar recarga de caché

Importante:
1) Sube TODO este contenido al repo de GitHub Pages de APP-NOMAD
2) Haz una recarga forzada o prueba en modo incógnito
3) Si en Firebase Rules pides request.auth != null, esta web ya no podrá leer/escribir porque aquí ya no inicia sesión anónima
4) Para esta arquitectura, la separación por usuario ocurre en el código web usando los datos que manda la app Android al WebView
