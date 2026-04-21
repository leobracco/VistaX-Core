// ============================================================
// VistaX — sonido_eventos.js  (v3.0)
//
// Catálogo compartido de eventos sonoros por tipo de sensor.
// Lo usan tab_pantalla.js y tab_sensores.js (override individual).
// ============================================================

window.VISTAX_EVENTOS_POR_TIPO = {
  semilla: [
    { id: "tapado",         label: "Tubo tapado",      desc: "Sin pulsos con velocidad > mínima" },
    { id: "fuera_de_dosis", label: "Fuera de dosis",   desc: "Densidad por debajo de objetivo × tolerancia" },
  ],
  ferti_linea: [
    { id: "tapado",         label: "Línea tapada",     desc: "Sin pulsos con velocidad > mínima" },
    { id: "fuera_de_dosis", label: "Fuera de dosis",   desc: "Caudal por debajo del esperado" },
  ],
  ferti_costado: [
    { id: "tapado",         label: "Tapado",           desc: "Sin pulsos con velocidad > mínima" },
    { id: "fuera_de_dosis", label: "Fuera de dosis",   desc: "Caudal por debajo del esperado" },
  ],
  turbina: [
    { id: "rpm_fuera_rango", label: "RPM fuera de rango", desc: "RPM fuera del rango de Monitoreo" },
    { id: "detenida",        label: "Detenida",          desc: "Sin pulsos con velocidad > mínima" },
  ],
  rotacion_eje: [
    { id: "detenido", label: "Eje detenido", desc: "Sin pulsos con velocidad > mínima" },
  ],
  tolva_vacia: [
    { id: "activacion", label: "Tolva se vacía", desc: "Cambio a estado vacío" },
  ],
  tolva_llena: [
    { id: "activacion", label: "Tolva se llena", desc: "Cambio a estado lleno" },
  ],
  bajada_herramienta: [
    { id: "activacion", label: "Cambio de estado", desc: "Bajada o subida de herramienta" },
  ],
  presion: [
    { id: "activacion", label: "Activación", desc: "Cambio de estado de presión" },
  ],
};

/**
 * Genera la key estable para un sensor en perfil.ui.sonidos.por_sensor.
 * Formato: ${uid}_${cable}
 */
window.vistaxKeyOverride = function(uid, cable) {
  return `${uid}_${cable}`;
};
