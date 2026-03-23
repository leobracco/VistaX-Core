// ============================================================
// VistaX — core/logic/seed_recorder.js
// Graba cada semilla individual con su coordenada GPS
// interpolada a partir del buffer de posiciones del bridge.
//
// Flujo:
//   mqtt_handler → registrarPosicionGPS(lat, lon, heading, gps_ts)
//   mqtt_handler → registrarPulso(uid, surco, t_ms)
//              ↓
//   interpolación → { lat, lon } para ese t_ms
//              ↓
//   buffer en memoria → flush a disco cada FLUSH_CADA semillas
//              ↓
//   GeoJSON: 1 Point por semilla con propiedades
// ============================================================

const fs   = require("fs");
const path = require("path");

// ------ Config -----------------------------------------------
const SEEDS_DIR      = path.join(__dirname, "../../data/lotes");
const FLUSH_CADA     = 200;   // semillas por flush a disco
const GPS_BUFFER_MAX = 100;   // posiciones GPS en memoria (buffer circular)

if (!fs.existsSync(SEEDS_DIR)) fs.mkdirSync(SEEDS_DIR, { recursive: true });

// ------ Estado -----------------------------------------------
let loteActivo   = null;   // { id, nombre, filePath }
let bufferSemillas = [];   // [{ lat, lon, surco, uid, gps_ts, heading }]
let totalSemillas  = 0;

// Buffer circular de posiciones GPS con timestamps
// [{ gps_ts, lat, lon, heading }] ordenado por gps_ts ASC
let gpsBuffer = [];

// Referencia de tiempo ESP32 ↔ GPS
// Cuando el bridge publica vistax/sync/time, guardamos la correlación
// { gps_ts: número unix ms, server_ts: Date.now() en ese momento }
// Usamos server_ts como proxy del millis() del ESP32 porque ambos
// están en la misma LAN y el jitter es <10ms.
let timeRef = null;

// ============================================================
// API PÚBLICA
// ============================================================

/**
 * Llamado desde mqtt_handler cuando llega aog/machine/position.
 * Alimenta el buffer de interpolación.
 */
function registrarPosicionGPS(lat, lon, heading, gps_ts) {
  if (!lat || !lon) return;

  const ts = gps_ts || Date.now();

  gpsBuffer.push({ gps_ts: ts, lat, lon, heading: heading || 0 });

  // Mantener buffer circular acotado
  if (gpsBuffer.length > GPS_BUFFER_MAX) {
    gpsBuffer.shift();
  }
}

/**
 * Llamado desde mqtt_handler cuando llega vistax/sync/time.
 * Establece la correlación ESP32 millis() ↔ GPS timestamp.
 * Payload esperado: { gps_ts, lat, lon }
 */
function registrarSyncTime(payload) {
  timeRef = {
    gps_ts:    payload.gps_ts || Date.now(),
    server_ts: Date.now(),
  };
}

/**
 * Llamado desde mqtt_handler cuando llega vistax/nodos/pulso.
 * Resuelve la coordenada y guarda la semilla.
 *
 * @param {string} uid    - ID del nodo ESP32
 * @param {number} surco  - número de bajada/surco
 * @param {number} t_ms   - millis() del ESP32 en el momento del pulso
 */
function registrarPulso(uid, surco, t_ms) {
  if (!loteActivo) return;

  // Convertir t_ms (millis ESP32) a gps_ts absoluto
  let gps_ts_pulso;

  if (timeRef) {
    // Delta desde la última sincronización
    const delta_server = Date.now() - timeRef.server_ts;
    gps_ts_pulso = timeRef.gps_ts + delta_server;
    // Ajuste: el pulso ocurrió t_ms - (millis en el momento del sync) ms antes
    // Pero no tenemos el millis del ESP32 en el sync, solo t_ms actual.
    // Usamos server_ts como proxy. Error máximo = latencia WiFi ≈ <20ms.
  } else {
    // Sin sync disponible: usar tiempo del servidor directo
    gps_ts_pulso = Date.now();
  }

  // Interpolar posición GPS para ese timestamp
  const pos = _interpolarPosicion(gps_ts_pulso);
  if (!pos) return; // Sin posición GPS todavía, descartar

  const semilla = {
    lat:     pos.lat,
    lon:     pos.lon,
    heading: pos.heading,
    surco:   parseInt(surco),
    uid,
    gps_ts:  gps_ts_pulso,
  };

  bufferSemillas.push(semilla);
  totalSemillas++;

  // Flush incremental
  if (bufferSemillas.length >= FLUSH_CADA) {
    _flushADisco();
  }

  return semilla;
}

/**
 * Inicia un nuevo lote de semillas georeferenciadas.
 */
function iniciarLote(loteId, nombre) {
  loteActivo = {
    id:       loteId,
    nombre,
    filePath: path.join(SEEDS_DIR, `${loteId}_semillas.json`),
  };
  bufferSemillas = [];
  totalSemillas  = 0;
  gpsBuffer      = [];
  timeRef        = null;

  // Escribir header del archivo
  _flushADisco();
  console.log(`\x1b[32m[SeedRecorder]\x1b[0m Lote iniciado: ${nombre} (${loteId})`);
}

/**
 * Cierra el lote, hace flush final y genera el GeoJSON.
 * Retorna la ruta del archivo GeoJSON.
 */
