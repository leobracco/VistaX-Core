/**
 * tests/unit/01_densidad_alertas.test.js
 *
 * PASO 1 — Cálculo de densidad y lógica de alertas.
 *
 * Cubre la lógica central del mqtt_handler:
 *   - Conversión de flujo (s/s) → semillas por metro (spm)
 *   - Detección de tubo tapado
 *   - Detección de desvío respecto al objetivo de tren
 *   - Soft-delete: sensores con is_active:false se ignoran
 *   - Sección cortada por AOG no genera alarma
 */

const { CONFIG_MOCK } = require("../../mocks/config.mock");

// ──────────────────────────────────────────────────────────────
// Lógica pura extraída del mqtt_handler para tests unitarios.
// En producción esta lógica vive dentro de initMQTT().
// ──────────────────────────────────────────────────────────────

function calcularSpm(flujo_s_s, velocidad_km_h) {
  if (velocidad_km_h <= 0.5) return 0;
  const velMs = velocidad_km_h / 3.6;
  return flujo_s_s / velMs;
}

function objetivoTren(config, numTren) {
  const porTren = config?.setup?.objetivos_tren;
  if (porTren && porTren[numTren] !== undefined) return parseFloat(porTren[numTren]);
  return parseFloat(config?.setup?.densidad_objetivo) || 16;
}

function toleranciaDesvio(config) {
  return parseFloat(config?.setup?.tolerancia_desvio) || 20;
}

function evaluarSensor({ flujo, velocidad, config, numTren, seccionCortada = false }) {
  const spm = calcularSpm(flujo, velocidad);
  const objetivo = objetivoTren(config, numTren);
  const tol = toleranciaDesvio(config);

  if (seccionCortada) return { spm, estado: "cortado", alerta: false };
  if (velocidad <= 1.5) return { spm, estado: "parado", alerta: false };
  if (flujo === 0) return { spm: 0, estado: "tapado", alerta: true };

  const pctDesvio = Math.abs((spm - objetivo) / objetivo) * 100;
  if (pctDesvio > tol) return { spm, estado: "desvio", alerta: false };

  return { spm, estado: "ok", alerta: false };
}

// ──────────────────────────────────────────────────────────────

