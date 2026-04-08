/**
 * mocks/config.mock.js
 * Configuración de implemento de ejemplo para tests.
 * Simula un archivo data/implementos/tanzi_43.json real.
 */

const CONFIG_MOCK = {
  id: "tanzi_43",
  nombre: "Tanzi 43 Surcos Test",
  setup: {
    distancia_entre_surcos: 0.191,
    densidad_objetivo: 16,
    objetivos_tren: { 1: 16, 2: 18 },
    tolerancia_desvio: 20,
    factor_k_default: 0.15,
    p1000: 180,
    rpm_min: 2000,
    rpm_max: 5000,
    tolvas: 2,
    velocidad_max: 8.5,
    alarma_tiempo_seg: 2,
    min_bajadas_trigger: 3,
    seg_espera_trigger: 2,
  },
  mapeo_sensores: [
    // Tren 1 — semillas
    { uid: "VX-S3-A1", cable: 1, bajada: 1, tipo: "semilla", tren: 1, nombre: "Semilla 1", is_active: true },
    { uid: "VX-S3-A1", cable: 2, bajada: 2, tipo: "semilla", tren: 1, nombre: "Semilla 2", is_active: true },
    { uid: "VX-S3-A1", cable: 3, bajada: 3, tipo: "semilla", tren: 1, nombre: "Semilla 3", is_active: true },
    { uid: "VX-S3-A1", cable: 4, bajada: 4, tipo: "semilla", tren: 1, nombre: "Semilla 4", is_active: true },
    { uid: "VX-S3-A1", cable: 5, bajada: 5, tipo: "semilla", tren: 1, nombre: "Semilla 5", is_active: false }, // soft-delete
    // Tren 2 — semillas
    { uid: "VX-S3-B1", cable: 1, bajada: 6, tipo: "semilla", tren: 2, nombre: "Semilla 6", is_active: true },
    { uid: "VX-S3-B1", cable: 2, bajada: 7, tipo: "semilla", tren: 2, nombre: "Semilla 7", is_active: true },
    // Fertilizantes
    { uid: "VX-S3-A1", cable: 6, bajada: 1, tipo: "ferti_linea", tren: 1, nombre: "Ferti L 1", is_active: true },
    { uid: "VX-S3-A1", cable: 7, bajada: 1, tipo: "ferti_costado", tren: 1, nombre: "Ferti C 1", is_active: true },
    // Especiales
    { uid: "VX-S3-A1", cable: 8, bajada: 1, tipo: "turbina", tren: 1, nombre: "RPM 1", is_active: true },
  ],
};

/** Payload MQTT típico de un nodo ESP32 con 4 cables activos */
const MQTT_TELEMETRIA_MOCK = {
  uid: "VX-S3-A1",
  sensores: [
    { cable: 1, valor: 16.2, raw: 8 },
    { cable: 2, valor: 15.8, raw: 7 },
    { cable: 3, valor: 0,    raw: 0 }, // tapado
    { cable: 4, valor: 17.1, raw: 9 },
    { cable: 5, valor: 16.0, raw: 8 }, // inactivo — debe ignorarse
    { cable: 6, valor: 10.0, raw: 5 }, // ferti_linea
    { cable: 7, valor: 8.0,  raw: 4 }, // ferti_costado
    { cable: 8, valor: 3500, raw: 0 }, // turbina
  ],
};

/** Payload GPS típico del bridge CoreX/AOG */
const GPS_POSITION_MOCK = {
  lat: -34.612345,
  lon: -58.438765,
  heading: 45.0,
  speed: 7.2,
};

/** Lote de ejemplo */
const LOTE_MOCK = {
  nombre: "Lote Norte Test",
  cultivo: "maiz",
  variedad: "DK7210",
  estab: "Los Aromos",
  anchoPasada: 0.191,
};

module.exports = { CONFIG_MOCK, MQTT_TELEMETRIA_MOCK, GPS_POSITION_MOCK, LOTE_MOCK };
