/**
 * tests/integration/06_api_rest.test.js
 *
 * PASO 6 — API REST: endpoints de lote y configuración.
 *
 * Cubre (con servidor Express real en puerto efímero):
 *   GET  /api/mapa/lote-activo
 *   POST /api/mapa/iniciar
 *   POST /api/mapa/cerrar
 *   GET  /api/mapa/geojson/live
 *   GET  /api/mapa/historial
 *   GET  /api/config/maquinas
 *   POST /api/config/maquinas/guardar
 *
 * Usa supertest para HTTP y un servidor Express mínimo que
 * replica las rutas reales de server.js.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const request = require("supertest");
const { Server: SocketIOServer } = require("socket.io");
const { LOTE_MOCK, CONFIG_MOCK } = require("../../mocks/config.mock");

// ──────────────────────────────────────────────────────────────
// Levantar servidor Express mínimo de test
// ──────────────────────────────────────────────────────────────

const TEMP_DIR = path.join(os.tmpdir(), `vistax_api_test_${Date.now()}`);
const IMPL_DIR = path.join(TEMP_DIR, "implementos");
const LOTES_DIR = path.join(TEMP_DIR, "lotes");

let app, server, io;
let recorder; // map_recorder con LOTES_DIR temporal

function buildApp() {
  app = express();
  app.use(express.json());

  server = http.createServer(app);
  io = new SocketIOServer(server);

  // Usar inline recorder para tests
  recorder = _buildRecorder(LOTES_DIR);

  // ── /api/mapa ──
  app.get("/api/mapa/lote-activo", (req, res) => {
    res.json(recorder.getLoteActivo() || { activo: false });
  });

  app.post("/api/mapa/iniciar", (req, res) => {
    const { nombre, cultivo, variedad, estab, anchoPasada } = req.body;
    if (!nombre || !cultivo) {
      return res.status(400).json({ error: "nombre y cultivo son requeridos" });
    }
    try {
      const lote = recorder.iniciarLote(nombre, cultivo, anchoPasada, { variedad, estab });
      io.emit("lote_update", { activo: true, id: lote.id, nombre: lote.nombre, cultivo: lote.cultivo });
      res.json({ ok: true, lote });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/mapa/cerrar", (req, res) => {
    const resultado = recorder.cerrarLote();
    if (!resultado) return res.status(400).json({ error: "No hay lote activo" });
    io.emit("lote_update", { activo: false });
    res.json({ ok: true, ...resultado });
  });

  app.get("/api/mapa/geojson/live", (req, res) => {
    res.json(recorder.getGeoJSONLive());
  });

  app.get("/api/mapa/historial", (req, res) => {
    res.json(recorder.listarLotes());
  });

  // ── /api/config ──
  app.get("/api/config/maquinas", (req, res) => {
    const archivos = fs.readdirSync(IMPL_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
    res.json(archivos);
  });

  app.post("/api/config/maquinas/guardar", (req, res) => {
    const config = req.body;
    const id = config.id || "test_config";
    config.id = id;
    fs.writeFileSync(path.join(IMPL_DIR, `${id}.json`), JSON.stringify(config, null, 2));
    res.json({ status: "ok", id });
  });

  app.get("/api/config/maquinas/:id", (req, res) => {
    const file = path.join(IMPL_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "No encontrado" });
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  });

  return app;
}

// ──────────────────────────────────────────────────────────────

beforeAll((done) => {
  fs.mkdirSync(IMPL_DIR, { recursive: true });
  fs.mkdirSync(LOTES_DIR, { recursive: true });
  buildApp();
  server.listen(0, done);
});

afterAll((done) => {
  server.close(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    done();
  });
});

afterEach(() => {
  try { recorder.cerrarLote(); } catch (_) {}
});

// ──────────────────────────────────────────────────────────────

describe("PASO 6 — API REST: /api/mapa", () => {

  describe("GET /api/mapa/lote-activo", () => {
    it("retorna { activo: false } cuando no hay lote", async () => {
      const res = await request(app).get("/api/mapa/lote-activo");
      expect(res.status).toBe(200);
      expect(res.body.activo).toBe(false);
    });

    it("retorna el lote activo con nombre y cultivo", async () => {
      recorder.iniciarLote("Lote API Test", "maiz", 0.191);
      const res = await request(app).get("/api/mapa/lote-activo");
      expect(res.status).toBe(200);
      expect(res.body.nombre).toBe("Lote API Test");
    });
  });

  describe("POST /api/mapa/iniciar", () => {
    it("201-like — inicia lote con datos válidos", async () => {
      const res = await request(app)
        .post("/api/mapa/iniciar")
        .send(LOTE_MOCK);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.lote.nombre).toBe("Lote Norte Test");
      expect(res.body.lote.cultivo).toBe("maiz");
      expect(res.body.lote.id).toMatch(/^lote_\d+$/);
    });

    it("400 si falta nombre", async () => {
      const res = await request(app)
        .post("/api/mapa/iniciar")
        .send({ cultivo: "soja" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/nombre/i);
    });

    it("400 si falta cultivo", async () => {
      const res = await request(app)
        .post("/api/mapa/iniciar")
        .send({ nombre: "Mi Lote" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cultivo/i);
    });

    it("el body vacío retorna 400", async () => {
      const res = await request(app).post("/api/mapa/iniciar").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/mapa/cerrar", () => {
    it("cierra el lote activo y retorna ok:true", async () => {
      recorder.iniciarLote("Lote a Cerrar", "soja", 0.191);

      const res = await request(app).post("/api/mapa/cerrar");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("400 si no hay lote activo para cerrar", async () => {
      const res = await request(app).post("/api/mapa/cerrar");
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("GET /api/mapa/geojson/live", () => {
    it("retorna FeatureCollection con type y features", async () => {
      recorder.iniciarLote("GeoJSON Live API", "maiz", 0.191);
      const res = await request(app).get("/api/mapa/geojson/live");

      expect(res.status).toBe(200);
      expect(res.body.type).toBe("FeatureCollection");
      expect(Array.isArray(res.body.features)).toBe(true);
    });
  });

  describe("GET /api/mapa/historial", () => {
    it("retorna un array (vacío o con lotes)", async () => {
      const res = await request(app).get("/api/mapa/historial");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});

describe("PASO 6 — API REST: /api/config", () => {

  describe("GET /api/config/maquinas", () => {
    it("retorna array de nombres de implementos", async () => {
      // Escribir un config de test
      fs.writeFileSync(
        path.join(IMPL_DIR, "tanzi_43.json"),
        JSON.stringify(CONFIG_MOCK, null, 2)
      );

      const res = await request(app).get("/api/config/maquinas");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain("tanzi_43");
    });
  });

  describe("POST /api/config/maquinas/guardar", () => {
    it("guarda la configuración y retorna { status: ok, id }", async () => {
      const res = await request(app)
        .post("/api/config/maquinas/guardar")
        .send({ ...CONFIG_MOCK, id: "test_guardar" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.id).toBe("test_guardar");

      // Verificar que el archivo se escribió
      expect(fs.existsSync(path.join(IMPL_DIR, "test_guardar.json"))).toBe(true);
    });

    it("el archivo guardado contiene los sensores correctamente", async () => {
      await request(app)
        .post("/api/config/maquinas/guardar")
        .send({ ...CONFIG_MOCK, id: "test_sensores" });

      const guardado = JSON.parse(
        fs.readFileSync(path.join(IMPL_DIR, "test_sensores.json"), "utf8")
      );
      expect(guardado.mapeo_sensores).toHaveLength(CONFIG_MOCK.mapeo_sensores.length);
      expect(guardado.setup.densidad_objetivo).toBe(16);
    });
  });

  describe("GET /api/config/maquinas/:id", () => {
    it("retorna la config del implemento por id", async () => {
      fs.writeFileSync(
        path.join(IMPL_DIR, "tanzi_get.json"),
        JSON.stringify({ ...CONFIG_MOCK, id: "tanzi_get" }, null, 2)
      );

      const res = await request(app).get("/api/config/maquinas/tanzi_get");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("tanzi_get");
    });

    it("404 si el id no existe", async () => {
      const res = await request(app).get("/api/config/maquinas/no_existe");
      expect(res.status).toBe(404);
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Recorder inline para tests de integración
// ──────────────────────────────────────────────────────────────
function _buildRecorder(loteDir) {
  let loteActivo = null;
  let bufferPuntos = [];
  let estadoSensores = {};
  let ultimaPosGPS = null;
  const MIN_DIST_M = 0.8;

  function dist(lat1, lon1, lat2, lon2) {
    const R = 6371000, d2r = Math.PI / 180;
    const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  return {
    iniciarLote(nombre, cultivo, anchoPasada = 0.191, meta = {}) {
      const id = `lote_${Date.now()}`;
      loteActivo = { id, nombre, cultivo, variedad: meta.variedad || "", estab: meta.estab || "", anchoPasada: parseFloat(anchoPasada) };
      bufferPuntos = []; estadoSensores = {}; ultimaPosGPS = null;
      return loteActivo;
    },
    cerrarLote() {
      if (!loteActivo) return null;
      const lote = { ...loteActivo };
      loteActivo = null; bufferPuntos = []; estadoSensores = {};
      return { lote, geojsonPath: null };
    },
    getLoteActivo() { return loteActivo; },
    actualizarGPS(lat, lon, heading, vel) {
      if (!loteActivo) return undefined;
      if (ultimaPosGPS && dist(ultimaPosGPS.lat, ultimaPosGPS.lon, lat, lon) < MIN_DIST_M) return undefined;
      ultimaPosGPS = { lat, lon };
      const surcos = {};
      Object.entries(estadoSensores).forEach(([b, s]) => { surcos[b] = s.spm; });
      const spmProm = Object.values(surcos).filter(v=>v>0).reduce((a,b,_,arr)=>a+b/arr.length,0);
      const p = { lat, lon, heading: heading||0, vel: vel||0, ts: Date.now(), surcos, alerta: false, spmPromedio: parseFloat(spmProm.toFixed(1)) };
      bufferPuntos.push(p);
      return p;
    },
    actualizarSensor(bajada, spm, alerta) {
      estadoSensores[bajada] = { spm: parseFloat(spm)||0, alerta: !!alerta };
    },
    getGeoJSONLive() {
      return { type: "FeatureCollection", features: bufferPuntos.map(p => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { ts: p.ts, spmPromedio: p.spmPromedio, alerta: p.alerta } })) };
    },
    listarLotes() { return []; },
  };
}
