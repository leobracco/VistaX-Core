/**
 * tests/unit/04_lote_triggers.test.js
 *
 * PASO 4 — Ciclo de vida del lote e triggers de inicio.
 *
 * Cubre:
 *   - Trigger manual (POST /api/mapa/iniciar)
 *   - Trigger por sensor de semilla (N bajadas activas por X seg)
 *   - Trigger por señal AOG (aog/field/status painting:true)
 *   - "Posponer" bloquea re-trigger por 3 minutos
 *   - Si hay lote activo, triggers 2 y 3 no se disparan
 *   - cerrarLote emite lote_update { activo:false }
 */

const { createIoMock } = require("../../mocks/io.mock");
const { LOTE_MOCK } = require("../../mocks/config.mock");

// ──────────────────────────────────────────────────────────────
// Simulación del LoteManager / mapa_routes (lógica de servidor)
// ──────────────────────────────────────────────────────────────

function crearLoteManager(io) {
  let loteActivo = null;
  let pospuesto = false;
  let pospuestoTimer = null;
  let bajasConPulsos = {};
  let triggerTimer = null;

  const cfg = { minBajadas: 3, segEspera: 2 };

  function _hayLote() { return loteActivo !== null; }

  function iniciarLote({ nombre, cultivo, variedad = "", estab = "", anchoPasada = 0.191 }) {
    if (!nombre || !cultivo) throw new Error("nombre y cultivo son requeridos");
    loteActivo = {
      id: `lote_${Date.now()}`,
      nombre, cultivo, variedad, estab,
      anchoPasada: parseFloat(anchoPasada),
      activo: true,
      inicio: new Date().toISOString(),
    };
    io.emit("lote_update", { activo: true, ...loteActivo });
    return loteActivo;
  }

  function cerrarLote() {
    if (!loteActivo) return null;
    const lote = { ...loteActivo };
    loteActivo = null;
    io.emit("lote_update", { activo: false });
    return lote;
  }

  function posponer() {
    pospuesto = true;
    clearTimeout(pospuestoTimer);
    pospuestoTimer = setTimeout(() => { pospuesto = false; }, 3 * 60 * 1000);
  }

  /** Simula recepción de pulsos de semilla (trigger 3) */
  function recibirPulsoSemilla(bajada) {
    if (_hayLote() || pospuesto) return false;
    bajasConPulsos[bajada] = Date.now();

    // Limpiar bajadas > 5s
    const ahora = Date.now();
    for (const b in bajasConPulsos) {
      if (ahora - bajasConPulsos[b] > 5000) delete bajasConPulsos[b];
    }

    const activas = Object.keys(bajasConPulsos).length;
    if (activas >= cfg.minBajadas && !triggerTimer) {
      triggerTimer = setTimeout(() => {
        triggerTimer = null;
        if (!_hayLote() && !pospuesto && Object.keys(bajasConPulsos).length >= cfg.minBajadas) {
          io.emit("trigger_semilla", { bajadas: Object.keys(bajasConPulsos).length });
        }
      }, cfg.segEspera * 1000);
      return true; // trigger armado
    }
    return false;
  }

  /** Simula señal AOG (trigger 2) */
  function recibirFieldStatus(painting, fieldName = "") {
    if (_hayLote() || pospuesto) return false;
    if (painting) {
      io.emit("trigger_bridge", { fieldName });
      return true;
    }
    return false;
  }

  function cleanup() {
    clearTimeout(pospuestoTimer);
    clearTimeout(triggerTimer);
  }

  return {
    iniciarLote, cerrarLote, posponer,
    recibirPulsoSemilla, recibirFieldStatus,
    getLoteActivo: () => loteActivo,
    hayLote: _hayLote,
    cleanup,
    _resetPospuesto: () => { pospuesto = false; },
    _resetBajas: () => { bajasConPulsos = {}; clearTimeout(triggerTimer); triggerTimer = null; },
  };
}

// ──────────────────────────────────────────────────────────────

