// ============================================================
// VistaX — core/geo/lote_recorder.js
//
// Motor de persistencia telemétrica append-only.
// Reemplaza seed_recorder.js y la parte de grabación de
// map_recorder.js.
//
// Responsabilidades:
//   1. Recibir pulsos de sensores ya procesados por mqtt_handler
//   2. Interpolar posición GPS al timestamp del pulso
//   3. Escribir 1 línea NDJSON por sensor/cable con raw > 0
//      (y cambios de estado raw > 0 → raw = 0)
//   4. Mantener parcial.geojson con ventana móvil (5 min)
//   5. Al cerrar lote, delegar a map_exporter para generar
//      GeoJSON final + shapefile + resumen
//
// Formato de línea NDJSON:
//   {"seq":N,"ts":T,"uid":"VX-...","cable":C,"bajada":B,
//    "tipo":"semilla","raw":R,"lat":L,"lon":O,"vel":V,
//    "hdg":H,"spm":S,"gps_q":Q}
//
// Estructura de carpeta por lote:
//   data/lotes/{lote_id}/
//     ├── eventos.ndjson
//     ├── gps.ndjson
//     ├── parcial.geojson
//     ├── metadata.json
//     └── (al cerrar: final_puntos.geojson, resumen.json, etc.)
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");
const GpsBuffer = require("./gps_buffer");

// ─── Configuración ────────────────────────────────────────
const LOTES_DIR          = path.join(__dirname, "../../data/lotes");
const FLUSH_INTERVAL_MS  = 2000;    // flush a disco cada 2s
const PARCIAL_INTERVAL_MS = 30000;  // regenerar parcial.geojson cada 30s
const PARCIAL_VENTANA_MS = 5 * 60 * 1000; // ventana móvil de 5 min
const GPS_SUBSAMPLE_MS   = 1000;    // GPS a disco cada 1s

if (!fs.existsSync(LOTES_DIR)) fs.mkdirSync(LOTES_DIR, { recursive: true });

// ─── Estado interno ───────────────────────────────────────
const gpsBuffer = new GpsBuffer(100);

let _loteActivo   = null;    // { id, nombre, dir, stream }
let _seq          = 0;       // contador monotónico global
let _writeBuffer  = [];      // líneas pendientes de flush
let _parcialBuffer = [];     // eventos en memoria para parcial.geojson (ventana móvil)
let _flushTimer   = null;
let _parcialTimer = null;
let _io           = null;

// Tracker de cambio de estado por surco (para detectar raw > 0 → 0)
const _ultimoRaw = new Map(); // key: "uid_cable" → último raw conocido

// Estadísticas del lote
let _stats = {
  totalEventos: 0,
  totalPulsos:  0,
  surcoActivo: new Set(),
};

// ─────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────

/**
 * Inicializar con referencia a Socket.IO (para emitir estado).
 * Llamar una vez desde mqtt_handler.js.
 */
function init(io) {
  _io = io;

  // Intentar recuperar lote activo de sesión anterior
  _recuperarLoteActivo();
}

/**
 * Registrar posición GPS. Llamar en cada aog/machine/position.
 */
function registrarGPS(lat, lon, heading, vel, ts) {
  gpsBuffer.push(lat, lon, heading, vel, ts);
}

/**
 * Registrar un evento de sensor. Llamar desde mqtt_handler.js
 * por cada sensor procesado.
 *
 * @param {object} datos
 * @param {string} datos.uid     - UID del nodo
 * @param {number} datos.cable   - cable del perfil (0-based)
 * @param {number} datos.bajada  - número de surco (o undefined para otros)
 * @param {string} datos.tipo    - tipo de sensor
 * @param {number} datos.raw     - pulsos crudos en la ventana de 500ms
 * @param {number} datos.spm     - semillas por metro calculadas
 * @param {number} datos.ts      - timestamp del evento
 */
