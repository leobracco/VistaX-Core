/**
 * tests/integration/07_socketio_eventos.test.js
 *
 * PASO 7 — Socket.IO: flujo de datos en tiempo real.
 *
 * Cubre la cadena completa:
 *   MQTT simulado → procesamiento → io.emit → cliente Socket.IO recibe
 *
 * Tests:
 *   - sensor_update llega al cliente con los campos correctos
 *   - global_update llega con velocidad
 *   - lote_update llega al iniciar y al cerrar
 *   - sections_update llega cuando AOG manda corte
 *   - new_node_detected llega cuando se registra un nodo nuevo
 *   - Múltiples clientes reciben el mismo evento simultáneamente
 */

const express = require("express");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const { io: SocketIOClient } = require("socket.io-client");
const { CONFIG_MOCK, MQTT_TELEMETRIA_MOCK, LOTE_MOCK } = require("../../mocks/config.mock");
const { createIoMock } = require("../../mocks/io.mock");

// ──────────────────────────────────────────────────────────────
// Helper para esperar un evento específico de Socket.IO
// ──────────────────────────────────────────────────────────────
function waitForEvent(socket, eventName, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout esperando '${eventName}'`)), timeout);
    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function waitForEventMatching(socket, eventName, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout esperando '${eventName}'`)), timeout);
    const handler = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off(eventName, handler);
        resolve(data);
      }
    };
    socket.on(eventName, handler);
  });
}

// ──────────────────────────────────────────────────────────────
// Servidor de test minimal
// ──────────────────────────────────────────────────────────────
let serverInstance;
let ioServer;
let port;

/** Pipeline de procesamiento que usa el io real del servidor de test */
function buildPipeline(io, config) {
  let velocidad = 0;
  let seccionesT1 = [], seccionesT2 = [];
  let loteActivo = null;

  return {
    procesar(topic, payloadStr) {
      if (topic === "aog/machine/speed") {
        velocidad = parseFloat(payloadStr) || 0;
        io.emit("global_update", { velocidad });
        return;
      }

      let payload;
      try { payload = JSON.parse(payloadStr); } catch { return; }

      if (topic === "sections/state") {
        seccionesT1 = payload.t1 || [];
        seccionesT2 = payload.t2 || [];
        io.emit("sections_update", { t1: seccionesT1, t2: seccionesT2 });
        return;
      }

      if (topic === "vistax/nodos/registro") {
        const existe = config.mapeo_sensores?.some(s => s.uid === payload.uid);
        if (!existe) io.emit("new_node_detected", payload);
        return;
      }

      if (topic === "lote/iniciar") {
        loteActivo = { id: `lote_${Date.now()}`, ...payload };
        io.emit("lote_update", { activo: true, ...loteActivo });
        return;
      }

      if (topic === "lote/cerrar") {
        loteActivo = null;
        io.emit("lote_update", { activo: false });
        return;
      }

      if (topic === "vistax/nodos/telemetria") {
        const { uid, sensores } = payload;
        sensores?.forEach(raw => {
          const cable = parseInt(raw.cable);
          const cfg = config.mapeo_sensores?.find(
            s => s.uid === uid && parseInt(s.cable) === cable
          );
          if (!cfg || cfg.is_active === false) return;

          const valor = parseFloat(raw.valor);
          const spm = velocidad > 0.5 ? (valor / (velocidad / 3.6)).toFixed(1) : "0";
          const alerta = velocidad > 1.5 && valor === 0;

          io.emit("sensor_update", {
            bajada: cfg.bajada,
            tipo: cfg.tipo,
            tren: cfg.tren || 1,
            valor: valor.toFixed(1),
            alerta,
            nuevas_semillas: parseInt(raw.raw) || 0,
            spm,
            seccion_cortada: false,
          });
        });
      }
    },
  };
}

beforeAll((done) => {
  const app = express();
  serverInstance = http.createServer(app);
  ioServer = new SocketIOServer(serverInstance, { transports: ["websocket"] });

  serverInstance.listen(0, () => {
    port = serverInstance.address().port;
    done();
  });
});

afterAll((done) => {
  serverInstance.close(done);
});

// ──────────────────────────────────────────────────────────────

