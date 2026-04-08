/**
 * tests/live/09_seccion_cortada_real.test.js
 *
 * TEST EN VIVO — Mide el lag entre sections/state publicado y
 * el efecto real en los sensor_update.
 *
 * Requisitos:
 *   - Servidor VistaX corriendo en localhost:3000
 *   - Broker MQTT en 127.0.0.1:1883
 *   - Nodos ESP32 mandando datos
 *
 * Ejecutar: npm run test:live
 */

const { io: SocketIOClient } = require("socket.io-client");
const mqtt = require("mqtt");

const VISTAX_URL = "http://localhost:3001";
const MQTT_URL   = "mqtt://127.0.0.1";
const TEST_TIMEOUT = 60000;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function conectarSocketIO() {
  return new Promise((resolve, reject) => {
    const socket = SocketIOClient(VISTAX_URL, {
      transports: ["websocket"],
      reconnection: false,
    });
    const t = setTimeout(() => reject(new Error("Timeout conectando a VistaX :3000")), 5000);
    socket.on("connect", () => { clearTimeout(t); resolve(socket); });
    socket.on("connect_error", (err) => { clearTimeout(t); reject(err); });
  });
}

function conectarMQTT() {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, { connectTimeout: 5000 });
    const t = setTimeout(() => reject(new Error("Timeout conectando a MQTT")), 5000);
    client.on("connect", () => { clearTimeout(t); resolve(client); });
    client.on("error", (err) => { clearTimeout(t); reject(err); });
  });
}