function registrarEvento(datos) {
  if (!_loteActivo) return;

  const { uid, cable, bajada, tipo, raw, spm, ts } = datos;
  const key = `${uid}_${cable}`;
  const rawInt = parseInt(raw) || 0;
  const ultimoRaw = _ultimoRaw.get(key) || 0;

  // Decidir si escribir esta línea
  let escribir = false;

  if (rawInt > 0) {
    // Siempre escribir cuando hay pulsos
    escribir = true;
  } else if (ultimoRaw > 0 && rawInt === 0) {
    // Cambio de estado: estaba sembrando, dejó de sembrar
    // Escribir UNA línea con raw=0 para marcar el punto de transición
    escribir = true;
  }

  // Actualizar tracker
  _ultimoRaw.set(key, rawInt);

  if (!escribir) return;

  // Interpolar GPS
  const gps = gpsBuffer.interpolar(ts || Date.now());
  if (!gps) return; // sin GPS no grabamos — no tiene sentido sin coordenadas

  _seq++;

  const linea = {
    seq:   _seq,
    ts:    ts || Date.now(),
    uid,
    cable,
    bajada: bajada || null,
    tipo,
    raw:   rawInt,
    lat:   parseFloat(gps.lat.toFixed(7)),
    lon:   parseFloat(gps.lon.toFixed(7)),
    vel:   parseFloat((gps.vel || 0).toFixed(1)),
    hdg:   parseFloat((gps.hdg || 0).toFixed(1)),
    spm:   parseFloat((spm || 0).toFixed(1)),
    gps_q: Math.round(gps.gps_q || 0),
  };

  // Agregar al buffer de escritura
  _writeBuffer.push(JSON.stringify(linea));

  // Agregar al buffer del parcial (con el objeto completo para generar GeoJSON)
  _parcialBuffer.push(linea);

  // Stats
  _stats.totalEventos++;
  if (rawInt > 0) {
    _stats.totalPulsos += rawInt;
    if (bajada) _stats.surcoActivo.add(bajada);
  }
}

/**
 * Iniciar un nuevo lote.
 */
