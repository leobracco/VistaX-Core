// ============================================================
// VistaX - map_recorder.js
// Graba puntos GPS + densidad de siembra en tiempo real.
// Genera un GeoJSON de pasadas (LineString) y otro de puntos
// (Point) con spm por bajada. Ambos se sirven por REST y
// se emiten por Socket.IO para el mapa en vivo.
// ============================================================

const fs = require("fs");
const path = require("path");

// ------ Configuración ----------------------------------------
const LOTES_DIR = path.join(__dirname, "../../data/lotes");
const INTERVAL_MS = 500; // cada cuántos ms consolida un punto
const MIN_DIST_M = 0.8; // distancia mínima entre puntos guardados (evita duplicados en parado)
const ANCHO_PASADA_M = 0.191; // se sobreescribe con config.setup.distancia_entre_surcos al iniciar lote

if (!fs.existsSync(LOTES_DIR)) fs.mkdirSync(LOTES_DIR, { recursive: true });

// ------ Estado interno ----------------------------------------
let loteActivo = null; // { id, nombre, cultivo, startTs, filePath, anchoPasada }
let ultimaPosGPS = null; // { lat, lon }
let estadoSensores = {}; // { bajada: { spm: float, alerta: bool } } – se actualiza desde mqtt_handler

// Buffer en memoria para el lote activo
// puntos: [{ lat, lon, heading, vel, ts, surcos: { "1": spm, "2": spm, ... }, alerta: bool }]
let bufferPuntos = [];

// ============================================================
// API pública
// ============================================================

/**
 * Inicia un nuevo lote de siembra.
 * @param {string} nombre   - Nombre del lote (ej: "Lote Norte 2025")
 * @param {string} cultivo  - Cultivo (ej: "Soja", "Maiz")
 * @param {number} anchoPasada - Distancia entre surcos en metros
 */
function iniciarLote(nombre, cultivo, anchoPasada = ANCHO_PASADA_M) {
  const ts = Date.now();
  const id = `lote_${ts}`;

  loteActivo = {
    id,
    nombre,
    cultivo,
    startTs: ts,
    anchoPasada: parseFloat(anchoPasada) || ANCHO_PASADA_M,
    filePath: path.join(LOTES_DIR, `${id}.json`),
  };

  bufferPuntos = [];
  ultimaPosGPS = null;
  estadoSensores = {};

  // Escribimos el header del archivo de lote
  _persistirLote();

  console.log(`\x1b[32m[MapRecorder]\x1b[0m Lote iniciado: ${nombre} (${id})`);
  return loteActivo;
}

/**
 * Cierra el lote activo y genera el GeoJSON final.
 * Retorna la ruta del archivo GeoJSON exportado.
 */
function cerrarLote() {
  if (!loteActivo) return null;

  loteActivo.endTs = Date.now();
  loteActivo.duracionMin = Math.round(
    (loteActivo.endTs - loteActivo.startTs) / 60000,
  );

  // Calcular estadísticas finales
  loteActivo.estadisticas = _calcularEstadisticas();

  _persistirLote();

  // Exportar GeoJSON
  const geojsonPath = _exportarGeoJSON();

  console.log(
    `\x1b[33m[MapRecorder]\x1b[0m Lote cerrado: ${loteActivo.nombre}`,
  );
  console.log(`\x1b[33m[MapRecorder]\x1b[0m GeoJSON exportado: ${geojsonPath}`);

  const loteTerminado = { ...loteActivo };
  loteActivo = null;
  bufferPuntos = [];
  ultimaPosGPS = null;

  return { lote: loteTerminado, geojsonPath };
}

/**
 * Actualiza la posición GPS y la velocidad desde el bridge.
 * Se llama desde mqtt_handler cuando llega aog/machine/position.
 */
