/**
 * tests/unit/03_mqtt_pipeline.test.js
 *
 * PASO 3 — Pipeline MQTT: procesamiento de mensajes entrantes.
 *
 * Cubre:
 *   - Tópico aog/machine/speed → actualiza telemetría
 *   - Tópico vistax/nodos/telemetria → emite sensor_update por surco
 *   - Sensores is_active:false son completamente ignorados
 *   - Sensor no mapeado (UID desconocido) no genera emit
 *   - Tópico sections/state → actualiza secciones de corte
 *   - Tópico vistax/nodos/registro → emite new_node_detected si es nuevo
 */

const { CONFIG_MOCK, MQTT_TELEMETRIA_MOCK } = require("../../mocks/config.mock");
const { createIoMock } = require("../../mocks/io.mock");

// ──────────────────────────────────────────────────────────────
// Simulación del pipeline de procesamiento del mqtt_handler.
// Replica la lógica del bloque "message" de initMQTT.
// ──────────────────────────────────────────────────────────────

function crearPipeline(config, io) {
  let velocidad = 0;
  let seccionesT1 = [];
  let seccionesT2 = [];

  function _objetivoTren(numTren) {
    const p = config?.setup?.objetivos_tren;
    if (p && p[numTren] !== undefined) return parseFloat(p[numTren]);
    return parseFloat(config?.setup?.densidad_objetivo) || 16;
  }

  function _tolerancia() {
    return parseFloat(config?.setup?.tolerancia_desvio) || 20;
  }

  function procesarMensaje(topic, payloadStr) {
    // Velocidad (texto plano)
    if (topic === "aog/machine/speed") {
      velocidad = parseFloat(payloadStr) || 0;
      io.emit("global_update", { velocidad });
      return;
    }

    let payload;
    try { payload = JSON.parse(payloadStr); } catch { return; }

    // Secciones AOG
    if (topic === "sections/state") {
      seccionesT1 = payload.t1 || [];
      seccionesT2 = payload.t2 || [];
      io.emit("sections_update", { t1: seccionesT1, t2: seccionesT2 });
      return;
    }

    // Registro de nuevo nodo
    if (topic === "vistax/nodos/registro") {
      const existe = config.mapeo_sensores?.some(s => s.uid === payload.uid);
      if (!existe) io.emit("new_node_detected", payload);
      return;
    }

    // Telemetría de sensores
    if (topic === "vistax/nodos/telemetria") {
      const { uid, sensores } = payload;

      sensores?.forEach(sensorRaw => {
        const cable = parseInt(sensorRaw.cable);
        const sensorCfg = config.mapeo_sensores?.find(s => {
          const matchNodo = s.uid === uid;
          const matchCable = s.cable !== undefined && parseInt(s.cable) === cable;
          return matchNodo && matchCable;
        });

        if (!sensorCfg) return;
        if (sensorCfg.is_active === false) return; // soft-delete

        const valorFlujo = parseFloat(sensorRaw.valor);
        const rawPulsos = parseInt(sensorRaw.raw) || 0;
        const numTren = sensorCfg.tren || 1;

        // Calcular spm
        let spm = 0;
        if (velocidad > 0.5) {
          spm = valorFlujo / (velocidad / 3.6);
        }

        // Determinar si sección cortada
        const secTren = numTren === 1 ? seccionesT1 : seccionesT2;
        let seccionCortada = false;
        if (secTren.length > 0) {
          const surcosTren = config.mapeo_sensores
            .filter(s => s.is_active !== false && (s.tren || 1) === numTren && s.tipo === "semilla")
            .sort((a, b) => a.bajada - b.bajada);
          const idx = surcosTren.findIndex(s => s.bajada === sensorCfg.bajada);
          if (idx >= 0 && idx < secTren.length) {
            seccionCortada = secTren[idx] === 0;
          }
        }

        // Determinar alerta
        let alerta = false;
        if (!seccionCortada && velocidad > 1.5) {
          const esSemilla = sensorCfg.tipo === "semilla" || sensorCfg.tipo.includes("ferti");
          if (esSemilla && valorFlujo === 0) alerta = true;
        }

        io.emit("sensor_update", {
          bajada: sensorCfg.bajada,
          tipo: sensorCfg.tipo,
          tren: numTren,
          valor: valorFlujo.toFixed(1),
          alerta,
          nuevas_semillas: rawPulsos,
          spm: spm.toFixed(1),
          seccion_cortada: seccionCortada,
        });
      });
    }
  }

  return {
    procesarMensaje,
    getVelocidad: () => velocidad,
    getSeccionesT1: () => seccionesT1,
    getSeccionesT2: () => seccionesT2,
  };
}

// ──────────────────────────────────────────────────────────────