describe("PASO 7 — Socket.IO: flujo de datos en tiempo real", () => {
  let pipeline;
  let clientSocket;

  beforeEach((done) => {
    pipeline = buildPipeline(ioServer, CONFIG_MOCK);
    clientSocket = SocketIOClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    });
    clientSocket.on("connect", done);
  });

  afterEach((done) => {
    if (clientSocket.connected) clientSocket.disconnect();
    done();
  });

  // ── global_update ──
  it("cliente recibe global_update con velocidad correcta", async () => {
    const p = waitForEvent(clientSocket, "global_update");
    pipeline.procesar("aog/machine/speed", "7.20");
    const data = await p;
    expect(data.velocidad).toBe(7.2);
  });

  // ── sensor_update ──
  it("cliente recibe sensor_update para bajada 1 con spm calculado", async () => {
    pipeline.procesar("aog/machine/speed", "3.6"); // vel → spm = valor

    const p = waitForEventMatching(clientSocket, "sensor_update", d => d.bajada === 1);
    pipeline.procesar("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 1, valor: 16, raw: 8 }],
    }));

    const data = await p;
    expect(data.bajada).toBe(1);
    expect(data.tipo).toBe("semilla");
    expect(data.tren).toBe(1);
    expect(parseFloat(data.spm)).toBeCloseTo(16, 0);
    expect(data.alerta).toBe(false);
    expect(data.nuevas_semillas).toBe(8);
  });

  it("sensor_update con flujo=0 y vel>1.5 tiene alerta:true", async () => {
    pipeline.procesar("aog/machine/speed", "7.2");

    const p = waitForEventMatching(clientSocket, "sensor_update", d => d.bajada === 3);
    pipeline.procesar("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 3, valor: 0, raw: 0 }],
    }));

    const data = await p;
    expect(data.alerta).toBe(true);
  });

  it("sensor inactivo (is_active:false) NO genera sensor_update", async () => {
    pipeline.procesar("aog/machine/speed", "7.2");

    let recibido = false;
    clientSocket.on("sensor_update", d => {
      if (d.bajada === 5 && d.tipo === "semilla") recibido = true;
    });

    pipeline.procesar("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 5, valor: 16, raw: 8 }], // cable 5 = bajada 5 = is_active:false
    }));

    await new Promise(r => setTimeout(r, 200));
    expect(recibido).toBe(false);
  });

  // ── lote_update ──
  it("cliente recibe lote_update { activo:true } al iniciar lote", async () => {
    const p = waitForEvent(clientSocket, "lote_update");
    pipeline.procesar("lote/iniciar", JSON.stringify({ ...LOTE_MOCK }));
    const data = await p;
    expect(data.activo).toBe(true);
    expect(data.nombre).toBe("Lote Norte Test");
  });

  it("cliente recibe lote_update { activo:false } al cerrar lote", async () => {
    // Registrar el listener ANTES de procesar iniciar, filtrando solo activo:false.
    // Así evitamos agarrar el lote_update { activo:true } del iniciar.
    const p = waitForEventMatching(clientSocket, "lote_update", d => d.activo === false);
    pipeline.procesar("lote/iniciar", JSON.stringify({ ...LOTE_MOCK }));
    pipeline.procesar("lote/cerrar", "{}");
    const data = await p;
    expect(data.activo).toBe(false);
  });

  // ── sections_update ──
  it("cliente recibe sections_update con las secciones de AOG", async () => {
    const p = waitForEvent(clientSocket, "sections_update");
    pipeline.procesar("sections/state", JSON.stringify({ t1: [1,1,0,1], t2: [1,0] }));
    const data = await p;
    expect(data.t1).toEqual([1,1,0,1]);
    expect(data.t2).toEqual([1,0]);
  });

  // ── new_node_detected ──
  it("cliente recibe new_node_detected para UID desconocido", async () => {
    const p = waitForEvent(clientSocket, "new_node_detected");
    pipeline.procesar("vistax/nodos/registro", JSON.stringify({
      uid: "VX-NUEVO-TEST", firmware: "1.5.0", capacidad_cables: 8,
    }));
    const data = await p;
    expect(data.uid).toBe("VX-NUEVO-TEST");
  });

  it("NO emite new_node_detected para UID ya conocido", async () => {
    let recibido = false;
    clientSocket.on("new_node_detected", () => { recibido = true; });

    pipeline.procesar("vistax/nodos/registro", JSON.stringify({ uid: "VX-S3-A1" }));
    await new Promise(r => setTimeout(r, 200));
    expect(recibido).toBe(false);
  });

  // ── Múltiples clientes ──
  it("dos clientes reciben el mismo sensor_update simultáneamente", async () => {
    const client2 = SocketIOClient(`http://localhost:${port}`, {
      transports: ["websocket"], reconnection: false,
    });
    await new Promise(r => client2.on("connect", r));

    pipeline.procesar("aog/machine/speed", "7.2");

    const p1 = waitForEventMatching(clientSocket, "sensor_update", d => d.bajada === 2);
    const p2 = waitForEventMatching(client2, "sensor_update", d => d.bajada === 2);

    pipeline.procesar("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 2, valor: 16, raw: 8 }],
    }));

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.bajada).toBe(2);
    expect(d2.bajada).toBe(2);
    expect(d1.spm).toBe(d2.spm);

    client2.disconnect();
  });
});
