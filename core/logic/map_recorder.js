// ============================================================
// core/logic/map_recorder.js  — VistaX v2.2.0
//
// Graba puntos de densidad de siembra georreferenciados.
// Persiste en data/mapas/{slug}.geojson y exporta a KML.
//
// CICLO DE VIDA:
//   aog/field/status  accion="abierto"|"nuevo"|"continuar"  → inicia/reanuda
//   aog/field/status  accion="cerrado"                      → pausa (no borra)
//   Si el mismo lote se reabre, carga los puntos existentes y sigue.
//
// INTEGRACIÓN:
//   En mqtt_handler.js:
//     const mapRecorder = require("./map_recorder");
//     (dentro de client.on("connect"))  → mapRecorder.iniciar(client, io);
//     (después de io.emit("sensor_update")) → mapRecorder.onSensorData(bajada, tipo, spm);
//
// RUTAS API (agregar en server.js):
//   GET /api/mapa/estado
//   GET /api/mapa/exportar/geojson
//   GET /api/mapa/exportar/kml
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Configuración ────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, "../../data/mapas");
const MIN_VEL_KMH     = 0.5;   // Velocidad mínima para grabar
const MIN_DIST_M      = 1.5;   // Distancia mínima entre puntos (metros)
const SAVE_CADA_N     = 10;    // Guardar GeoJSON cada N puntos nuevos

// ─── Estado interno ───────────────────────────────────────
let _iniciado     = false;
let _mqttClient   = null;
let _io           = null;

let _loteActivo   = "";         // Nombre legible del lote
let _loteSlug     = "";         // Versión slugificada para el nombre de archivo
let _grabando     = false;

let _posicion     = { lat: 0, lon: 0 };
let _ultimaPos    = { lat: 0, lon: 0 };
let _velocidad    = 0;

let _sensoresAcum = {};         // { bajada: { tipo, sumaSpm, n } } — se resetea por punto
let _features     = [];         // GeoJSON features acumuladas en memoria

// Asegurar directorio de datos
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────

/**
 * Inicializar el módulo. Llamar UNA SOLA VEZ desde mqtt_handler.js
 * dentro del bloque client.on("connect", ...).
 */
function iniciar(mqttClient, io) {
  if (_iniciado) return;
  _iniciado   = true;
  _mqttClient = mqttClient;
  _io         = io;

  // Suscribir a los topics necesarios
  mqttClient.subscribe("aog/field/status");
  mqttClient.subscribe("aog/machine/position");
  mqttClient.subscribe("aog/machine/speed");

  // Listener propio — coexiste con el de mqtt_handler.js
  mqttClient.on("message", _onMqttMessage);

  console.log("[MapRecorder v2.2] Inicializado. Esperando lote activo...");
}

/**
 * Llamar desde mqtt_handler.js cada vez que se procesa un sensor.
 * Acumula las lecturas hasta que llega la próxima posición GPS.
 */
function onSensorData(bajada, tipo, spm) {
  if (!_grabando) return;

  const key = String(bajada);
  if (!_sensoresAcum[key]) {
    _sensoresAcum[key] = { tipo, sumaSpm: 0, n: 0 };
  }
  _sensoresAcum[key].sumaSpm += parseFloat(spm) || 0;
  _sensoresAcum[key].n       += 1;
}

/**
 * Exporta KML del lote activo. Retorna la ruta del archivo o null.
 */
function exportarKML() {
  if (!_loteSlug || _features.length === 0) return null;
  return _generarKML();
}

/**
 * Retorna el estado actual del grabador (para la API y Socket.IO).
 */
function getEstado() {
  return {
    grabando:    _grabando,
    lote:        _loteActivo,
    puntos:      _features.length,
    geoJsonPath: _loteSlug ? _rutaGeoJSON() : null,
  };
}

/**
 * Retorna el array de features en memoria (para la ruta API /geojson).
 */
function getFeatures() {
  return _features;
}

// ─────────────────────────────────────────────────────────
// MANEJO DE MENSAJES MQTT
// ─────────────────────────────────────────────────────────