function actualizarGPS(lat, lon, heading, velocidad) {
  if (!loteActivo) return;

  // Filtro de distancia mínima: no guardamos si la máquina está casi parada
  if (ultimaPosGPS) {
    const dist = _distanciaMetros(ultimaPosGPS.lat, ultimaPosGPS.lon, lat, lon);
    if (dist < MIN_DIST_M) return;
  }

  ultimaPosGPS = { lat, lon };

  // Construir snapshot del momento
  const surcos = {};
  let hayAlerta = false;

  Object.entries(estadoSensores).forEach(([bajada, s]) => {
    surcos[bajada] = parseFloat(s.spm) || 0;
    if (s.alerta) hayAlerta = true;
  });

  const punto = {
    lat,
    lon,
    heading: heading || 0,
    vel: velocidad || 0,
    ts: Date.now(),
    surcos,
    alerta: hayAlerta,
    spmPromedio: _spmPromedio(surcos),
  };

  bufferPuntos.push(punto);

  // Persistencia incremental cada 20 puntos para no golpear el disco en cada ciclo
  if (bufferPuntos.length % 20 === 0) _persistirLote();

  return punto;
}

/**
 * Recibe el update de un sensor desde mqtt_handler.
 * Se llama en el mismo lugar donde se hace io.emit("sensor_update", ...).
 */
function actualizarSensor(bajada, spm, alerta) {
  estadoSensores[bajada] = { spm: parseFloat(spm) || 0, alerta: !!alerta };
}

// ============================================================
// GeoJSON en memoria para el mapa en vivo
// ============================================================

/**
 * Devuelve el GeoJSON de puntos del lote activo (para el mapa en vivo).
 * Cada feature tiene: spmPromedio, alerta, vel, ts, surcos.
 */
function getGeoJSONLive() {
  if (!bufferPuntos.length) {
    return { type: "FeatureCollection", features: [] };
  }

  const features = bufferPuntos.map((p) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [p.lon, p.lat], // GeoJSON: [lon, lat]
    },
    properties: {
      ts: p.ts,
      vel: p.vel,
      heading: p.heading,
      spmPromedio: p.spmPromedio,
      alerta: p.alerta,
      surcos: p.surcos,
    },
  }));

  return { type: "FeatureCollection", features };
}

/**
 * Devuelve el GeoJSON de pasadas (LineString por franja de ancho de pasada).
 * Útil para ver las franjas pintadas como en un monitor de secciones.
 */
function getGeoJSONPasadas() {
  if (bufferPuntos.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }

  // Agrupar puntos en "pasadas" (segmentos continuos sin saltos >10m)
  const pasadas = [];
  let pasadaActual = [bufferPuntos[0]];

  for (let i = 1; i < bufferPuntos.length; i++) {
    const prev = bufferPuntos[i - 1];
    const curr = bufferPuntos[i];
    const dist = _distanciaMetros(prev.lat, prev.lon, curr.lat, curr.lon);

    if (dist > 10) {
      // Salto grande: nueva pasada
      pasadas.push([...pasadaActual]);
      pasadaActual = [curr];
    } else {
      pasadaActual.push(curr);
    }
  }
  if (pasadaActual.length > 0) pasadas.push(pasadaActual);

  const features = pasadas
    .filter((p) => p.length >= 2)
    .map((puntos, idx) => {
      const spmProm =
        puntos.reduce((a, p) => a + p.spmPromedio, 0) / puntos.length;
      const alertas = puntos.filter((p) => p.alerta).length;

      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: puntos.map((p) => [p.lon, p.lat]),
        },
        properties: {
          pasadaId: idx,
          spmPromedio: parseFloat(spmProm.toFixed(1)),
          alertas,
          puntos: puntos.length,
          anchoPasada: loteActivo?.anchoPasada || ANCHO_PASADA_M,
        },
      };
    });

  return { type: "FeatureCollection", features };
}

/**
 * Devuelve info del lote activo (para el footer de la UI).
 */
function getLoteActivo() {
  if (!loteActivo) return null;
  return {
    ...loteActivo,
    puntosGrabados: bufferPuntos.length,
    estadisticasLive: _calcularEstadisticas(),
  };
}