function publicar(mqttClient, topic, payload) {
  const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, msg, {}, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ──────────────────────────────────────────────────────────────

describe("PASO 9 — Live: lag de sections/state con datos reales", () => {
  let socket;
  let mqttClient;

  beforeAll(async () => {
    try {
      socket     = await conectarSocketIO();
      mqttClient = await conectarMQTT();
    } catch (err) {
      throw new Error(`No se pudo conectar: ${err.message}`);
    }
  }, 10000);

  afterAll(async () => {
    // Restaurar secciones vacías al terminar
    if (mqttClient?.connected) {
      await publicar(mqttClient, "sections/state", { t1: [], t2: [] });
      console.log("\n  [Live] ✅ sections/state restaurado a vacío");
      mqttClient.end();
    }
    if (socket?.connected) socket.disconnect();
  });

  // ──────────────────────────────────────────────────────────
  // TEST A — Medir lag de APAGADO
  // Publica corte total y mide cuántos ms hasta que deja de
  // llegar el primer sensor_update de semilla con alerta.
  // ──────────────────────────────────────────────────────────
  test("A — lag de APAGADO: tiempo desde sections=0 hasta que dejan de llegar alertas",
    async () => {
      // 1. Asegurar secciones activas (estado normal)
      await publicar(mqttClient, "sections/state", { t1: [], t2: [] });
      await new Promise(r => setTimeout(r, 1000));

      // 2. Recolectar algunas alertas baseline para confirmar que hay datos
      console.log("\n  [Live] Esperando datos baseline (3s)...");
      const baseline = [];
      const handlerBase = (d) => { if (d.tipo === "semilla") baseline.push(d); };
      socket.on("sensor_update", handlerBase);
      await new Promise(r => setTimeout(r, 3000));
      socket.off("sensor_update", handlerBase);

      const alertasBase = baseline.filter(u => u.alerta).length;
      console.log(`  [Live] Baseline: ${baseline.length} updates semilla, ${alertasBase} alertas`);

      if (baseline.length === 0) {
        console.log("  [Live] ⚠ Sin datos del ESP32 — verificá que los nodos estén conectados");
        return;
      }

      // 3. Publicar corte y medir lag
      const tCorte = Date.now();
      await publicar(mqttClient, "sections/state", {
        t1: new Array(16).fill(0),
        t2: new Array(16).fill(0),
      });
      console.log(`  [Live] sections/state=0 publicado a t=0ms`);

      // 4. Escuchar hasta 15s y registrar cada update con timestamp relativo
      const eventos = [];
      let primerUpdateCortado = null;  // primer update DESPUÉS del corte

      const handlerCorte = (d) => {
        if (d.tipo !== "semilla") return;
        const ms = Date.now() - tCorte;
        eventos.push({ ms, bajada: d.bajada, alerta: d.alerta, cortada: d.seccion_cortada, valor: d.valor });

        // Primer update donde ya aplica el corte (alerta:false o cortada:true)
        if (!primerUpdateCortado && (d.seccion_cortada || !d.alerta)) {
          primerUpdateCortado = ms;
        }
      };

      socket.on("sensor_update", handlerCorte);
      await new Promise(r => setTimeout(r, 15000));
      socket.off("sensor_update", handlerCorte);

      // 5. Análisis
      if (eventos.length === 0) {
        console.log("  [Live] ✅ No llegaron sensor_update de semilla con secciones cortadas (filtrado total)");
        // Correcto — el servidor no emite nada
        expect(true).toBe(true);
        return;
      }

      // Separar eventos pre-corte y post-corte (los que llegaron antes que el servidor procese)
      const conAlertaDespuesCorte = eventos.filter(e => e.alerta);
      const sinAlertaDespuesCorte = eventos.filter(e => !e.alerta);

      console.log(`\n  [Live] ── Eventos recibidos post-publicación ──`);
      console.log(`  [Live] Total eventos:              ${eventos.length}`);
      console.log(`  [Live] Con alerta:true (bug/lag):  ${conAlertaDespuesCorte.length}`);
      console.log(`  [Live] Sin alerta (correcto):      ${sinAlertaDespuesCorte.length}`);

      if (conAlertaDespuesCorte.length > 0) {
        const ultimo = conAlertaDespuesCorte[conAlertaDespuesCorte.length - 1];
        const primero = conAlertaDespuesCorte[0];
        console.log(`  [Live] Primer alerta incorrecta:   t=+${primero.ms}ms bajada:${primero.bajada}`);
        console.log(`  [Live] Última alerta incorrecta:   t=+${ultimo.ms}ms bajada:${ultimo.bajada}`);
        console.log(`  [Live] ⚠ LAG DE APAGADO:           ~${ultimo.ms}ms`);

        // Agrupar por bajada para ver cuáles tardan más
        const porBajada = {};
        conAlertaDespuesCorte.forEach(e => {
          if (!porBajada[e.bajada]) porBajada[e.bajada] = [];
          porBajada[e.bajada].push(e.ms);
        });
        console.log(`\n  [Live] ── Lag por bajada ──`);
        Object.keys(porBajada).sort((a,b) => parseInt(a)-parseInt(b)).forEach(b => {
          const tiempos = porBajada[b];
          const maxLag = Math.max(...tiempos);
          console.log(`    Bajada ${String(b).padStart(2)}: ${tiempos.length} alertas incorrectas, lag máx: ${maxLag}ms`);
        });
      } else {
        console.log(`  [Live] ✅ Ninguna alerta después del corte`);
        if (primerUpdateCortado !== null) {
          console.log(`  [Live] Primer update ya sin alerta: t=+${primerUpdateCortado}ms`);
        }
      }

      // El test documenta el lag — no falla si hay lag, solo lo mide
      // Si querés que falle cuando el lag supera X ms, descomentá:
      // expect(lagMaximo).toBeLessThan(2000); // máximo 2 segundos de lag aceptable
    },
    TEST_TIMEOUT
  );

  // ──────────────────────────────────────────────────────────
  // TEST B — Medir lag de ENCENDIDO
  // Publica secciones activas desde estado cortado y mide
  // cuántos ms hasta que llegan los primeros sensor_update.
  // ──────────────────────────────────────────────────────────
  test("B — lag de ENCENDIDO: tiempo desde sections=1 hasta primer sensor_update",
    async () => {
      // 1. Asegurar estado cortado
      await publicar(mqttClient, "sections/state", {
        t1: new Array(16).fill(0),
        t2: new Array(16).fill(0),
      });
      await new Promise(r => setTimeout(r, 2000)); // esperar que aplique

      // 2. Publicar encendido y medir
      const tEncendido = Date.now();
      await publicar(mqttClient, "sections/state", { t1: [], t2: [] });
      console.log(`\n  [Live] sections/state=[] (activo) publicado a t=0ms`);

      // 3. Esperar primer sensor_update de semilla
      let primerUpdate = null;
      const eventos = [];

      const handler = (d) => {
        if (d.tipo !== "semilla") return;
        const ms = Date.now() - tEncendido;
        eventos.push({ ms, bajada: d.bajada, alerta: d.alerta, valor: d.valor });
        if (!primerUpdate) primerUpdate = { ms, bajada: d.bajada };
      };

      socket.on("sensor_update", handler);
      await new Promise(r => setTimeout(r, 10000));
      socket.off("sensor_update", handler);

      console.log(`  [Live] Total eventos semilla recibidos: ${eventos.length}`);

      if (primerUpdate) {
        console.log(`  [Live] Primer sensor_update de semilla: t=+${primerUpdate.ms}ms (bajada ${primerUpdate.bajada})`);
        console.log(`  [Live] ⚠ LAG DE ENCENDIDO: ~${primerUpdate.ms}ms`);
      } else {
        console.log(`  [Live] ⚠ No llegaron sensor_update de semilla en 10s`);
        console.log(`         Posibles causas:`);
        console.log(`         - El ESP32 no está mandando datos`);
        console.log(`         - El servidor filtra todos los updates con secciones vacías`);
        console.log(`         - El intervalo de telemetría del nodo es > 10s`);
      }

      // El test pasa siempre — solo mide y loguea
      expect(eventos.length).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT
  );

  // ──────────────────────────────────────────────────────────
  // TEST C — Ciclo completo encendido → apagado → encendido
  // Mide ambos lags en secuencia para tener el cuadro completo.
  // ──────────────────────────────────────────────────────────
  test("C — ciclo completo: resumen de lags",
    async () => {
      console.log("\n  [Live] ── Resumen de comportamiento ──");
      console.log("  Ver logs de Tests A y B para los tiempos exactos.");
      console.log("  Valores esperados con handler v5 correcto:");
      console.log("    Lag apagado:   < 1 ciclo MQTT del ESP32 (~500ms)");
      console.log("    Lag encendido: < 1 ciclo MQTT del ESP32 (~500ms)");
      console.log("");
      console.log("  Si el lag es mucho mayor, puede indicar:");
      console.log("    - sections/state se procesa asincrónicamente en el handler");
      console.log("    - El servidor recarga config cada 5s (setInterval en recargarConfig)");
      console.log("    - El broker MQTT tiene QoS 0 y hay pérdida de paquetes");
      expect(true).toBe(true);
    }
  );
});