function iniciarLote(loteId, nombre, perfil) {
  // Si hay un lote activo, cerrarlo primero
  if (_loteActivo) cerrarLote();

  const loteDir = path.join(LOTES_DIR, loteId);
  if (!fs.existsSync(loteDir)) fs.mkdirSync(loteDir, { recursive: true });

  // Stream de escritura para eventos.ndjson
  const eventosPath = path.join(loteDir, "eventos.ndjson");
  const stream = fs.createWriteStream(eventosPath, { flags: "a" });

  _loteActivo = { id: loteId, nombre, dir: loteDir, stream };
  _seq = _recuperarUltimoSeq(eventosPath);
  _writeBuffer = [];
  _parcialBuffer = [];
  _ultimoRaw.clear();
  _stats = { totalEventos: 0, totalPulsos: 0, surcoActivo: new Set() };

  // Iniciar GPS a disco
  gpsBuffer.iniciarDisco(path.join(loteDir, "gps.ndjson"));

  // Guardar metadata
  const metadata = {
    id:         loteId,
    nombre,
    inicio:     new Date().toISOString(),
    fin:        null,
    perfil:     perfil?.nombre || null,
    surcos:     perfil?.setup?.qty_surcos || null,
    cultivo:    perfil?.setup?.cultivo || null,
    raw_def:    "pulsos_por_ventana_500ms",
    version:    "1.0",
  };
  fs.writeFileSync(
    path.join(loteDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8"
  );

  // Timers de flush y parcial
  _iniciarTimers();

  console.log(`\x1b[32m[LoteRecorder]\x1b[0m Lote iniciado: "${nombre}" (${loteId})`);
  _emitirEstado();

  return _loteActivo;
}

/**
 * Cerrar lote activo. Flush final, generar exports.
 * Retorna info del lote cerrado.
 */
function cerrarLote() {
  if (!_loteActivo) return null;

  // Flush final
  _flushADisco();
  _detenerTimers();

  // Cerrar streams
  if (_loteActivo.stream) {
    try { _loteActivo.stream.end(); } catch {}
  }
  gpsBuffer.cerrarDisco();

  // Actualizar metadata con fin
  const metaPath = path.join(_loteActivo.dir, "metadata.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.fin = new Date().toISOString();
    meta.totalEventos = _stats.totalEventos;
    meta.totalPulsos = _stats.totalPulsos;
    meta.surcosUsados = _stats.surcoActivo.size;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    console.error("[LoteRecorder] Error actualizando metadata:", e.message);
  }

  // Generar exports (GeoJSON final + shapefile + resumen)
  let exportResult = null;
  try {
    const mapExporter = require("./map_exporter");
    exportResult = mapExporter.exportarLote(_loteActivo.dir);
  } catch (e) {
    console.error("[LoteRecorder] Error en export:", e.message);
  }

  console.log(
    `\x1b[33m[LoteRecorder]\x1b[0m Lote cerrado: "${_loteActivo.nombre}" — ` +
    `${_stats.totalEventos.toLocaleString()} eventos, ` +
    `${_stats.totalPulsos.toLocaleString()} pulsos`
  );

  const resultado = {
    id:     _loteActivo.id,
    nombre: _loteActivo.nombre,
    dir:    _loteActivo.dir,
    stats:  { ..._stats, surcoActivo: _stats.surcoActivo.size },
    exports: exportResult,
  };

  _loteActivo = null;
  _writeBuffer = [];
  _parcialBuffer = [];
  _ultimoRaw.clear();

  _emitirEstado();
  return resultado;
}

/**
 * Retorna estado actual para API y Socket.IO.
 */
function getEstado() {
  return {
    activo:   !!_loteActivo,
    loteId:   _loteActivo?.id || null,
    nombre:   _loteActivo?.nombre || null,
    eventos:  _stats.totalEventos,
    pulsos:   _stats.totalPulsos,
    surcos:   _stats.surcoActivo.size,
    gpsOk:    gpsBuffer.size > 0,
  };
}

/**
 * Retorna la referencia al gpsBuffer (para que mqtt_handler lo use).
 */
function getGpsBuffer() {
  return gpsBuffer;
}

/**
 * Listar lotes en disco con su metadata.
 */
function listarLotes() {
  try {
    const dirs = fs.readdirSync(LOTES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    return dirs.map(dir => {
      const metaPath = path.join(LOTES_DIR, dir, "metadata.json");
      try {
        return JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        return { id: dir, nombre: dir, error: "metadata no legible" };
      }
    }).sort((a, b) => (b.inicio || "").localeCompare(a.inicio || ""));
  } catch {
    return [];
  }
}

/**
 * Cargar el GeoJSON final de un lote cerrado.
 */
function cargarGeoJSON(loteId) {
  const p = path.join(LOTES_DIR, loteId, "final_puntos.geojson");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

// ─────────────────────────────────────────────────────────
// FLUSH A DISCO (cada 2 segundos)
// ─────────────────────────────────────────────────────────

function _flushADisco() {
  if (!_loteActivo || !_writeBuffer.length) return;

  try {
    const bloque = _writeBuffer.join("\n") + "\n";
    _loteActivo.stream.write(bloque);
    _writeBuffer = [];
  } catch (e) {
    console.error("[LoteRecorder] Error flush:", e.message);
    // NO limpiar buffer si falla — reintentar en el próximo flush
  }
}

// ─────────────────────────────────────────────────────────
// PARCIAL.GEOJSON (cada 30 segundos, ventana móvil 5 min)
// ─────────────────────────────────────────────────────────

function _generarParcial() {
  if (!_loteActivo) return;

  const ahora = Date.now();
  const limite = ahora - PARCIAL_VENTANA_MS;

  // Podar buffer: quitar eventos fuera de la ventana
  _parcialBuffer = _parcialBuffer.filter(e => e.ts >= limite);

  if (_parcialBuffer.length === 0) return;

  const features = _parcialBuffer
    .filter(e => e.lat && e.lon)
    .map(e => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [e.lon, e.lat],
      },
      properties: {
        seq:    e.seq,
        ts:     e.ts,
        bajada: e.bajada,
        tipo:   e.tipo,
        raw:    e.raw,
        spm:    e.spm,
        vel:    e.vel,
        gps_q:  e.gps_q,
      },
    }));

  const geojson = {
    type: "FeatureCollection",
    metadata: {
      lote:     _loteActivo.nombre,
      ventana:  `${Math.round(PARCIAL_VENTANA_MS / 60000)} min`,
      puntos:   features.length,
      generado: new Date().toISOString(),
    },
    features,
  };

  const parcialPath = path.join(_loteActivo.dir, "parcial.geojson");
  try {
    fs.writeFileSync(parcialPath, JSON.stringify(geojson), "utf8");
  } catch (e) {
    console.error("[LoteRecorder] Error generando parcial:", e.message);
  }
}

