// ============================================================
// VistaX — core/logic/seed_recorder.js
//
// PERSISTENCIA: JSON Lines (.jsonl) — append-only
//
// Cada punto georeferenciado se escribe como una línea JSON
// independiente. Si el servidor se cae en cualquier momento,
// el archivo solo pierde la línea en escritura, no el lote entero.
//
// Al cerrar el lote, se lee el .jsonl línea por línea y se
// genera el GeoJSON final. Sin riesgo de JSON roto.
//
// Formato del .jsonl:
//   {"lat":-34.6,"lon":-58.38,"bajada":1,"count":5,"gps_ts":...}
//   {"lat":-34.6,"lon":-58.38,"bajada":3,"count":4,"gps_ts":...}
//   ...
// ============================================================

const fs   = require("fs");
const path = require("path");

const LOTES_DIR      = path.join(__dirname, "../../data/lotes");
const FLUSH_CADA     = 50;   // puntos en buffer antes de flush a disco
const GPS_BUFFER_MAX = 100;  // posiciones GPS en el buffer de interpolación

if (!fs.existsSync(LOTES_DIR)) fs.mkdirSync(LOTES_DIR, { recursive: true });

// ------ Estado en memoria ------------------------------------
let loteActivo    = null;  // { id, nombre, jsonlPath }
let bufferPuntos  = [];    // puntos pendientes de flush
let totalSemillas = 0;     // contador acumulado
let gpsBuffer     = [];    // buffer circular de posiciones GPS
let timeRef       = null;  // referencia de tiempo ESP32 ↔ GPS

// ============================================================
// API PÚBLICA
// ============================================================

/**
 * Actualiza el buffer de posiciones GPS.
 * Llamado desde mqtt_handler en cada aog/machine/position.
 */
function registrarPosicionGPS(lat, lon, heading, gps_ts) {
  if (!lat || !lon) return;
  gpsBuffer.push({ gps_ts: gps_ts || Date.now(), lat, lon, heading: heading || 0 });
  if (gpsBuffer.length > GPS_BUFFER_MAX) gpsBuffer.shift();
}

/**
 * Actualiza la correlación de tiempo ESP32 ↔ GPS.
 * Llamado desde mqtt_handler en cada vistax/sync/time.
 */
function registrarSyncTime(payload) {
  timeRef = {
    gps_ts:    payload.gps_ts || Date.now(),
    server_ts: Date.now(),
  };
}

/**
 * Registra una ventana de pulsos con georeferenciación.
 * Llamado desde mqtt_handler cuando llega vistax/nodos/pulso.
 *
 * @param {string} uid     - UID del nodo ESP32
 * @param {number} bajada  - número de bajada/surco
 * @param {number} count   - semillas en la ventana
 * @param {number} tsMedio - timestamp GPS del centro de la ventana (ms)
 */
function registrarVentana(uid, bajada, count, tsMedio) {
  if (!loteActivo || count <= 0) return;

  const pos = _interpolarPosicion(tsMedio);
  if (!pos) return;

  const punto = {
    lat:     pos.lat,
    lon:     pos.lon,
    heading: pos.heading,
    bajada:  parseInt(bajada),
    uid,
    count,
    gps_ts:  tsMedio,
  };

  bufferPuntos.push(punto);
  totalSemillas += count;

  if (bufferPuntos.length >= FLUSH_CADA) _flushADisco();

  return punto;
}

/**
 * Inicia un nuevo lote.
 * Crea el archivo .jsonl vacío — si ya existe lo limpia.
 */
