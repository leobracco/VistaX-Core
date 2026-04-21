// ============================================================
// VistaX — core/geo/map_exporter.js
//
// Se ejecuta al cerrar un lote. Lee eventos.ndjson y genera:
//   1. final_puntos.geojson    — todos los eventos georreferenciados
//   2. final_puntos.zip        — shapefile comprimido (descargable)
//   3. resumen.json            — estadísticas del lote
//
// Dependencia: npm install shp-write archiver
//   shp-write  → genera los archivos .shp/.dbf/.shx/.prj
//   archiver   → comprime en .zip
//
// Si shp-write no está instalado, solo genera GeoJSON y resumen.
// El shapefile es opcional — no bloquea el cierre del lote.
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");

// Shapefile es opcional
let shpwrite = null;
try {
  shpwrite = require("shp-write");
} catch {
  console.log("[MapExporter] shp-write no instalado — shapefile deshabilitado. Ejecutá: npm install shp-write");
}

let archiver = null;
try {
  archiver = require("archiver");
} catch {
  console.log("[MapExporter] archiver no instalado — zip deshabilitado. Ejecutá: npm install archiver");
}

/**
 * Exportar un lote completo desde su carpeta.
 * @param {string} loteDir - ruta a la carpeta del lote (data/lotes/{id}/)
 * @returns {object} { geojsonPath, shapefilePath, resumenPath, stats }
 */