function _onMqttMessage(topic, message) {
  try {
    const raw = message.toString();

    // ── Velocidad ──────────────────────────────────────
    if (topic === "aog/machine/speed") {
      _velocidad = parseFloat(raw) || 0;
      return;
    }

    // ── Posición GPS ───────────────────────────────────
    if (topic === "aog/machine/position") {
      const data = JSON.parse(raw);
      if (data.lat && data.lon) {
        _posicion = { lat: data.lat, lon: data.lon };
        _intentarGrabarPunto();
      }
      return;
    }

    // ── Estado del lote ────────────────────────────────
    if (topic === "aog/field/status") {
      const data = JSON.parse(raw);
      _manejarCambioLote(data);
      return;
    }

  } catch (_err) {
    // JSON parcial o mensaje inválido — ignorar silenciosamente
  }
}

// ─────────────────────────────────────────────────────────
// CICLO DE VIDA DEL LOTE
// ─────────────────────────────────────────────────────────

function _manejarCambioLote(data) {
  const { fieldName, accion } = data;

  // ── Lote cerrado: pausamos pero NO destruimos datos ──
  if (accion === "cerrado") {
    if (_grabando) {
      _guardarGeoJSON();
      _grabando = false;
      console.log(`[MapRecorder] ■ Lote pausado: "${_loteActivo}" (${_features.length} pts guardados)`);
      _emitirEstado();
    }
    return;
  }

  // ── Lote abierto/nuevo/continuar ─────────────────────
  if (["nuevo", "abierto", "continuar"].includes(accion) && fieldName) {
    const slug = _slugify(fieldName);

    // Si es el mismo lote y ya estamos grabando → no hacer nada
    if (slug === _loteSlug && _grabando) return;

    _loteActivo   = fieldName;
    _loteSlug     = slug;
    _sensoresAcum = {};

    // Intentar cargar datos previos del mismo lote
    const geoPath = _rutaGeoJSON();
    if (fs.existsSync(geoPath)) {
      try {
        const previo = JSON.parse(fs.readFileSync(geoPath, "utf8"));
        _features = Array.isArray(previo.features) ? previo.features : [];
        console.log(`[MapRecorder] ▶ Reanudando lote "${fieldName}" — ${_features.length} puntos previos cargados`);
      } catch (_err) {
        _features = [];
        console.log(`[MapRecorder] ⚠️ GeoJSON corrupto — empezando desde cero para "${fieldName}"`);
      }
    } else {
      _features = [];
      console.log(`[MapRecorder] ▶ Nuevo lote iniciado: "${fieldName}"`);
    }

    _grabando    = true;
    _ultimaPos   = { lat: 0, lon: 0 }; // Forzar primer punto inmediatamente
    _emitirEstado();
  }
}

// ─────────────────────────────────────────────────────────
// GRABACIÓN DE PUNTO
// ─────────────────────────────────────────────────────────

function _intentarGrabarPunto() {
  if (!_grabando)              return;
  if (_velocidad < MIN_VEL_KMH) return;
  if (_posicion.lat === 0)     return;

  // Filtro de distancia mínima entre puntos
  const dist = _distanciaMetros(_ultimaPos, _posicion);
  if (dist < MIN_DIST_M && _features.length > 0) return;

  // Construir propiedades de densidad por bajada
  const bajadas = {};
  for (const [b, v] of Object.entries(_sensoresAcum)) {
    bajadas[b] = {
      tipo: v.tipo,
      spm:  v.n > 0 ? parseFloat((v.sumaSpm / v.n).toFixed(2)) : 0,
    };
  }

  const feature = {
    type: "Feature",
    geometry: {
      type:        "Point",
      coordinates: [_posicion.lon, _posicion.lat],
    },
    properties: {
      ts:     Date.now(),
      vel:    parseFloat(_velocidad.toFixed(1)),
      bajadas,
    },
  };

  _features.push(feature);
  _sensoresAcum = {};                            // Reset acumulador de sensores
  _ultimaPos    = { ..._posicion };

  // Guardado periódico para no saturar el disco
  if (_features.length % SAVE_CADA_N === 0) {
    _guardarGeoJSON();
    _emitirEstado();
  }
}

// ─────────────────────────────────────────────────────────
// PERSISTENCIA — GeoJSON
// ─────────────────────────────────────────────────────────

