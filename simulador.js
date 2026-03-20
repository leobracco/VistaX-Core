// simulador.js
module.exports = function iniciarSimulador(io, getAppConfig) {
  console.log("🚜 Iniciando Tractor Fantasma (Simulador VistaX)...");

  // Bucle de GPS (Global) - 1 vez por segundo
  setInterval(() => {
    const config = getAppConfig();
    const targetFlujo = config.setup?.densidad_objetivo || 85;

    // Simulamos velocidad fluctuando entre 6.7 y 7.3 km/h
    //let velSimulada = 7.0 + (Math.random() * 0.6 - 0.3);

    io.emit("global_update", {
      //velocidad: velSimulada,
      promedio: Math.round(targetFlujo + (Math.random() * 4 - 2)),
    });
  }, 1000);

  // Bucle de Sensores - Actualiza cada 500ms
  setInterval(() => {
    const config = getAppConfig();
    if (!config || !config.mapeo_sensores) return;

    const targetFlujo = config.setup?.densidad_objetivo || 85;

    config.mapeo_sensores.forEach((sensor) => {
      let valor = 0;
      let alerta = false;

      switch (sensor.tipo) {
        case "semilla":
        case "ferti_linea":
        case "ferti_costado":
          // Fluctuación normal de siembra (+/- 3 sobre el objetivo)
          valor = targetFlujo + (Math.random() * 6 - 3);

          // ⚠️ FORZAR FALLA: Hacemos que la bajada 5 falle a propósito de a ratos
          if (sensor.bajada === 5 && Math.random() < 0.2) {
            valor = 0; // Tubo tapado
            alerta = true;
          } else if (valor < targetFlujo * 0.5) {
            alerta = true; // Alarma por bajo flujo extremo
          }
          valor = Math.max(0, valor).toFixed(1);
          break;

        case "turbina":
          // Simulamos RPM entre 3400 y 3600
          valor = Math.floor(3500 + (Math.random() * 200 - 100));
          alerta = false;
          break;

        case "tolva_vacia":
          // Simulamos que la tolva está llena (0). (Poné 1 acá si querés ver la alerta roja)
          valor = 0;
          alerta = false;
          break;

        case "bateria":
          // Alternador cargando entre 13.6V y 14.0V
          valor = (13.8 + (Math.random() * 0.4 - 0.2)).toFixed(1);
          alerta = false;
          break;
      }

      // Enviamos el dato al frontend
      io.emit("sensor_update", {
        tipo: sensor.tipo,
        bajada: sensor.bajada,
        valor: valor,
        alerta: alerta,
      });
    });
  }, 500);
};