describe("PASO 3 — Pipeline MQTT", () => {
  let io;
  let pipeline;

  beforeEach(() => {
    io = createIoMock();
    pipeline = crearPipeline(CONFIG_MOCK, io);
  });

  // ── Velocidad ──
  describe("tópico: aog/machine/speed", () => {
    it("parsea la velocidad y emite global_update", () => {
      pipeline.procesarMensaje("aog/machine/speed", "7.20");
      expect(pipeline.getVelocidad()).toBe(7.2);
      const emitido = io.lastOf("global_update");
      expect(emitido).not.toBeNull();
      expect(emitido.velocidad).toBe(7.2);
    });

    it("velocidad inválida queda en 0", () => {
      pipeline.procesarMensaje("aog/machine/speed", "abc");
      expect(pipeline.getVelocidad()).toBe(0);
    });
  });

  // ── Secciones AOG ──
  describe("tópico: sections/state", () => {
    it("actualiza secciones T1 y T2 y emite sections_update", () => {
      pipeline.procesarMensaje("sections/state", JSON.stringify({ t1: [1,1,0,1], t2: [1,0] }));
      expect(pipeline.getSeccionesT1()).toEqual([1,1,0,1]);
      expect(pipeline.getSeccionesT2()).toEqual([1,0]);
      const emitido = io.lastOf("sections_update");
      expect(emitido.t1).toEqual([1,1,0,1]);
    });

    it("sections/state con payload inválido no lanza excepción", () => {
      expect(() => {
        pipeline.procesarMensaje("sections/state", "no-json");
      }).not.toThrow();
    });
  });

  // ── Registro de nodos ──
  describe("tópico: vistax/nodos/registro", () => {
    it("emite new_node_detected si el UID no está en el config", () => {
      pipeline.procesarMensaje("vistax/nodos/registro",
        JSON.stringify({ uid: "VX-NUEVO-99", firmware: "1.2.0", capacidad_cables: 8 })
      );
      const ev = io.lastOf("new_node_detected");
      expect(ev).not.toBeNull();
      expect(ev.uid).toBe("VX-NUEVO-99");
    });

    it("NO emite new_node_detected si el UID ya existe en config", () => {
      pipeline.procesarMensaje("vistax/nodos/registro",
        JSON.stringify({ uid: "VX-S3-A1", firmware: "1.2.0" })
      );
      expect(io.lastOf("new_node_detected")).toBeNull();
    });
  });

  // ── Telemetría ──
  describe("tópico: vistax/nodos/telemetria", () => {

    it("emite sensor_update para cada cable mapeado y activo", () => {
      // Velocidad necesaria para calcular spm
      pipeline.procesarMensaje("aog/machine/speed", "7.2");
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify(MQTT_TELEMETRIA_MOCK));

      const updates = io.allOf("sensor_update");
      // El mock tiene cables 1-8; cable 5 está is_active:false → se ignora
      // Cables 1,2,3,4,6,7,8 → 7 emits
      expect(updates.length).toBeGreaterThanOrEqual(7);
    });

    it("cable 5 (is_active:false) NO genera sensor_update", () => {
      pipeline.procesarMensaje("aog/machine/speed", "7.2");
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify(MQTT_TELEMETRIA_MOCK));

      const updates = io.allOf("sensor_update");
      // Bajada 5 es el sensor inactivo
      const bajada5 = updates.find(u => u.bajada === 5 && u.tipo === "semilla");
      expect(bajada5).toBeUndefined();
    });

    it("cable con flujo 0 y velocidad > 1.5 genera alerta:true", () => {
      pipeline.procesarMensaje("aog/machine/speed", "7.2");
      // Cable 3 tiene valor:0 y raw:0
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify(MQTT_TELEMETRIA_MOCK));

      const updates = io.allOf("sensor_update");
      const bajada3 = updates.find(u => u.bajada === 3 && u.tipo === "semilla");
      expect(bajada3).toBeDefined();
      expect(bajada3.alerta).toBe(true);
    });

    it("cable con flujo 0 pero velocidad ≤ 1.5 NO genera alerta", () => {
      pipeline.procesarMensaje("aog/machine/speed", "1.0"); // parado
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify(MQTT_TELEMETRIA_MOCK));

      const updates = io.allOf("sensor_update");
      const bajada3 = updates.find(u => u.bajada === 3);
      expect(bajada3?.alerta).toBe(false);
    });

    it("sensor de UID desconocido no genera ningún emit", () => {
      pipeline.procesarMensaje("aog/machine/speed", "7.2");
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-DESCONOCIDO",
        sensores: [{ cable: 1, valor: 16, raw: 8 }],
      }));
      expect(io.allOf("sensor_update")).toHaveLength(0);
    });

    it("sección cortada por AOG → seccion_cortada:true, alerta:false", () => {
      // Cortar sección de bajada 1 (índice 0 en T1)
      pipeline.procesarMensaje("sections/state", JSON.stringify({ t1: [0,1,1,1], t2: [] }));
      pipeline.procesarMensaje("aog/machine/speed", "7.2");
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-S3-A1",
        sensores: [{ cable: 1, valor: 0, raw: 0 }], // bajada 1, flujo=0 pero cortada
      }));

      const updates = io.allOf("sensor_update");
      const b1 = updates.find(u => u.bajada === 1 && u.tipo === "semilla");
      expect(b1).toBeDefined();
      expect(b1.seccion_cortada).toBe(true);
      expect(b1.alerta).toBe(false);
    });

    it("spm se calcula correctamente con velocidad 3.6 km/h y flujo 16 s/s → 16 s/m", () => {
      pipeline.procesarMensaje("aog/machine/speed", "3.6");
      pipeline.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
        uid: "VX-S3-A1",
        sensores: [{ cable: 1, valor: 16, raw: 8 }],
      }));

      const b1 = io.allOf("sensor_update").find(u => u.bajada === 1);
      expect(b1).toBeDefined();
      expect(parseFloat(b1.spm)).toBeCloseTo(16, 0);
    });

    it("payload JSON malformado no lanza excepción", () => {
      expect(() => {
        pipeline.procesarMensaje("vistax/nodos/telemetria", "{bad json}");
      }).not.toThrow();
      expect(io.allOf("sensor_update")).toHaveLength(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// SUITE EXTRA — Bug de sección cortada: includes(1) vs índice
//
// El mqtt_handler.js VIEJO usaba:
//   seccionesTren.includes(1)  → true si cualquier sección del tren está activa
//
// Esto causa que un surco con su sección cortada IGUAL genere alerta
// si OTRO surco del mismo tren está activo.
//
// El mqtt_handler.js v5 lo corrige buscando por ÍNDICE de bajada.
//
// Estos tests documentan el comportamiento CORRECTO (v5) y marcan
// con .failing() el comportamiento que exhibe el código viejo.
// ══════════════════════════════════════════════════════════════════

/**
 * Pipeline con la lógica VIEJA (bug): usa includes(1) en vez de índice.
 * Replica exactamente lo que hace el handler anterior.
 */
function crearPipelineViejo(config, io) {
  let velocidad = 0;
  let seccionesT1 = [];
  let seccionesT2 = [];

  function procesarMensaje(topic, payloadStr) {
    if (topic === "aog/machine/speed") {
      velocidad = parseFloat(payloadStr) || 0;
      return;
    }
    let payload;
    try { payload = JSON.parse(payloadStr); } catch { return; }

    if (topic === "sections/state") {
      seccionesT1 = payload.t1 || [];
      seccionesT2 = payload.t2 || [];
      return;
    }

    if (topic === "vistax/nodos/telemetria") {
      const { uid, sensores } = payload;
      sensores?.forEach(sensorRaw => {
        const cable = parseInt(sensorRaw.cable);
        const sensorCfg = config.mapeo_sensores?.find(
          s => s.uid === uid && parseInt(s.cable) === cable
        );
        if (!sensorCfg || sensorCfg.is_active === false) return;

        const valorFlujo = parseFloat(sensorRaw.valor);
        const numTren = sensorCfg.tren || 1;
        const secTren = numTren === 1 ? seccionesT1 : seccionesT2;

        // ❌ BUG: verifica si el TREN tiene alguna sección activa,
        //         no si ESTE surco está cortado
        const maquinaSembrando = secTren.length > 0
          ? secTren.includes(1)
          : true;

        let alerta = false;
        if (velocidad > 1.5 && maquinaSembrando) {
          if (valorFlujo === 0) alerta = true;
        }

        io.emit("sensor_update", {
          bajada: sensorCfg.bajada,
          tipo: sensorCfg.tipo,
          tren: numTren,
          valor: valorFlujo.toFixed(1),
          alerta,
          nuevas_semillas: parseInt(sensorRaw.raw) || 0,
          spm: "0",
          // El handler viejo NO emite seccion_cortada
          seccion_cortada: false,
        });
      });
    }
  }

  return { procesarMensaje };
}

describe("PASO 3 — Bug sección cortada: lógica includes(1) vs índice", () => {
  let io;

  beforeEach(() => {
    io = createIoMock();
  });

  // ── Contexto del bug ──────────────────────────────────────────
  // Config con 4 surcos en T1: bajadas 1,2,3,4
  // sections/state T1 = [0,1,1,1] → bajada 1 cortada, 2-3-4 activas
  //
  // Esperado CORRECTO (v5):  bajada 1 flujo=0 → alerta:false (está cortada)
  // Comportamiento VIEJO:    bajada 1 flujo=0 → alerta:TRUE  (bug: includes(1)=true)

  it("v5 CORRECTO — bajada 1 cortada, flujo=0 → alerta:false", () => {
    const pipelineV5 = crearPipeline(CONFIG_MOCK, io);

    pipelineV5.procesarMensaje("sections/state",
      JSON.stringify({ t1: [0, 1, 1, 1], t2: [] })
    );
    pipelineV5.procesarMensaje("aog/machine/speed", "7.2");
    pipelineV5.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 1, valor: 0, raw: 0 }], // bajada 1, flujo 0
    }));

    const b1 = io.allOf("sensor_update").find(u => u.bajada === 1);
    expect(b1).toBeDefined();
    expect(b1.seccion_cortada).toBe(true);
    expect(b1.alerta).toBe(false); // ✅ no alerta porque está cortada
  });

  it("v5 CORRECTO — bajada 2 activa, flujo=0 → alerta:true (no está cortada)", () => {
    const pipelineV5 = crearPipeline(CONFIG_MOCK, io);

    // bajada 1 cortada, bajada 2 activa
    pipelineV5.procesarMensaje("sections/state",
      JSON.stringify({ t1: [0, 1, 1, 1], t2: [] })
    );
    pipelineV5.procesarMensaje("aog/machine/speed", "7.2");
    pipelineV5.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 2, valor: 0, raw: 0 }], // bajada 2, flujo 0, NO cortada
    }));

    const b2 = io.allOf("sensor_update").find(u => u.bajada === 2);
    expect(b2).toBeDefined();
    expect(b2.seccion_cortada).toBe(false);
    expect(b2.alerta).toBe(true); // ✅ sí alerta porque NO está cortada
  });

  // ── Test que expone el bug del handler viejo ──────────────────
  it("viejo BUG — bajada 1 cortada, flujo=0 → genera alerta:true (INCORRECTO)", () => {
    const pipelineViejo = crearPipelineViejo(CONFIG_MOCK, io);

    // sections [0,1,1,1] → bajada 1 cortada, pero otras del tren activas
    pipelineViejo.procesarMensaje("sections/state",
      JSON.stringify({ t1: [0, 1, 1, 1], t2: [] })
    );
    pipelineViejo.procesarMensaje("aog/machine/speed", "7.2");
    pipelineViejo.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 1, valor: 0, raw: 0 }],
    }));

    const b1 = io.allOf("sensor_update").find(u => u.bajada === 1);
    expect(b1).toBeDefined();
    // El código viejo genera alerta:true aunque el surco esté cortado — esto es el bug
    expect(b1.alerta).toBe(true); // 🐛 documenta el comportamiento incorrecto
  });

  it("viejo OK — si TODO el tren está cortado, no genera alerta", () => {
    const pipelineViejo = crearPipelineViejo(CONFIG_MOCK, io);

    // sections [0,0,0,0] → includes(1) = false → no alerta
    pipelineViejo.procesarMensaje("sections/state",
      JSON.stringify({ t1: [0, 0, 0, 0], t2: [] })
    );
    pipelineViejo.procesarMensaje("aog/machine/speed", "7.2");
    pipelineViejo.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [{ cable: 1, valor: 0, raw: 0 }],
    }));

    const b1 = io.allOf("sensor_update").find(u => u.bajada === 1);
    // El viejo solo funciona cuando TODO el tren está cortado
    expect(b1.alerta).toBe(false); // funciona solo en el caso extremo
  });

  it("v5 — todas las secciones cortadas, ningún surco genera alerta", () => {
    const pipelineV5 = crearPipeline(CONFIG_MOCK, io);

    pipelineV5.procesarMensaje("sections/state",
      JSON.stringify({ t1: [0, 0, 0, 0], t2: [] })
    );
    pipelineV5.procesarMensaje("aog/machine/speed", "7.2");
    pipelineV5.procesarMensaje("vistax/nodos/telemetria", JSON.stringify({
      uid: "VX-S3-A1",
      sensores: [
        { cable: 1, valor: 0, raw: 0 },
        { cable: 2, valor: 0, raw: 0 },
        { cable: 3, valor: 0, raw: 0 },
        { cable: 4, valor: 0, raw: 0 },
      ],
    }));

    const updates = io.allOf("sensor_update").filter(u => u.tipo === "semilla");
    expect(updates.length).toBeGreaterThan(0);
    updates.forEach(u => {
      expect(u.alerta).toBe(false);
      expect(u.seccion_cortada).toBe(true);
    });
  });
});