function cerrarLote() {
  if (!loteActivo) return null;

  _flushADisco(); // Flush del remanente

  const geojsonPath = _exportarGeoJSON();
  console.log(`\x1b[33m[SeedRecorder]\x1b[0m Lote cerrado: ${totalSemillas} semillas → ${geojsonPath}`);

  const loteTerminado = { ...loteActivo, totalSemillas };
  loteActivo     = null;
  bufferSemillas = [];
  totalSemillas  = 0;

  return { loteTerminado, geojsonPath };
}

/**
 * Estadísticas del lote activo para el frontend.
 */
function getEstadisticas() {
  if (!loteActivo) return null;
  return {
    loteId:        loteActivo.id,
    nombre:        loteActivo.nombre,
    totalSemillas,
    gpsBufferSize: gpsBuffer.length,
    timeRefOk:     !!timeRef,
  };
}

/**
 * Carga el GeoJSON de semillas de un lote cerrado.
 */
function cargarGeoJSON(loteId) {
  const p = path.join(SEEDS_DIR, `${loteId}_semillas.geojson`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ============================================================
// INTERPOLACIÓN TEMPORAL
// ============================================================

/**
 * Dado un timestamp GPS absoluto (ms), busca las dos posiciones
 * más cercanas en el buffer y hace interpolación lineal.
 *
 * @param {number} gps_ts - timestamp en ms
 * @returns {{ lat, lon, heading } | null}
 */
function _interpolarPosicion(gps_ts) {
  if (!gpsBuffer.length) return null;

  // Caso: timestamp antes de todo el buffer → usar el más antiguo
  if (gps_ts <= gpsBuffer[0].gps_ts) return gpsBuffer[0];

  // Caso: timestamp después del buffer → usar el más reciente
  const ultimo = gpsBuffer[gpsBuffer.length - 1];
  if (gps_ts >= ultimo.gps_ts) {
    // Tolerar máximo 2 segundos de extrapolación
    if (gps_ts - ultimo.gps_ts > 2000) return null;
    return ultimo;
  }

  // Buscar los dos puntos que envuelven el timestamp (búsqueda binaria)
  let lo = 0, hi = gpsBuffer.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (gpsBuffer[mid].gps_ts <= gps_ts) lo = mid;
    else hi = mid;
  }

  const p1 = gpsBuffer[lo];
  const p2 = gpsBuffer[hi];
  const t  = (gps_ts - p1.gps_ts) / (p2.gps_ts - p1.gps_ts);

  return {
    lat:     p1.lat     + (p2.lat     - p1.lat)     * t,
    lon:     p1.lon     + (p2.lon     - p1.lon)     * t,
    heading: p1.heading + (p2.heading - p1.heading) * t,
  };
}

// ============================================================
// PERSISTENCIA
// ============================================================

function _flushADisco() {
  if (!loteActivo) return;

  try {
    // Leer estado existente en disco (si ya existe)
    let existente = { semillas: [] };
    if (fs.existsSync(loteActivo.filePath)) {
      try {
        existente = JSON.parse(fs.readFileSync(loteActivo.filePath, "utf8"));
      } catch { /* archivo corrupto, empezar de cero */ }
    }

    // Acumular
    existente.loteId      = loteActivo.id;
    existente.nombre      = loteActivo.nombre;
    existente.semillas    = (existente.semillas || []).concat(bufferSemillas);
    existente.totalHasta  = existente.semillas.length;
    existente.updatedAt   = Date.now();

    fs.writeFileSync(loteActivo.filePath, JSON.stringify(existente), "utf8");
    bufferSemillas = []; // Vaciar buffer después del flush
  } catch (e) {
    console.error("[SeedRecorder] Error en flush:", e.message);
  }
}

function _exportarGeoJSON() {
  if (!loteActivo) return null;

  // Cargar todas las semillas del archivo en disco
  let data = { semillas: [] };
  try {
    data = JSON.parse(fs.readFileSync(loteActivo.filePath, "utf8"));
  } catch { /* sin datos */ }

  const geojson = {
    type: "FeatureCollection",
    name: `${loteActivo.nombre} — semillas individuales`,
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    },
    metadata: {
      loteId:        loteActivo.id,
      nombre:        loteActivo.nombre,
      totalSemillas: data.semillas.length,
      generadoEn:    new Date().toISOString(),
      descripcion:   "Cada feature es una semilla individual con coordenada GPS interpolada",
    },
    features: data.semillas.map(s => ({
      type: "Feature",
      geometry: {
        type:        "Point",
        coordinates: [s.lon, s.lat], // GeoJSON: [lon, lat]
      },
      properties: {
        surco:   s.surco,
        uid:     s.uid,
        gps_ts:  s.gps_ts,
        heading: parseFloat((s.heading || 0).toFixed(1)),
      },
    })),
  };

  const geojsonPath = path.join(SEEDS_DIR, `${loteActivo.id}_semillas.geojson`);
  fs.writeFileSync(geojsonPath, JSON.stringify(geojson, null, 2), "utf8");
  return geojsonPath;
}

// ============================================================
module.exports = {
  registrarPosicionGPS,
  registrarSyncTime,
  registrarPulso,
  iniciarLote,
  cerrarLote,
  getEstadisticas,
  cargarGeoJSON,
};