// ─────────────────────────────────────────────────────────
// TIMERS
// ─────────────────────────────────────────────────────────

function _iniciarTimers() {
  _detenerTimers();
  _flushTimer   = setInterval(_flushADisco, FLUSH_INTERVAL_MS);
  _parcialTimer = setInterval(_generarParcial, PARCIAL_INTERVAL_MS);
}

function _detenerTimers() {
  if (_flushTimer)   { clearInterval(_flushTimer);   _flushTimer = null; }
  if (_parcialTimer) { clearInterval(_parcialTimer); _parcialTimer = null; }
}

// ─────────────────────────────────────────────────────────
// RECUPERACIÓN
// ─────────────────────────────────────────────────────────

function _recuperarLoteActivo() {
  try {
    const dirs = fs.readdirSync(LOTES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs.sort().reverse()) {
      const metaPath = path.join(LOTES_DIR, dir, "metadata.json");
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (!meta.fin) {
          // Lote sin cerrar encontrado
          const eventosPath = path.join(LOTES_DIR, dir, "eventos.ndjson");
          const loteDir = path.join(LOTES_DIR, dir);

          // Validar última línea del NDJSON
          _validarNdjson(eventosPath);

          // Recuperar seq
          _seq = _recuperarUltimoSeq(eventosPath);

          // Reabrir stream
          const stream = fs.createWriteStream(eventosPath, { flags: "a" });

          _loteActivo = { id: meta.id, nombre: meta.nombre, dir: loteDir, stream };
          _writeBuffer = [];
          _parcialBuffer = [];
          _ultimoRaw.clear();
          _stats = {
            totalEventos: meta.totalEventos || 0,
            totalPulsos:  meta.totalPulsos || 0,
            surcoActivo:  new Set(),
          };

          // Reabrir GPS a disco
          gpsBuffer.iniciarDisco(path.join(loteDir, "gps.ndjson"));

          _iniciarTimers();

          console.log(
            `\x1b[33m[LoteRecorder]\x1b[0m Lote recuperado: "${meta.nombre}" ` +
            `(seq=${_seq}, ${_stats.totalEventos} eventos previos)`
          );
          _emitirEstado();
          return;
        }
      } catch {}
    }
  } catch (e) {
    console.error("[LoteRecorder] Error en recuperación:", e.message);
  }
}

/**
 * Recuperar el último seq del archivo NDJSON.
 */
function _recuperarUltimoSeq(eventosPath) {
  if (!fs.existsSync(eventosPath)) return 0;
  try {
    const contenido = fs.readFileSync(eventosPath, "utf8");
    const lineas = contenido.trim().split("\n").filter(l => l.trim());
    if (lineas.length === 0) return 0;

    // Leer la última línea válida
    for (let i = lineas.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lineas[i]);
        return obj.seq || 0;
      } catch {}
    }
  } catch {}
  return 0;
}

/**
 * Validar NDJSON: si la última línea está corrupta, truncarla.
 */
function _validarNdjson(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    let contenido = fs.readFileSync(filePath, "utf8");
    const lineas = contenido.split("\n");

    // Encontrar y eliminar la última línea si está corrupta
    while (lineas.length > 0) {
      const ultima = lineas[lineas.length - 1].trim();
      if (ultima === "") {
        lineas.pop();
        continue;
      }
      try {
        JSON.parse(ultima);
        break; // última línea es válida
      } catch {
        console.log(`[LoteRecorder] Línea corrupta descartada: ${ultima.substring(0, 60)}...`);
        lineas.pop();
      }
    }

    fs.writeFileSync(filePath, lineas.join("\n") + (lineas.length > 0 ? "\n" : ""), "utf8");
  } catch (e) {
    console.error("[LoteRecorder] Error validando NDJSON:", e.message);
  }
}

// ─────────────────────────────────────────────────────────
// EMISIÓN DE ESTADO
// ─────────────────────────────────────────────────────────

function _emitirEstado() {
  _io?.emit("lote_recorder_status", getEstado());
}

// ─────────────────────────────────────────────────────────
module.exports = {
  init,
  registrarGPS,
  registrarEvento,
  iniciarLote,
  cerrarLote,
  getEstado,
  getGpsBuffer,
  listarLotes,
  cargarGeoJSON,
};