/**
 * Lista los lotes guardados en disco.
 */
function listarLotes() {
  return fs
    .readdirSync(LOTES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(LOTES_DIR, f), "utf8"),
        );
        return {
          id: data.id,
          nombre: data.nombre,
          cultivo: data.cultivo,
          startTs: data.startTs,
          endTs: data.endTs,
          puntos: data.puntos?.length || 0,
          estadisticas: data.estadisticas || {},
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startTs - a.startTs);
}

/**
 * Carga el GeoJSON de un lote cerrado desde disco.
 */
function cargarGeoJSONLote(loteId) {
  const geojsonPath = path.join(LOTES_DIR, `${loteId}.geojson`);
  if (!fs.existsSync(geojsonPath)) return null;
  return JSON.parse(fs.readFileSync(geojsonPath, "utf8"));
}

// ============================================================
// Funciones privadas
// ============================================================

function _persistirLote() {
  if (!loteActivo) return;
  const data = { ...loteActivo, puntos: bufferPuntos };
  fs.writeFileSync(loteActivo.filePath, JSON.stringify(data), "utf8");
}

function _exportarGeoJSON() {
  if (!loteActivo) return null;

  const geojson = {
    type: "FeatureCollection",
    name: loteActivo.nombre,
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    },
    metadata: {
      loteId: loteActivo.id,
      nombre: loteActivo.nombre,
      cultivo: loteActivo.cultivo,
      startTs: loteActivo.startTs,
      endTs: loteActivo.endTs,
      estadisticas: loteActivo.estadisticas,
    },
    features: bufferPuntos.map((p) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [p.lon, p.lat],
      },
      properties: {
        ts: p.ts,
        vel: p.vel,
        spmPromedio: p.spmPromedio,
        alerta: p.alerta,
        ...p.surcos, // spm de cada bajada como propiedad directa → compatible con QGIS
      },
    })),
  };

  const geojsonPath = path.join(LOTES_DIR, `${loteActivo.id}.geojson`);
  fs.writeFileSync(geojsonPath, JSON.stringify(geojson, null, 2), "utf8");
  return geojsonPath;
}

function _calcularEstadisticas() {
  if (!bufferPuntos.length) return {};

  const spms = bufferPuntos.map((p) => p.spmPromedio).filter((v) => v > 0);
  const alertasTotal = bufferPuntos.filter((p) => p.alerta).length;
  const distanciaM = bufferPuntos.reduce((acc, p, i) => {
    if (i === 0) return 0;
    return (
      acc +
      _distanciaMetros(
        bufferPuntos[i - 1].lat,
        bufferPuntos[i - 1].lon,
        p.lat,
        p.lon,
      )
    );
  }, 0);

  return {
    puntosGrabados: bufferPuntos.length,
    spmPromedio: spms.length
      ? parseFloat((spms.reduce((a, b) => a + b, 0) / spms.length).toFixed(1))
      : 0,
    spmMax: spms.length ? parseFloat(Math.max(...spms).toFixed(1)) : 0,
    spmMin: spms.length ? parseFloat(Math.min(...spms).toFixed(1)) : 0,
    alertasRegistradas: alertasTotal,
    distanciaRecorridaM: parseFloat(distanciaM.toFixed(0)),
    hectareasAprox: parseFloat(
      (
        (distanciaM * (loteActivo?.anchoPasada || ANCHO_PASADA_M)) /
        10000
      ).toFixed(2),
    ),
  };
}

function _spmPromedio(surcos) {
  const vals = Object.values(surcos).filter((v) => v > 0);
  if (!vals.length) return 0;
  return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
}

function _distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
module.exports = {
  iniciarLote,
  cerrarLote,
  actualizarGPS,
  actualizarSensor,
  getGeoJSONLive,
  getGeoJSONPasadas,
  getLoteActivo,
  listarLotes,
  cargarGeoJSONLote,
};
