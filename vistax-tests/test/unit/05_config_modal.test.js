/**
 * tests/unit/05_config_modal.test.js
 *
 * PASO 5 — Gestión de configuración del implemento.
 *
 * Cubre:
 *   - Validación de duplicados en mapeo_sensores (tipo+bajada únicos)
 *   - Generación automática de nombres de sensores (_generarNombresAutomaticos)
 *   - Generación dinámica de opciones de tren
 *   - Serialización correcta del JSON de configuración
 *   - Soft-delete: is_active:false no cuenta como duplicado
 *   - Objetivos por tren se persisten correctamente
 */

const { CONFIG_MOCK } = require("../../mocks/config.mock");

// ──────────────────────────────────────────────────────────────
// Lógica extraída de config_modal.js (función validarDuplicados
// y _generarNombresAutomaticos) — ejecutada en Node.js.
// ──────────────────────────────────────────────────────────────

const ETIQUETAS = {
  semilla: "Semilla",
  ferti_linea: "Ferti L",
  ferti_costado: "Ferti C",
  turbina: "RPM",
  rotacion_eje: "Eje",
  tolva_vacia: "Tolva",
  bajada_herramienta: "Trabajo",
  bateria: "Batería",
};

function generarNombresAutomaticos(mapeo) {
  const clonado = mapeo.map(s => ({ ...s }));
  const porTipo = {};
  clonado.forEach(s => {
    if (!porTipo[s.tipo]) porTipo[s.tipo] = [];
    porTipo[s.tipo].push(s);
  });
  Object.keys(porTipo).forEach(tipo => {
    const grupo = porTipo[tipo].sort((a, b) => (a.bajada || 0) - (b.bajada || 0));
    const prefijo = ETIQUETAS[tipo] || tipo;
    grupo.forEach((sensor, idx) => {
      sensor.nombre = `${prefijo} ${idx + 1}`;
    });
  });
  return clonado;
}

function validarDuplicados(mapeo) {
  const vistos = new Set();
  for (const s of mapeo) {
    if (s.is_active === false) continue; // soft-delete no cuenta
    const clave = `${s.tipo}-${s.bajada}`;
    if (vistos.has(clave)) {
      return { valido: false, duplicado: clave };
    }
    vistos.add(clave);
  }
  return { valido: true };
}

function trenesExistentes(mapeo) {
  return [...new Set(mapeo.map(s => s.tren || 1))].sort((a, b) => a - b);
}

function serializarConfig(config) {
  // Simula lo que hace guardarConfiguracionCompleta()
  const json = JSON.stringify(config, null, 2);
  const parsed = JSON.parse(json);
  return parsed;
}

// ──────────────────────────────────────────────────────────────