describe("PASO 1 — Cálculo de densidad y alertas", () => {

  describe("calcularSpm()", () => {
    it("retorna 0 si la velocidad es ≤ 0.5 km/h (máquina parada)", () => {
      expect(calcularSpm(16, 0)).toBe(0);
      expect(calcularSpm(16, 0.5)).toBe(0);
    });

    it("calcula correctamente a 7.2 km/h con flujo 16 s/s → ~8 s/m", () => {
      // spm = 16 / (7.2/3.6) = 16/2 = 8
      const resultado = calcularSpm(16, 7.2);
      expect(resultado).toBeCloseTo(8, 1);
    });

    it("calcula correctamente a 3.6 km/h con flujo 16 s/s → ~16 s/m", () => {
      // spm = 16 / (3.6/3.6) = 16/1 = 16
      const resultado = calcularSpm(16, 3.6);
      expect(resultado).toBeCloseTo(16, 1);
    });

    it("no produce NaN ni Infinity con valores extremos", () => {
      expect(Number.isFinite(calcularSpm(0, 7.2))).toBe(true);
      expect(Number.isFinite(calcularSpm(100, 0.01))).toBe(true);
    });
  });

  describe("objetivoTren()", () => {
    it("retorna el objetivo específico del tren 1", () => {
      expect(objetivoTren(CONFIG_MOCK, 1)).toBe(16);
    });

    it("retorna el objetivo específico del tren 2", () => {
      expect(objetivoTren(CONFIG_MOCK, 2)).toBe(18);
    });

    it("usa densidad_objetivo global si no hay objetivo por tren", () => {
      const configSinTren = { setup: { densidad_objetivo: 14 } };
      expect(objetivoTren(configSinTren, 1)).toBe(14);
    });

    it("retorna 16 como fallback si no hay setup", () => {
      expect(objetivoTren({}, 1)).toBe(16);
      expect(objetivoTren(null, 1)).toBe(16);
    });
  });

  describe("evaluarSensor()", () => {
    const BASE = { config: CONFIG_MOCK, numTren: 1 };

    it("estado: parado — no genera alerta si velocidad ≤ 1.5 km/h", () => {
      const r = evaluarSensor({ ...BASE, flujo: 0, velocidad: 1.0 });
      expect(r.estado).toBe("parado");
      expect(r.alerta).toBe(false);
    });

    it("estado: tapado — flujo 0 con máquina en movimiento genera alerta", () => {
      const r = evaluarSensor({ ...BASE, flujo: 0, velocidad: 7.0 });
      expect(r.estado).toBe("tapado");
      expect(r.alerta).toBe(true);
    });

    it("estado: ok — flujo normal dentro de tolerancia", () => {
      // A 3.6 km/h, flujo=16 → spm=16, objetivo=16, desvío=0% → ok
      const r = evaluarSensor({ ...BASE, flujo: 16, velocidad: 3.6 });
      expect(r.estado).toBe("ok");
      expect(r.alerta).toBe(false);
    });

    it("estado: desvio — spm fuera de tolerancia del 20%", () => {
      // objetivo=16, tolerancia=20% → límite mín=12.8, máx=19.2
      // A 7.2 km/h, flujo=5 → spm=2.5 (muy bajo, desvío alto)
      const r = evaluarSensor({ ...BASE, flujo: 5, velocidad: 7.2 });
      expect(r.estado).toBe("desvio");
      expect(r.alerta).toBe(false);
    });

    it("estado: cortado — sección AOG desactivada nunca genera alerta", () => {
      const r = evaluarSensor({ ...BASE, flujo: 0, velocidad: 7.0, seccionCortada: true });
      expect(r.estado).toBe("cortado");
      expect(r.alerta).toBe(false);
    });

    it("tren 2 usa su propio objetivo (18 s/m)", () => {
      // A 3.6 km/h, flujo=18 → spm=18 = objetivo tren 2, sin desvío
      const r = evaluarSensor({ ...BASE, numTren: 2, flujo: 18, velocidad: 3.6 });
      expect(r.estado).toBe("ok");
      expect(r.spm).toBeCloseTo(18, 1);
    });
  });

  describe("Soft-delete (is_active:false)", () => {
    it("el sensor de bajada 5 está marcado is_active:false en el config", () => {
      const sensor5 = CONFIG_MOCK.mapeo_sensores.find(
        s => s.bajada === 5 && s.tipo === "semilla"
      );
      expect(sensor5).toBeDefined();
      expect(sensor5.is_active).toBe(false);
    });

    it("los sensores activos de tren 1 son exactamente bajadas 1-4", () => {
      const activos = CONFIG_MOCK.mapeo_sensores.filter(
        s => s.tren === 1 && s.tipo === "semilla" && s.is_active !== false
      );
      expect(activos.map(s => s.bajada).sort()).toEqual([1, 2, 3, 4]);
    });
  });

  describe("Tolerancia de desvío configurable", () => {
    const configTight = {
      setup: { densidad_objetivo: 16, tolerancia_desvio: 5 }
    };

    it("tolerancia del 5% — spm=15 ya dispara desvio (6.25% off)", () => {
      // spm = flujo / (vel/3.6). Para spm=15 a 3.6 km/h → flujo=15
      const r = evaluarSensor({ flujo: 15, velocidad: 3.6, config: configTight, numTren: 1 });
      expect(r.estado).toBe("desvio");
    });

    it("tolerancia del 20% — spm=15 NO dispara desvio (6.25% off < 20%)", () => {
      const r = evaluarSensor({ flujo: 15, velocidad: 3.6, config: CONFIG_MOCK, numTren: 1 });
      expect(r.estado).toBe("ok");
    });
  });
});