function iniciarLote(loteId, nombre) {
  const jsonlPath = path.join(LOTES_DIR, `${loteId}_semillas.jsonl`);

  loteActivo    = { id: loteId, nombre, jsonlPath };
  bufferPuntos  = [];
  totalSemillas = 0;
  gpsBuffer     = [];
  timeRef       = null;

  // Crear archivo vacío (trunca si existía)
  fs.writeFileSync(jsonlPath, "", "utf8");

  // Guardar metadata del lote en archivo separado
  const meta = { id: loteId, nombre, startTs: Date.now(), endTs: null };
  fs.writeFileSync(
    path.join(LOTES_DIR, `${loteId}_meta.json`),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  console.log(`\x1b[32m[SeedRecorder]\x1b[0m Lote iniciado: ${nombre} (${loteId})`);
  return loteActivo;
}

/**
 * Cierra el lote activo, hace flush final y genera el GeoJSON.
 */
function cerrarLote() {
  if (!loteActivo) return null;

  // Flush del buffer restante
  _flushADisco();

  // Actualizar metadata con endTs y total
  const metaPath = path.join(LOTES_DIR, `${loteActivo.id}_meta.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.endTs        = Date.now();
    meta.totalSemillas = totalSemillas;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    console.error("[SeedRecorder] Error actualizando meta:", e.message);
  }

  // Generar GeoJSON desde el .jsonl
  const geojsonPath = _exportarGeoJSON();

  console.log(
    `\x1b[33m[SeedRecorder]\x1b[0m Lote cerrado: ` +
    `${totalSemillas.toLocaleString()} semillas → ${geojsonPath}`
  );

  const loteTerminado = { ...loteActivo, totalSemillas };
  loteActivo    = null;
  bufferPuntos  = [];
  totalSemillas = 0;

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
  const geojsonPath = path.join(LOTES_DIR, `${loteId}_semillas.geojson`);
  if (!fs.existsSync(geojsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(geojsonPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Recupera un lote activo al reiniciar el servidor.
 * Busca el último .jsonl sin endTs en metadata.
 */
function recuperarLoteActivo() {
  try {
    const archivos = fs.readdirSync(LOTES_DIR)
      .filter(f => f.endsWith("_meta.json"));

    for (const archivo of archivos.sort().reverse()) {
      const meta = JSON.parse(
        fs.readFileSync(path.join(LOTES_DIR, archivo), "utf8")
      );
      if (!meta.endTs) {
        // Lote sin cerrar encontrado
        const jsonlPath = path.join(LOTES_DIR, `${meta.id}_semillas.jsonl`);
        if (!fs.existsSync(jsonlPath)) continue;

        loteActivo    = { id: meta.id, nombre: meta.nombre, jsonlPath };
        bufferPuntos  = [];
        totalSemillas = meta.totalSemillas || _contarSemillasJsonl(jsonlPath);

        console.log(
          `\x1b[33m[SeedRecorder]\x1b[0m Lote recuperado: ${meta.nombre} ` +
          `(${totalSemillas.toLocaleString()} semillas previas)`
        );
        return loteActivo;
      }
    }
  } catch (e) {
    console.error("[SeedRecorder] Error en recuperación:", e.message);
  }
  return null;
}

// ============================================================
// INTERPOLACIÓN TEMPORAL
// ============================================================

function _interpolarPosicion(gps_ts) {
  if (!gpsBuffer.length) return null;

  if (gps_ts <= gpsBuffer[0].gps_ts) return gpsBuffer[0];

  const ultimo = gpsBuffer[gpsBuffer.length - 1];
  if (gps_ts >= ultimo.gps_ts) {
    // Tolerar hasta 2s de extrapolación
    if (gps_ts - ultimo.gps_ts > 2000) return null;
    return ultimo;
  }

  // Búsqueda binaria
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
// PERSISTENCIA — JSON Lines (append-only)
// ============================================================

/**
 * Escribe el buffer a disco como líneas JSON independientes.
 * Usa appendFileSync → nunca sobreescribe, nunca corrompe.
 * Si falla en medio de la escritura, solo se pierde esa línea.
 */
function _flushADisco() {
  if (!loteActivo || !bufferPuntos.length) return;

  try {
    const lineas = bufferPuntos
      .map(p => JSON.stringify({
        lat:     parseFloat(p.lat.toFixed(7)),
        lon:     parseFloat(p.lon.toFixed(7)),
        heading: parseFloat((p.heading || 0).toFixed(1)),
        bajada:  p.bajada,
        uid:     p.uid,
        count:   p.count,
        gps_ts:  p.gps_ts,
      }))
      .join("\n") + "\n";

    fs.appendFileSync(loteActivo.jsonlPath, lineas, "utf8");
    bufferPuntos = [];
  } catch (e) {
    console.error("[SeedRecorder] Error flush:", e.message);
    // NO limpiar bufferPuntos si falla — reintentar en el próximo flush
  }
}

/**
 * Lee el .jsonl línea por línea y genera el GeoJSON final.
 * Líneas vacías o malformadas se saltan silenciosamente.
 */
function _exportarGeoJSON() {
  if (!loteActivo) return null;

  const features = [];
  let totalCount = 0;

  try {
    const contenido = fs.readFileSync(loteActivo.jsonlPath, "utf8");
    for (const linea of contenido.split("\n")) {
      const trimada = linea.trim();
      if (!trimada) continue;
      try {
        const p = JSON.parse(trimada);
        features.push({
          type: "Feature",
          geometry: {
            type:        "Point",
            coordinates: [p.lon, p.lat],  // GeoJSON: [lon, lat]
          },
          properties: {
            bajada:  p.bajada,
            uid:     p.uid,
            count:   p.count || 1,
            gps_ts:  p.gps_ts,
            heading: p.heading || 0,
          },
        });
        totalCount += p.count || 1;
      } catch {
        // Línea malformada — ignorar y continuar
      }
    }
  } catch (e) {
    console.error("[SeedRecorder] Error leyendo jsonl:", e.message);
  }

  const geojson = {
    type: "FeatureCollection",
    name: `${loteActivo.nombre} — semillas`,
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    },
    metadata: {
      loteId:        loteActivo.id,
      nombre:        loteActivo.nombre,
      totalSemillas: totalCount,
      totalVentanas: features.length,
      generadoEn:    new Date().toISOString(),
    },
    features,
  };

  const geojsonPath = path.join(LOTES_DIR, `${loteActivo.id}_semillas.geojson`);
  fs.writeFileSync(geojsonPath, JSON.stringify(geojson, null, 2), "utf8");
  return geojsonPath;
}

/**
 * Cuenta semillas en un .jsonl existente (para recuperación).
 */
function _contarSemillasJsonl(jsonlPath) {
  try {
    let total = 0;
    const contenido = fs.readFileSync(jsonlPath, "utf8");
    for (const linea of contenido.split("\n")) {
      const t = linea.trim();
      if (!t) continue;
      try { total += JSON.parse(t).count || 1; } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

// ============================================================
module.exports = {
  registrarPosicionGPS,
  registrarSyncTime,
  registrarVentana,
  iniciarLote,
  cerrarLote,
  getEstadisticas,
  cargarGeoJSON,
  recuperarLoteActivo,
};
