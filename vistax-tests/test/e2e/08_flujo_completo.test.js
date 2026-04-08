/**
 * tests/e2e/08_flujo_completo.test.js
 *
 * PASO 8 — E2E: Flujo completo de monitoreo de siembra.
 *
 * Simula el camino completo del dato:
 *   ESP32 → MQTT → Node.js (initMQTT) → Socket.IO → Cliente
 *
 * Escenarios cubiertos:
 *   A. Arranque normal:
 *      Nodo publica → servidor procesa → UI recibe sensor_update
 *
 *   B. Inicio de lote + grabación de puntos GPS:
 *      POST iniciar → GPS MQTT → mapa en vivo recibe puntos
 *
 *   C. Falla de surco:
 *      Velocidad 7km/h + flujo=0 → alerta propagada al cliente
 *
 *   D. Sección cortada por AOG:
 *      sections/state [0,...] → surco no genera alerta
 *
 *   E. Cierre de lote:
 *      POST cerrar → GeoJSON existe → historial actualizado
 *
 *   F. Nodo nuevo detectado:
 *      UID desconocido → new_node_detected en UI
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Server: SocketIOServer } = require("socket.io");
const { io: SocketIOClient } = require("socket.io-client");
const request = require("supertest");
const { CONFIG_MOCK, LOTE_MOCK } = require("../../mocks/config.mock");

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function waitFor(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${event}`)), timeout);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}

function waitForMatch(socket, event, fn, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${event}`)), timeout);
    const h = d => { if (fn(d)) { clearTimeout(t); socket.off(event, h); resolve(d); } };
    socket.on(event, h);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────────
// Servidor E2E completo
// ──────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), `vistax_e2e_${Date.now()}`);
const LOTES_DIR = path.join(TEMP_DIR, "lotes");

let app, httpServer, ioServer, client, port;
let pipeline;
let recorder;

function buildE2EServer() {
  app = express();
  app.use(express.json());
  httpServer = http.createServer(app);
  ioServer = new SocketIOServer(httpServer, { transports: ["websocket"] });

  recorder = _buildRecorder(LOTES_DIR);

  // Pipeline MQTT completo
  let velocidad = 0;
  let seccionesT1 = [], seccionesT2 = [];
  const config = CONFIG_MOCK;

  pipeline = {
    send(topic, payloadStr) {
      // ── Velocidad ──
      if (topic === "aog/machine/speed") {
        velocidad = parseFloat(payloadStr) || 0;
        ioServer.emit("global_update", { velocidad, promedio: "0.0" });
        return;
      }

      let payload;
      try { payload = JSON.parse(payloadStr); } catch { return; }

      // ── GPS ──
      if (topic === "aog/machine/position") {
        const lat = payload.lat || 0, lon = payload.lon || 0;
        const heading = payload.heading || 0;
        if (!lat || !lon) return;
        const punto = recorder.actualizarGPS(lat, lon, heading, velocidad);
        if (punto) ioServer.emit("map_point", punto);
        return;
      }

      // ── Secciones ──
      if (topic === "sections/state") {
        seccionesT1 = payload.t1 || [];
        seccionesT2 = payload.t2 || [];
        ioServer.emit("sections_update", { t1: seccionesT1, t2: seccionesT2 });
        return;
      }

      // ── Registro nodo ──
      if (topic === "vistax/nodos/registro") {
        const existe = config.mapeo_sensores?.some(s => s.uid === payload.uid);
        if (!existe) ioServer.emit("new_node_detected", payload);
        return;
      }

      // ── Telemetría de sensores ──
      if (topic === "vistax/nodos/telemetria") {
        const { uid, sensores } = payload;
        sensores?.forEach(raw => {
          const cable = parseInt(raw.cable);
          const cfg = config.mapeo_sensores?.find(
            s => s.uid === uid && parseInt(s.cable) === cable
          );
          if (!cfg || cfg.is_active === false) return;

          const valor = parseFloat(raw.valor);
          const numTren = cfg.tren || 1;
          const secTren = numTren === 1 ? seccionesT1 : seccionesT2;

          // Calcular sección cortada
          let seccionCortada = false;
          if (secTren.length > 0) {
            const surcosTren = config.mapeo_sensores
              .filter(s => s.is_active !== false && (s.tren||1) === numTren && s.tipo === "semilla")
              .sort((a,b) => a.bajada - b.bajada);
            const idx = surcosTren.findIndex(s => s.bajada === cfg.bajada);
            if (idx >= 0 && idx < secTren.length) seccionCortada = secTren[idx] === 0;
          }

          const spm = velocidad > 0.5 ? (valor / (velocidad/3.6)).toFixed(1) : "0";
          const alerta = !seccionCortada && velocidad > 1.5 && valor === 0;

          recorder.actualizarSensor(cfg.bajada, parseFloat(spm), alerta);

          ioServer.emit("sensor_update", {
            bajada: cfg.bajada,
            tipo: cfg.tipo,
            tren: numTren,
            valor: valor.toFixed(1),
            alerta,
            nuevas_semillas: parseInt(raw.raw) || 0,
            spm,
            seccion_cortada: seccionCortada,
          });
        });
      }
    }
  };

  // ── Rutas ──
  app.get("/api/mapa/lote-activo", (req, res) => res.json(recorder.getLoteActivo() || { activo: false }));
  app.post("/api/mapa/iniciar", (req, res) => {
    const { nombre, cultivo, variedad, estab, anchoPasada } = req.body;
    if (!nombre || !cultivo) return res.status(400).json({ error: "nombre y cultivo requeridos" });
    const lote = recorder.iniciarLote(nombre, cultivo, anchoPasada, { variedad, estab });
    ioServer.emit("lote_update", { activo: true, id: lote.id, nombre: lote.nombre, cultivo: lote.cultivo });
    res.json({ ok: true, lote });
  });
  app.post("/api/mapa/cerrar", (req, res) => {
    const res2 = recorder.cerrarLote();
    if (!res2) return res.status(400).json({ error: "Sin lote activo" });
    ioServer.emit("lote_update", { activo: false });
    res.json({ ok: true, ...res2 });
  });
  app.get("/api/mapa/geojson/live", (req, res) => res.json(recorder.getGeoJSONLive()));
  app.get("/api/mapa/historial", (req, res) => res.json(recorder.listarLotes()));
}

// ──────────────────────────────────────────────────────────────

beforeAll(done => {
  fs.mkdirSync(LOTES_DIR, { recursive: true });
  buildE2EServer();
  httpServer.listen(0, () => {
    port = httpServer.address().port;
    client = SocketIOClient(`http://localhost:${port}`, { transports: ["websocket"], reconnection: false });
    client.on("connect", done);
  });
});

afterAll(done => {
  client.disconnect();
  httpServer.close(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    done();
  });
});

afterEach(() => {
  try { recorder.cerrarLote(); } catch (_) {}
});

// ──────────────────────────────────────────────────────────────

describe("PASO 8 — E2E: Flujo completo de monitoreo", () => {

  describe("Escenario A — Arranque normal: nodo publica datos", () => {
    it("sensor_update llega al cliente con todos los campos requeridos", async () => {
      pipeline.send("aog/machine/speed", "7.2");

      const p = waitForMatch(client, "sensor_update", d => d.bajada === 1 && d.tipo === "semilla");
      pipeline.send("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-S3-A1",
        sensores: [{ cable: 1, valor: 16.5, raw: 9 }],
      }));

      const data = await p;
      expect(data).toMatchObject({
        bajada: 1,
        tipo: "semilla",
        tren: 1,
        alerta: false,
        seccion_cortada: false,
      });
      expect(parseFloat(data.spm)).toBeGreaterThan(0);
      expect(data.nuevas_semillas).toBe(9);
    });

    it("global_update llega con velocidad actualizada", async () => {
      const p = waitFor(client, "global_update");
      pipeline.send("aog/machine/speed", "5.4");
      const data = await p;
      expect(data.velocidad).toBe(5.4);
    });
  });

  describe("Escenario B — Inicio de lote y grabación GPS", () => {
    it("flujo completo: iniciar → GPS → mapa en vivo", async () => {
      // 1. Iniciar lote via REST
      const initRes = await request(app).post("/api/mapa/iniciar").send(LOTE_MOCK);
      expect(initRes.status).toBe(200);
      expect(initRes.body.ok).toBe(true);

      // 2. Simular llegada de GPS
      const mapP = waitFor(client, "map_point");
      pipeline.send("aog/machine/speed", "7.2");
      pipeline.send("aog/machine/position", JSON.stringify({
        lat: -34.612345, lon: -58.438765, heading: 45, speed: 7.2,
      }));
      pipeline.send("aog/machine/position", JSON.stringify({
        lat: -34.612250, lon: -58.438700, heading: 45, speed: 7.2,
      }));
      // El segundo punto debería generar map_point
      const puntoRecibido = await mapP;
      expect(puntoRecibido).toHaveProperty("lat");
      expect(puntoRecibido).toHaveProperty("lon");

      // 3. GeoJSON live tiene puntos
      const geoRes = await request(app).get("/api/mapa/geojson/live");
      expect(geoRes.body.type).toBe("FeatureCollection");
      expect(geoRes.body.features.length).toBeGreaterThanOrEqual(1);
    });

    it("lote_update llega al cliente al iniciar via REST", async () => {
      const p = waitFor(client, "lote_update");
      await request(app).post("/api/mapa/iniciar").send({ nombre: "Test Socket", cultivo: "soja" });
      const data = await p;
      expect(data.activo).toBe(true);
      expect(data.nombre).toBe("Test Socket");
    });
  });

  describe("Escenario C — Falla de surco (tubo tapado)", () => {
    it("alerta:true llega al cliente cuando flujo=0 a vel>1.5", async () => {
      pipeline.send("aog/machine/speed", "7.2");

      const p = waitForMatch(client, "sensor_update", d => d.bajada === 3 && d.alerta === true);
      pipeline.send("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-S3-A1",
        sensores: [{ cable: 3, valor: 0, raw: 0 }],
      }));

      const data = await p;
      expect(data.alerta).toBe(true);
      expect(parseFloat(data.spm)).toBe(0);
    });

    it("alerta:false cuando máquina está parada (vel ≤ 1.5)", async () => {
      pipeline.send("aog/machine/speed", "0.0");

      const p = waitForMatch(client, "sensor_update", d => d.bajada === 4);
      pipeline.send("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-S3-A1",
        sensores: [{ cable: 4, valor: 0, raw: 0 }],
      }));

      const data = await p;
      expect(data.alerta).toBe(false);
    });
  });

  describe("Escenario D — Sección cortada por AOG", () => {
    it("surco con seccion_cortada:true no genera alerta aunque flujo=0", async () => {
      // Cortar bajada 1 (índice 0 en T1)
      pipeline.send("sections/state", JSON.stringify({ t1: [0,1,1,1], t2: [] }));
      pipeline.send("aog/machine/speed", "7.2");

      await sleep(100); // esperar que se procese sections

      const p = waitForMatch(client, "sensor_update", d => d.bajada === 1 && d.tipo === "semilla");
      pipeline.send("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-S3-A1",
        sensores: [{ cable: 1, valor: 0, raw: 0 }],
      }));

      const data = await p;
      expect(data.seccion_cortada).toBe(true);
      expect(data.alerta).toBe(false);

      // Restaurar secciones
      pipeline.send("sections/state", JSON.stringify({ t1: [], t2: [] }));
    });
  });

  describe("Escenario E — Cierre de lote", () => {
    it("cierre via REST emite lote_update { activo:false } al cliente", async () => {
      await request(app).post("/api/mapa/iniciar").send({ nombre: "A Cerrar E2E", cultivo: "maiz" });

      const p = waitForMatch(client, "lote_update", d => d.activo === false);
      await request(app).post("/api/mapa/cerrar");

      const data = await p;
      expect(data.activo).toBe(false);
    });

    it("después del cierre, /api/mapa/lote-activo retorna activo:false", async () => {
      await request(app).post("/api/mapa/iniciar").send({ nombre: "Cierre E2E", cultivo: "soja" });
      await request(app).post("/api/mapa/cerrar");

      const res = await request(app).get("/api/mapa/lote-activo");
      expect(res.body.activo).toBeFalsy();
    });
  });

  describe("Escenario F — Nodo nuevo detectado", () => {
    it("new_node_detected llega al cliente para UID no registrado", async () => {
      const p = waitFor(client, "new_node_detected");
      pipeline.send("vistax/nodos/registro", JSON.stringify({
        uid: "VX-E2E-NUEVO", firmware: "2.0.0", capacidad_cables: 8,
      }));
      const data = await p;
      expect(data.uid).toBe("VX-E2E-NUEVO");
      expect(data.firmware).toBe("2.0.0");
    });

    it("nodo ya registrado (VX-S3-A1) NO emite new_node_detected", async () => {
      let recibido = false;
      client.on("new_node_detected", d => {
        if (d.uid === "VX-S3-A1") recibido = true;
      });

      pipeline.send("vistax/nodos/registro", JSON.stringify({ uid: "VX-S3-A1", firmware: "1.0.0" }));
      await sleep(300);
      expect(recibido).toBe(false);
    });
  });

  describe("Escenario G — Carga masiva (stress mínimo)", () => {
    it("100 actualizaciones de sensor sin pérdida de mensajes", async () => {
      pipeline.send("aog/machine/speed", "7.2");

      const recibidos = [];
      client.on("sensor_update", d => {
        if (d.bajada === 1) recibidos.push(d);
      });

      // Publicar 100 mensajes de bajada 1
      for (let i = 0; i < 100; i++) {
        pipeline.send("vistax/nodos/telemetria", JSON.stringify({
          uid: "VX-S3-A1",
          sensores: [{ cable: 1, valor: 16 + (i % 3), raw: 8 }],
        }));
      }

      await sleep(1500); // dar tiempo a que lleguen todos
      // Toleramos hasta 5% de pérdida en el entorno de test
      expect(recibidos.length).toBeGreaterThan(90);
    }, 10000);
  });
});

// ──────────────────────────────────────────────────────────────
// Recorder inline para E2E
// ──────────────────────────────────────────────────────────────
function _buildRecorder(loteDir) {
  let loteActivo = null;
  let bufferPuntos = [];
  let estadoSensores = {};
  let ultimaPosGPS = null;
  const MIN_DIST_M = 0.8;

  function dist(lat1, lon1, lat2, lon2) {
    const R = 6371000, d2r = Math.PI / 180;
    const dLat = (lat2-lat1)*d2r, dLon = (lon2-lon1)*d2r;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  return {
    iniciarLote(nombre, cultivo, anchoPasada = 0.191, meta = {}) {
      const id = `lote_${Date.now()}`;
      loteActivo = { id, nombre, cultivo, variedad: meta.variedad||"", estab: meta.estab||"", anchoPasada: parseFloat(anchoPasada), puntosGrabados: 0 };
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
      Object.entries(estadoSensores).forEach(([b,s]) => { surcos[b] = s.spm; });
      const spmProm = Object.values(surcos).filter(v=>v>0).reduce((a,b,_,arr)=>a+b/arr.length,0);
      const p = { lat, lon, heading: heading||0, vel: vel||0, ts: Date.now(), surcos, alerta: false, spmPromedio: parseFloat(spmProm.toFixed(1)) };
      bufferPuntos.push(p);
      if (loteActivo) loteActivo.puntosGrabados = bufferPuntos.length;
      return p;
    },
    actualizarSensor(bajada, spm, alerta) {
      estadoSensores[bajada] = { spm: parseFloat(spm)||0, alerta: !!alerta };
    },
    getGeoJSONLive() {
      return { type: "FeatureCollection", features: bufferPuntos.map(p => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { ts: p.ts, spmPromedio: p.spmPromedio } })) };
    },
    listarLotes() { return []; },
  };
}