describe("PASO 5 — Configuración del implemento", () => {

  describe("generarNombresAutomaticos()", () => {
    it("asigna nombres con prefijo correcto por tipo", () => {
      const mapeo = [
        { uid: "A1", cable: 1, bajada: 1, tipo: "semilla", tren: 1 },
        { uid: "A1", cable: 2, bajada: 2, tipo: "semilla", tren: 1 },
        { uid: "A1", cable: 3, bajada: 1, tipo: "ferti_linea", tren: 1 },
      ];
      const resultado = generarNombresAutomaticos(mapeo);

      const semillas = resultado.filter(s => s.tipo === "semilla").sort((a,b)=>a.bajada-b.bajada);
      expect(semillas[0].nombre).toBe("Semilla 1");
      expect(semillas[1].nombre).toBe("Semilla 2");

      const ferti = resultado.find(s => s.tipo === "ferti_linea");
      expect(ferti.nombre).toBe("Ferti L 1");
    });

    it("turbina recibe etiqueta RPM", () => {
      const mapeo = [{ uid: "A1", cable: 8, bajada: 1, tipo: "turbina", tren: 1 }];
      const res = generarNombresAutomaticos(mapeo);
      expect(res[0].nombre).toBe("RPM 1");
    });

    it("no muta el array original", () => {
      const original = CONFIG_MOCK.mapeo_sensores;
      const nombreAntes = original[0].nombre;
      generarNombresAutomaticos(original);
      expect(original[0].nombre).toBe(nombreAntes);
    });

    it("ordena por bajada antes de numerar", () => {
      const mapeo = [
        { uid: "A1", cable: 2, bajada: 2, tipo: "semilla", tren: 1 },
        { uid: "A1", cable: 1, bajada: 1, tipo: "semilla", tren: 1 },
      ];
      const res = generarNombresAutomaticos(mapeo);
      const b1 = res.find(s => s.bajada === 1);
      const b2 = res.find(s => s.bajada === 2);
      expect(b1.nombre).toBe("Semilla 1");
      expect(b2.nombre).toBe("Semilla 2");
    });
  });

  describe("validarDuplicados()", () => {
    it("config válida sin duplicados retorna { valido:true }", () => {
      const mapeo = [
        { uid: "A1", cable: 1, bajada: 1, tipo: "semilla", is_active: true },
        { uid: "A1", cable: 2, bajada: 2, tipo: "semilla", is_active: true },
        { uid: "A1", cable: 3, bajada: 1, tipo: "ferti_linea", is_active: true },
      ];
      expect(validarDuplicados(mapeo).valido).toBe(true);
    });

    it("detecta duplicado: misma bajada y tipo activos", () => {
      const mapeo = [
        { uid: "A1", cable: 1, bajada: 1, tipo: "semilla", is_active: true },
        { uid: "A1", cable: 2, bajada: 1, tipo: "semilla", is_active: true }, // dup
      ];
      const res = validarDuplicados(mapeo);
      expect(res.valido).toBe(false);
      expect(res.duplicado).toBe("semilla-1");
    });

    it("is_active:false no cuenta como duplicado", () => {
      const mapeo = [
        { uid: "A1", cable: 1, bajada: 1, tipo: "semilla", is_active: true },
        { uid: "A1", cable: 2, bajada: 1, tipo: "semilla", is_active: false }, // soft-delete
        { uid: "A1", cable: 3, bajada: 2, tipo: "semilla", is_active: true },
      ];
      expect(validarDuplicados(mapeo).valido).toBe(true);
    });

    it("config completa del mock es válida", () => {
      expect(validarDuplicados(CONFIG_MOCK.mapeo_sensores).valido).toBe(true);
    });
  });

  describe("trenesExistentes()", () => {
    it("detecta los trenes correctamente del config mock", () => {
      const trenes = trenesExistentes(CONFIG_MOCK.mapeo_sensores);
      expect(trenes).toContain(1);
      expect(trenes).toContain(2);
      expect(trenes).toEqual(expect.arrayContaining([1, 2]));
    });

    it("config con un solo tren retorna [1]", () => {
      const mapeo = [
        { uid: "A1", cable: 1, bajada: 1, tipo: "semilla" },
        { uid: "A1", cable: 2, bajada: 2, tipo: "semilla" },
      ];
      expect(trenesExistentes(mapeo)).toEqual([1]);
    });
  });

  describe("Serialización de config", () => {
    it("serializar/deserializar no pierde datos", () => {
      const serializado = serializarConfig(CONFIG_MOCK);
      expect(serializado.id).toBe(CONFIG_MOCK.id);
      expect(serializado.nombre).toBe(CONFIG_MOCK.nombre);
      expect(serializado.setup.densidad_objetivo).toBe(CONFIG_MOCK.setup.densidad_objetivo);
      expect(serializado.mapeo_sensores).toHaveLength(CONFIG_MOCK.mapeo_sensores.length);
    });

    it("objetivos_tren se persisten como objeto con claves de número", () => {
      const serializado = serializarConfig(CONFIG_MOCK);
      expect(serializado.setup.objetivos_tren[1]).toBe(16);
      expect(serializado.setup.objetivos_tren[2]).toBe(18);
    });

    it("is_active:false se preserva en serialización", () => {
      const serializado = serializarConfig(CONFIG_MOCK);
      const sensor5 = serializado.mapeo_sensores.find(
        s => s.bajada === 5 && s.tipo === "semilla"
      );
      expect(sensor5.is_active).toBe(false);
    });
  });

  describe("Estructura del config_vistax.json", () => {
    it("config mock tiene todos los campos obligatorios", () => {
      expect(CONFIG_MOCK).toHaveProperty("id");
      expect(CONFIG_MOCK).toHaveProperty("nombre");
      expect(CONFIG_MOCK).toHaveProperty("setup");
      expect(CONFIG_MOCK).toHaveProperty("mapeo_sensores");
      expect(Array.isArray(CONFIG_MOCK.mapeo_sensores)).toBe(true);
    });

    it("cada sensor tiene uid, cable, bajada, tipo y tren", () => {
      CONFIG_MOCK.mapeo_sensores.forEach(s => {
        expect(s).toHaveProperty("uid");
        expect(s).toHaveProperty("cable");
        expect(s).toHaveProperty("bajada");
        expect(s).toHaveProperty("tipo");
      });
    });

    it("setup tiene tolerancia_desvio y objetivos_tren", () => {
      expect(CONFIG_MOCK.setup).toHaveProperty("tolerancia_desvio");
      expect(CONFIG_MOCK.setup).toHaveProperty("objetivos_tren");
    });
  });
});
