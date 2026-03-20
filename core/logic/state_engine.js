/**
 * State Engine: Mantiene el acumulado del trabajo actual
 */
let estadoGlobal = {
  loteActual: "LOTE_001",
  hectareas_totales: 0,
  semillas_totales: 0,
  fertilizante_total: 0,
  tiempo_trabajo: 0, // segundos
  bateria_nodos: 13.5,
  fallas_activas: [],
};

const actualizarGlobal = (update) => {
  estadoGlobal = { ...estadoGlobal, ...update };
  return estadoGlobal;
};

const getEstado = () => estadoGlobal;

module.exports = { actualizarGlobal, getEstado };