describe("PASO 4 — Ciclo de vida del lote", () => {
  let io;
  let manager;

  beforeEach(() => {
    io = createIoMock();
    manager = crearLoteManager(io);
  });

  afterEach(() => {
    manager.cleanup();
    io.clear();
  });

  // ── Inicio manual ──
  describe("Inicio manual del lote", () => {
    it("iniciarLote() crea el lote y emite lote_update { activo:true }", () => {
      const lote = manager.iniciarLote(LOTE_MOCK);

      expect(lote.nombre).toBe("Lote Norte Test");
      expect(lote.cultivo).toBe("maiz");
      expect(lote.activo).toBe(true);

      const ev = io.lastOf("lote_update");
      expect(ev.activo).toBe(true);
      expect(ev.nombre).toBe("Lote Norte Test");
    });

    it("iniciarLote() sin nombre lanza error", () => {
      expect(() => manager.iniciarLote({ cultivo: "soja" })).toThrow("nombre y cultivo son requeridos");
    });

    it("iniciarLote() sin cultivo lanza error", () => {
      expect(() => manager.iniciarLote({ nombre: "Lote Test" })).toThrow("nombre y cultivo son requeridos");
    });

    it("loteActivo tiene id, inicio ISO y anchoPasada", () => {
      const lote = manager.iniciarLote(LOTE_MOCK);
      expect(lote.id).toMatch(/^lote_\d+$/);
      expect(lote.inicio).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(lote.anchoPasada).toBe(0.191);
    });

    it("getLoteActivo() retorna null antes de iniciar", () => {
      expect(manager.getLoteActivo()).toBeNull();
    });

    it("getLoteActivo() retorna el lote después de iniciar", () => {
      manager.iniciarLote(LOTE_MOCK);
      expect(manager.getLoteActivo()).not.toBeNull();
      expect(manager.getLoteActivo().nombre).toBe("Lote Norte Test");
    });
  });

  // ── Cierre de lote ──
  describe("Cierre del lote", () => {
    it("cerrarLote() emite lote_update { activo:false }", () => {
      manager.iniciarLote(LOTE_MOCK);
      io.clear();

      manager.cerrarLote();

      const ev = io.lastOf("lote_update");
      expect(ev.activo).toBe(false);
      expect(manager.getLoteActivo()).toBeNull();
    });

    it("cerrarLote() sin lote activo retorna null sin emitir", () => {
      const resultado = manager.cerrarLote();
      expect(resultado).toBeNull();
      expect(io.allOf("lote_update")).toHaveLength(0);
    });

    it("después de cerrar se puede iniciar un nuevo lote", () => {
      manager.iniciarLote(LOTE_MOCK);
      manager.cerrarLote();
      const nuevo = manager.iniciarLote({ nombre: "Lote 2", cultivo: "soja" });
      expect(nuevo.nombre).toBe("Lote 2");
    });
  });

  // ── Trigger 2: señal AOG ──
  describe("Trigger 2 — señal AOG (painting:true)", () => {
    it("emite trigger_bridge cuando painting=true y no hay lote", () => {
      const disparado = manager.recibirFieldStatus(true, "Potrero Norte");
      expect(disparado).toBe(true);
      expect(io.lastOf("trigger_bridge")).not.toBeNull();
      expect(io.lastOf("trigger_bridge").fieldName).toBe("Potrero Norte");
    });

    it("NO emite trigger_bridge si ya hay un lote activo", () => {
      manager.iniciarLote(LOTE_MOCK);
      const disparado = manager.recibirFieldStatus(true, "Campo");
      expect(disparado).toBe(false);
      expect(io.allOf("trigger_bridge")).toHaveLength(0);
    });

    it("painting:false no emite nada", () => {
      manager.recibirFieldStatus(false);
      expect(io.allOf("trigger_bridge")).toHaveLength(0);
    });
  });

  // ── Trigger 3: semilla ──
  describe("Trigger 3 — sensor de semilla (N bajadas activas)", () => {
    it("NO arma trigger si activas < minBajadas (3)", () => {
      manager.recibirPulsoSemilla(1);
      manager.recibirPulsoSemilla(2);
      expect(io.allOf("trigger_semilla")).toHaveLength(0);
    });

    it("arma trigger cuando ≥ 3 bajadas tienen pulsos recientes", () => {
      const disparado = [1,2,3].map(b => manager.recibirPulsoSemilla(b));
      expect(disparado[2]).toBe(true); // el tercero arma el timer
    });

    it("NO arma trigger si hay lote activo", () => {
      manager.iniciarLote(LOTE_MOCK);
      const disparado = [1,2,3].map(b => manager.recibirPulsoSemilla(b));
      expect(disparado.every(d => d === false)).toBe(true);
    });
  });

  // ── Posponer ──
  describe("Función posponer()", () => {
    it("posponer() bloquea triggers 2 y 3", () => {
      manager.posponer();

      // Trigger 2 bloqueado
      manager.recibirFieldStatus(true, "Campo");
      expect(io.allOf("trigger_bridge")).toHaveLength(0);

      // Trigger 3 bloqueado
      [1,2,3].map(b => manager.recibirPulsoSemilla(b));
      expect(io.allOf("trigger_semilla")).toHaveLength(0);

      manager._resetPospuesto(); // limpiar para otros tests
    });

    it("después de resetear pospuesto, triggers vuelven a funcionar", () => {
      manager.posponer();
      manager._resetPospuesto();

      manager.recibirFieldStatus(true, "Campo");
      expect(io.lastOf("trigger_bridge")).not.toBeNull();
    });
  });
});