function exportarLote(loteDir) {
  const eventosPath = path.join(loteDir, "eventos.ndjson");
  const metaPath    = path.join(loteDir, "metadata.json");

  if (!fs.existsSync(eventosPath)) {
    console.warn("[MapExporter] No existe eventos.ndjson en", loteDir);
    return null;
  }

  // Leer metadata
  let metadata = {};
  try {
    metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {}

  console.log(`[MapExporter] Procesando lote "${metadata.nombre || loteDir}"...`);

  // ── Leer NDJSON y construir features ──
  const features = [];
  const statsAcum = {
    totalEventos:     0,
    totalPulsos:      0,
    eventosRawCero:   0,
    eventosSinGps:    0,
    surcosUsados:     new Set(),
    tiposSensor:      new Set(),
    velMin:           Infinity,
    velMax:           0,
    velSum:           0,
    velCount:         0,
    spmSum:           0,
    spmCount:         0,
    gpsQSum:          0,
    gpsQMax:          0,
    latMin:           Infinity,
    latMax:           -Infinity,
    lonMin:           Infinity,
    lonMax:           -Infinity,
    tsInicio:         Infinity,
    tsFin:            0,
  };

  const contenido = fs.readFileSync(eventosPath, "utf8");
  for (const linea of contenido.split("\n")) {
    const trimada = linea.trim();
    if (!trimada) continue;

    let evt;
    try {
      evt = JSON.parse(trimada);
    } catch {
      continue; // línea corrupta, saltar
    }

    statsAcum.totalEventos++;
    if (evt.raw > 0) {
      statsAcum.totalPulsos += evt.raw;
    } else {
      statsAcum.eventosRawCero++;
    }

    if (!evt.lat || !evt.lon) {
      statsAcum.eventosSinGps++;
      continue;
    }

    if (evt.bajada) statsAcum.surcosUsados.add(evt.bajada);
    if (evt.tipo) statsAcum.tiposSensor.add(evt.tipo);
    if (evt.vel > 0) {
      statsAcum.velMin = Math.min(statsAcum.velMin, evt.vel);
      statsAcum.velMax = Math.max(statsAcum.velMax, evt.vel);
      statsAcum.velSum += evt.vel;
      statsAcum.velCount++;
    }
    if (evt.spm > 0) {
      statsAcum.spmSum += evt.spm;
      statsAcum.spmCount++;
    }
    if (evt.gps_q !== undefined) {
      statsAcum.gpsQSum += evt.gps_q;
      statsAcum.gpsQMax = Math.max(statsAcum.gpsQMax, evt.gps_q);
    }
    statsAcum.latMin = Math.min(statsAcum.latMin, evt.lat);
    statsAcum.latMax = Math.max(statsAcum.latMax, evt.lat);
    statsAcum.lonMin = Math.min(statsAcum.lonMin, evt.lon);
    statsAcum.lonMax = Math.max(statsAcum.lonMax, evt.lon);
    statsAcum.tsInicio = Math.min(statsAcum.tsInicio, evt.ts);
    statsAcum.tsFin    = Math.max(statsAcum.tsFin, evt.ts);

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [evt.lon, evt.lat],
      },
      properties: {
        seq:    evt.seq,
        ts:     evt.ts,
        uid:    evt.uid,
        cable:  evt.cable,
        bajada: evt.bajada,
        tipo:   evt.tipo,
        raw:    evt.raw,
        vel:    evt.vel,
        hdg:    evt.hdg,
        spm:    evt.spm,
        gps_q:  evt.gps_q,
      },
    });
  }

  console.log(`[MapExporter] ${features.length} features generadas`);

  // ── GeoJSON final ──
  const geojson = {
    type: "FeatureCollection",
    name: metadata.nombre || "VistaX Lote",
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    },
    metadata: {
      ...metadata,
      totalFeatures: features.length,
      generado: new Date().toISOString(),
    },
    features,
  };

  const geojsonPath = path.join(loteDir, "final_puntos.geojson");
  fs.writeFileSync(geojsonPath, JSON.stringify(geojson), "utf8");
  console.log(`[MapExporter] ✅ GeoJSON: ${geojsonPath} (${(fs.statSync(geojsonPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // ── Resumen ──
  const duracionSeg = statsAcum.tsFin > statsAcum.tsInicio
    ? Math.round((statsAcum.tsFin - statsAcum.tsInicio) / 1000)
    : 0;

  const resumen = {
    lote_id:          metadata.id,
    nombre:           metadata.nombre,
    inicio:           metadata.inicio,
    fin:              metadata.fin || new Date().toISOString(),
    duracion_seg:     duracionSeg,
    duracion_legible: _formatDuracion(duracionSeg),

    eventos_total:    statsAcum.totalEventos,
    eventos_con_gps:  features.length,
    eventos_sin_gps:  statsAcum.eventosSinGps,
    eventos_raw_cero: statsAcum.eventosRawCero,

    pulsos_total:     statsAcum.totalPulsos,
    surcos_usados:    statsAcum.surcosUsados.size,
    tipos_sensor:     [...statsAcum.tiposSensor],

    vel_promedio_kmh: statsAcum.velCount > 0
      ? parseFloat((statsAcum.velSum / statsAcum.velCount).toFixed(1))
      : 0,
    vel_min_kmh: statsAcum.velMin === Infinity ? 0 : statsAcum.velMin,
    vel_max_kmh: statsAcum.velMax,

    spm_promedio: statsAcum.spmCount > 0
      ? parseFloat((statsAcum.spmSum / statsAcum.spmCount).toFixed(1))
      : 0,

    gps_q_promedio_ms: statsAcum.totalEventos > 0
      ? Math.round(statsAcum.gpsQSum / statsAcum.totalEventos)
      : 0,
    gps_q_max_ms: statsAcum.gpsQMax,

    bbox: {
      latMin: statsAcum.latMin === Infinity ? null : statsAcum.latMin,
      latMax: statsAcum.latMax === -Infinity ? null : statsAcum.latMax,
      lonMin: statsAcum.lonMin === Infinity ? null : statsAcum.lonMin,
      lonMax: statsAcum.lonMax === -Infinity ? null : statsAcum.lonMax,
    },

    generado: new Date().toISOString(),
  };

  const resumenPath = path.join(loteDir, "resumen.json");
  fs.writeFileSync(resumenPath, JSON.stringify(resumen, null, 2), "utf8");
  console.log(`[MapExporter] ✅ Resumen: ${resumenPath}`);

  // ── Shapefile (opcional) ──
  let shapefilePath = null;
  if (shpwrite && features.length > 0) {
    try {
      shapefilePath = _generarShapefile(loteDir, features, metadata);
    } catch (e) {
      console.error("[MapExporter] ⚠ Error generando shapefile:", e.message);
    }
  }

  return { geojsonPath, shapefilePath, resumenPath, stats: resumen };
}

/**
 * Genera shapefile (.shp/.dbf/.shx/.prj) y lo comprime en .zip
 */
function _generarShapefile(loteDir, features, metadata) {
  // shp-write necesita datos en formato {lat, lng, ...props}
  // Limitar nombres de campo a 10 caracteres (restricción DBF)
  const points = features.map(f => ({
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    properties: {
      seq:    f.properties.seq,
      ts:     f.properties.ts,
      uid:    (f.properties.uid || "").slice(-6), // últimos 6 chars para caber en 10
      cable:  f.properties.cable,
      bajada: f.properties.bajada || 0,
      tipo:   (f.properties.tipo || "").substring(0, 10),
      raw:    f.properties.raw,
      vel:    f.properties.vel,
      hdg:    f.properties.hdg,
      spm:    f.properties.spm,
      gps_q:  f.properties.gps_q,
    },
  }));

  // shp-write genera un objeto con los buffers de cada archivo
  const shpData = shpwrite.zip({
    type: "FeatureCollection",
    features: features.map(f => ({
      ...f,
      properties: {
        seq:    f.properties.seq,
        ts:     f.properties.ts,
        uid:    (f.properties.uid || "").slice(-6),
        cable:  f.properties.cable,
        bajada: f.properties.bajada || 0,
        tipo:   (f.properties.tipo || "").substring(0, 10),
        raw:    f.properties.raw,
        vel:    f.properties.vel,
        hdg:    f.properties.hdg,
        spm:    f.properties.spm,
        gps_q:  f.properties.gps_q,
      },
    })),
  });

  const zipPath = path.join(loteDir, "final_puntos.zip");
  fs.writeFileSync(zipPath, Buffer.from(shpData));
  console.log(`[MapExporter] ✅ Shapefile: ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);

  return zipPath;
}

/**
 * Formatea segundos en "Xh Ym Zs"
 */
function _formatDuracion(seg) {
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = { exportarLote };