function _guardarGeoJSON() {
  if (!_loteSlug) return;

  const geojson = {
    type: "FeatureCollection",
    metadata: {
      lote:      _loteActivo,
      generado:  new Date().toISOString(),
      puntos:    _features.length,
    },
    features: _features,
  };

  try {
    fs.writeFileSync(_rutaGeoJSON(), JSON.stringify(geojson, null, 2), "utf8");
  } catch (err) {
    console.error("[MapRecorder] ❌ Error guardando GeoJSON:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// EXPORTACIÓN — KML
// ─────────────────────────────────────────────────────────

function _generarKML() {
  const placemarks = _features.map((f, i) => {
    const [lon, lat] = f.geometry.coordinates;
    const p          = f.properties;

    // Calcular promedio de densidad para el color del punto
    const valores = Object.values(p.bajadas || {})
      .filter(v => v.tipo === "semilla")
      .map(v => v.spm);
    const promSpm = valores.length
      ? (valores.reduce((a, b) => a + b, 0) / valores.length).toFixed(1)
      : "N/A";

    const descLineas = Object.entries(p.bajadas || {})
      .map(([b, v]) => `Bajada ${b} (${v.tipo}): ${v.spm} s/m`)
      .join("&#10;");

    const styleUrl = _spmAColorKML(parseFloat(promSpm));

    return `    <Placemark>
      <name>P${i + 1}</name>
      <styleUrl>${styleUrl}</styleUrl>
      <description>Vel: ${p.vel} km/h&#10;Prom: ${promSpm} s/m&#10;${descLineas}</description>
      <Point><coordinates>${lon},${lat},0</coordinates></Point>
    </Placemark>`;
  }).join("\n");

  // Estilos de color por rango de densidad
  const estilos = `
    <Style id="bajo"><IconStyle><color>ff0000ff</color><scale>0.6</scale></IconStyle></Style>
    <Style id="normal"><IconStyle><color>ff00ff00</color><scale>0.6</scale></IconStyle></Style>
    <Style id="alto"><IconStyle><color>ff0080ff</color><scale>0.6</scale></IconStyle></Style>
    <Style id="sinDatos"><IconStyle><color>ff888888</color><scale>0.4</scale></IconStyle></Style>`;

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${_loteActivo}</name>
    <description>Mapa de siembra VistaX — ${_features.length} puntos — ${new Date().toLocaleString("es-AR")}</description>
${estilos}
${placemarks}
  </Document>
</kml>`;

  const kmlPath = path.join(DATA_DIR, `${_loteSlug}.kml`);
  try {
    fs.writeFileSync(kmlPath, kml, "utf8");
    console.log(`[MapRecorder] ✅ KML exportado: ${kmlPath}`);
    return kmlPath;
  } catch (err) {
    console.error("[MapRecorder] ❌ Error exportando KML:", err.message);
    return null;
  }
}

/**
 * Retorna el styleUrl según densidad (semillas/metro).
 * Ajustar umbrales según densidad_objetivo de la configuración.
 */
function _spmAColorKML(spm) {
  if (isNaN(spm))  return "#sinDatos";
  if (spm <= 0)    return "#sinDatos";
  if (spm < 70)    return "#bajo";    // Rojo: bajo flujo
  if (spm <= 105)  return "#normal";  // Verde: normal
  return "#alto";                      // Naranja: sobre flujo
}

// ─────────────────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────────────────

function _rutaGeoJSON() {
  return path.join(DATA_DIR, `${_loteSlug}.geojson`);
}

function _slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // Quitar tildes
    .replace(/[^a-zA-Z0-9\-_]/g, "_") // Reemplazar caracteres especiales
    .replace(/_+/g, "_")               // Colapsar underscores múltiples
    .replace(/^_|_$/g, "")            // Quitar underscores extremos
    .toLowerCase()
    .substring(0, 80);                 // Límite de longitud
}

/**
 * Distancia entre dos puntos GPS en metros (Haversine).
 */
function _distanciaMetros(a, b) {
  if (!a.lat || !b.lat) return 9999;
  const R    = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
    Math.cos((b.lat * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function _emitirEstado() {
  _io?.emit("map_recorder_status", {
    grabando: _grabando,
    lote:     _loteActivo,
    puntos:   _features.length,
  });
}

// ─────────────────────────────────────────────────────────
module.exports = { iniciar, onSensorData, exportarKML, getEstado, getFeatures };
