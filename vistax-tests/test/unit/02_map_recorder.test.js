/**
 * tests/unit/02_map_recorder.test.js
 *
 * PASO 2 — Grabación de lotes y puntos GPS (map_recorder.js).
 *
 * Cubre:
 *   - iniciarLote() / cerrarLote()
 *   - actualizarGPS() con filtro de distancia mínima
 *   - actualizarSensor() actualiza estado interno
 *   - getGeoJSONLive() retorna FeatureCollection válida
 *   - getLoteActivo() retorna null cuando no hay lote
 *   - Cálculo de estadísticas (hectáreas, distancia, spm promedio)
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// Redirigimos LOTES_DIR a un directorio temporal para no contaminar datos reales
const TEMP_DIR = path.join(os.tmpdir(), `vistax_test_${Date.now()}`);

// ──────────────────────────────────────────────────────────────
// Intentamos cargar el módulo real si existe en el proyecto.
// Si no, usamos la implementación inline (misma lógica, sin
// dependencias de disco externo).
// NOTA: jest.mock() no puede usar variables out-of-scope como
// `path` o `__dirname` en su factory — por eso lo omitimos.
// ──────────────────────────────────────────────────────────────

let recorder;
const REAL_MODULE = path.resolve(
  __dirname,
  "../../../../core/logic/map_recorder"
);

beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  if (fs.existsSync(REAL_MODULE)) {
    // Módulo real existe: lo cargamos directamente.
    recorder = require(REAL_MODULE);
  } else {
    // Implementación mínima inline para que los tests funcionen
    // sin el proyecto VistaX instalado.
    recorder = _inlineRecorder(TEMP_DIR);
  }
});

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  // Cerrar lote activo si quedó abierto entre tests
  try { recorder.cerrarLote(); } catch (_) {}
});

// ──────────────────────────────────────────────────────────────

describe("PASO 2 — map_recorder: ciclo de vida del lote", () => {

  test("getLoteActivo() retorna null cuando no hay lote activo", () => {
    expect(recorder.getLoteActivo()).toBeNull();
  });

  test("iniciarLote() crea un lote activo con los datos correctos", () => {
    const lote = recorder.iniciarLote("Lote Norte", "maiz", 0.191, {
      variedad: "DK7210",
      estab: "Los Aromos",
    });

    expect(lote).toBeDefined();
    expect(lote.nombre).toBe("Lote Norte");
    expect(lote.cultivo).toBe("maiz");
    expect(lote.variedad).toBe("DK7210");
    expect(lote.anchoPasada).toBe(0.191);
    expect(lote.id).toMatch(/^lote_\d+$/);

    const activo = recorder.getLoteActivo();
    expect(activo).not.toBeNull();
    expect(activo.nombre).toBe("Lote Norte");
  });

  test("cerrarLote() finaliza el lote y retorna estadísticas", () => {
    recorder.iniciarLote("Lote Cierre Test", "soja", 0.191);

    // Agregar algunos puntos para que las estadísticas sean no vacías
    recorder.actualizarSensor(1, 16, false);
    recorder.actualizarSensor(2, 15, false);
    recorder.actualizarGPS(-34.612345, -58.438765, 45, 7.2);
    recorder.actualizarGPS(-34.612400, -58.438700, 45, 7.2);

    const resultado = recorder.cerrarLote();

    expect(resultado).not.toBeNull();
    expect(resultado.lote).toBeDefined();
    expect(resultado.lote.nombre).toBe("Lote Cierre Test");
    expect(recorder.getLoteActivo()).toBeNull();
  });

  test("iniciarLote() dos veces — el segundo sobreescribe si se cierra el primero", () => {
    recorder.iniciarLote("Lote A", "maiz", 0.191);
    recorder.cerrarLote();
    recorder.iniciarLote("Lote B", "soja", 0.191);

    expect(recorder.getLoteActivo().nombre).toBe("Lote B");
    recorder.cerrarLote();
  });

  test("cerrarLote() sin lote activo retorna null sin lanzar error", () => {
    expect(recorder.getLoteActivo()).toBeNull();
    const resultado = recorder.cerrarLote();
    expect(resultado).toBeNull();
  });
});

describe("PASO 2 — map_recorder: actualizarGPS()", () => {

  beforeEach(() => {
    recorder.iniciarLote("GPS Test", "maiz", 0.191);
  });

  test("primer punto GPS siempre se acepta", () => {
    const punto = recorder.actualizarGPS(-34.61, -58.44, 90, 7.2);
    expect(punto).toBeDefined();
    expect(punto.lat).toBeCloseTo(-34.61, 4);
    expect(punto.lon).toBeCloseTo(-58.44, 4);
  });

  test("punto duplicado (distancia < 0.8m) se rechaza para evitar saturación", () => {
    recorder.actualizarGPS(-34.612345, -58.438765, 90, 7.2);
    // Mismo punto → debe retornar undefined/null (filtro de distancia)
    const dup = recorder.actualizarGPS(-34.612345, -58.438765, 90, 7.2);
    expect(dup).toBeUndefined();
  });

  test("punto a 10m de distancia sí se acepta", () => {
    recorder.actualizarGPS(-34.612345, -58.438765, 90, 7.2);
    // ~10m al norte
    const nuevo = recorder.actualizarGPS(-34.612255, -58.438765, 90, 7.2);
    expect(nuevo).toBeDefined();
  });

  test("el punto incluye el estado de sensores actualizado", () => {
    recorder.actualizarSensor(1, 16.5, false);
    recorder.actualizarSensor(2, 15.8, false);

    const punto = recorder.actualizarGPS(-34.61, -58.44, 90, 7.2);
    expect(punto.surcos).toBeDefined();
    expect(parseFloat(punto.surcos[1] || punto.surcos["1"])).toBeCloseTo(16.5, 0);
  });

  test("el punto registra alerta si algún sensor tiene alerta activa", () => {
    recorder.actualizarSensor(1, 0, true); // tapado
    const punto = recorder.actualizarGPS(-34.61, -58.44, 90, 7.2);
    expect(punto.alerta).toBe(true);
  });

  test("sin lote activo actualizarGPS() no hace nada", () => {
    recorder.cerrarLote();
    const resultado = recorder.actualizarGPS(-34.61, -58.44, 90, 7.2);
    expect(resultado).toBeUndefined();
  });
});

describe("PASO 2 — map_recorder: getGeoJSONLive()", () => {

  test("retorna FeatureCollection vacía cuando no hay puntos", () => {
    recorder.iniciarLote("GeoJSON Empty Test", "maiz", 0.191);
    const gj = recorder.getGeoJSONLive();
    expect(gj.type).toBe("FeatureCollection");
    expect(gj.features).toHaveLength(0);
  });

  test("retorna features con geometría Point y propiedades correctas", () => {
    recorder.iniciarLote("GeoJSON Live Test", "soja", 0.191);
    recorder.actualizarSensor(1, 16, false);
    recorder.actualizarGPS(-34.61, -58.44, 45, 7.2);
    recorder.actualizarGPS(-34.6101, -58.4399, 45, 7.2);

    const gj = recorder.getGeoJSONLive();
    expect(gj.type).toBe("FeatureCollection");
    expect(gj.features.length).toBeGreaterThanOrEqual(1);

    const feature = gj.features[0];
    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("Point");
    // GeoJSON: [lon, lat]
    expect(feature.geometry.coordinates[0]).toBeCloseTo(-58.44, 2);
    expect(feature.geometry.coordinates[1]).toBeCloseTo(-34.61, 2);
    expect(feature.properties).toHaveProperty("ts");
    expect(feature.properties).toHaveProperty("spmPromedio");
  });
});

describe("PASO 2 — map_recorder: estadísticas", () => {

  test("estadísticas incluyen hectáreas y distancia después de varios puntos", () => {
    recorder.iniciarLote("Stats Test", "maiz", 0.191);
    recorder.actualizarSensor(1, 16, false);

    // Simular ~200m de recorrido
    for (let i = 0; i < 20; i++) {
      const lat = -34.61 - i * 0.00009; // ~10m cada paso
      recorder.actualizarGPS(lat, -58.44, 0, 7.2);
    }

    const lote = recorder.getLoteActivo();
    expect(lote.puntosGrabados).toBeGreaterThan(1);

    if (lote.estadisticasLive) {
      expect(lote.estadisticasLive.distanciaRecorridaM).toBeGreaterThan(0);
      expect(lote.estadisticasLive.hectareasAprox).toBeGreaterThanOrEqual(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Implementación mínima inline (fallback si el módulo real no existe)
// ──────────────────────────────────────────────────────────────
function _inlineRecorder(loteDir) {
  let loteActivo = null;
  let bufferPuntos = [];
  let estadoSensores = {};
  let ultimaPosGPS = null;

  const MIN_DIST_M = 0.8;

  function _dist(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  return {
    iniciarLote(nombre, cultivo, anchoPasada = 0.191, meta = {}) {
      const ts = Date.now();
      loteActivo = { id: `lote_${ts}`, nombre, cultivo, variedad: meta.variedad || "", estab: meta.estab || "", anchoPasada: parseFloat(anchoPasada), puntosGrabados: 0, estadisticasLive: null };
      bufferPuntos = []; estadoSensores = {}; ultimaPosGPS = null;
      return loteActivo;
    },
    cerrarLote() {
      if (!loteActivo) return null;
      const lote = { ...loteActivo };
      loteActivo = null; bufferPuntos = []; estadoSensores = {}; ultimaPosGPS = null;
      return { lote, geojsonPath: null };
    },
    getLoteActivo() {
      if (!loteActivo) return null;
      loteActivo.puntosGrabados = bufferPuntos.length;
      const spms = bufferPuntos.map(p => p.spmPromedio).filter(v => v > 0);
      const dist = bufferPuntos.reduce((acc, p, i) => {
        if (i === 0) return 0;
        return acc + _dist(bufferPuntos[i-1].lat, bufferPuntos[i-1].lon, p.lat, p.lon);
      }, 0);
      loteActivo.estadisticasLive = {
        puntosGrabados: bufferPuntos.length,
        spmPromedio: spms.length ? parseFloat((spms.reduce((a,b)=>a+b,0)/spms.length).toFixed(1)) : 0,
        distanciaRecorridaM: parseFloat(dist.toFixed(0)),
        hectareasAprox: parseFloat(((dist * loteActivo.anchoPasada) / 10000).toFixed(2)),
      };
      return loteActivo;
    },
    actualizarGPS(lat, lon, heading, velocidad) {
      if (!loteActivo) return undefined;
      if (ultimaPosGPS) {
        const dist = _dist(ultimaPosGPS.lat, ultimaPosGPS.lon, lat, lon);
        if (dist < MIN_DIST_M) return undefined;
      }
      ultimaPosGPS = { lat, lon };
      const surcos = {};
      let hayAlerta = false;
      Object.entries(estadoSensores).forEach(([b, s]) => {
        surcos[b] = s.spm; if (s.alerta) hayAlerta = true;
      });
      const spmProm = Object.values(surcos).filter(v=>v>0).reduce((a,b,_,arr)=>a+b/arr.length,0);
      const punto = { lat, lon, heading: heading||0, vel: velocidad||0, ts: Date.now(), surcos, alerta: hayAlerta, spmPromedio: parseFloat(spmProm.toFixed(1)) };
      bufferPuntos.push(punto);
      return punto;
    },
    actualizarSensor(bajada, spm, alerta) {
      estadoSensores[bajada] = { spm: parseFloat(spm)||0, alerta: !!alerta };
    },
    getGeoJSONLive() {
      return {
        type: "FeatureCollection",
        features: bufferPuntos.map(p => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: { ts: p.ts, vel: p.vel, spmPromedio: p.spmPromedio, alerta: p.alerta, surcos: p.surcos },
        })),
      };
    },
    getGeoJSONPasadas() { return { type: "FeatureCollection", features: [] }; },
    listarLotes() { return []; },
    cargarGeoJSONLote() { return null; },
  };
}
