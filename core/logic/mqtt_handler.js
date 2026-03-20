const mqtt = require("mqtt");

// Ahora recibimos 'getConfig' (una función flecha)
function initMQTT(io, getConfig) {
  const client = mqtt.connect("mqtt://127.0.0.1");

  // Estado global en memoria para VistaX
  let telemetriaAOG = {
    velocidad: 0,
    seccionesT1: [],
    seccionesT2: [],
  };

  client.on("connect", () => {
    console.log("\x1b[36m[MQTT]\x1b[0m VistaX: Conectado al Broker MQTT local");

    // Escuchamos la telemetría de los Nodos ESP32 de la sembradora
    client.subscribe("vistax/nodos/telemetria");

    // Escuchamos la información que manda tu Bridge (GPS y Cortes)
    client.subscribe("aog/machine/speed");
    client.subscribe("sections/state");
    client.subscribe("vistax/nodos/registro");
  });

  client.on("message", (topic, message) => {
    try {
      const msgStr = message.toString();

      // RADAR DEBUG (Opcional, lo dejamos para monitorear)
      if (topic.includes("registro")) {
        console.log(`\n📡 [RADAR MQTT] Tópico recibido: ${topic}`);
        console.log(`📦 [RADAR MQTT] Payload: ${msgStr}\n`);
      }

      // ==========================================
      // 1. VELOCIDAD (Viene como texto plano del Bridge)
      // ==========================================
      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(msgStr) || 0;
        io.emit("global_update", { velocidad: telemetriaAOG.velocidad });
        return; // Salimos temprano
      }

      // ==========================================
      // PARSEO A JSON SEGURO
      // ==========================================
      let payload;
      try {
        payload = JSON.parse(msgStr);
      } catch (parseErr) {
        console.error(`❌ Error parseando JSON en tópico ${topic}:`, msgStr);
        return; // Si no es un JSON válido, abortamos aquí para no romper el servidor
      }

      // ==========================================
      // OBTENEMOS LA CONFIGURACIÓN MÁS RECIENTE
      // ==========================================
      const configFresca = getConfig();

      // ==========================================
      // 2. ESTADO DE CORTES DE SECCIÓN (Del Bridge)
      // ==========================================
      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        return;
      }

      // ==========================================
      // REGISTRO DE NUEVOS NODOS (PLUG & PLAY)
      // ==========================================
      if (topic === "vistax/nodos/registro") {
        console.log("--> [DEBUG] Entró al bloque de registro MQTT");
        let nodoExiste = false;

        // Verificamos si la configuración fresca y la matriz de sensores existen
        if (
          configFresca &&
          configFresca.mapeo_sensores &&
          Array.isArray(configFresca.mapeo_sensores)
        ) {
          nodoExiste = configFresca.mapeo_sensores.some(
            (sensor) => sensor.uid === payload.uid,
          );
          console.log(
            `--> [DEBUG] ¿El nodo ya está en la base de datos?: ${nodoExiste ? "SÍ" : "NO"}`,
          );
        } else {
          console.log(
            "--> [DEBUG] La máquina no tiene mapeo_sensores previo (es nueva)",
          );
        }

        if (!nodoExiste) {
          console.log(
            `\x1b[32m[VistaX]\x1b[0m Nuevo nodo detectado: ${payload.uid} (FW: ${payload.firmware})`,
          );
          io.emit("new_node_detected", payload);
          console.log(
            "--> [DEBUG] Alerta enviada a la pantalla web por Socket.IO",
          );
        } else {
          console.log(
            `\x1b[33m[VistaX]\x1b[0m El nodo ${payload.uid} ya está registrado en esta máquina. Se ignora la alerta.`,
          );
        }
        return;
      }

      // ==========================================
      // 3. DATOS DE LOS SENSORES VISTAX (Del ESP32)
      // ==========================================
      if (topic === "vistax/nodos/telemetria") {
        const uidNodo = payload.uid;

        // Utilizamos configFresca en lugar del config estático
        if (payload.sensores && configFresca && configFresca.mapeo_sensores) {
          payload.sensores.forEach((sensorRaw) => {
            // --- BUSQUEDA A PRUEBA DE BALAS ---
            const cableFisico = parseInt(sensorRaw.cable);
            const sensorConfig = configFresca.mapeo_sensores.find((s) => {
              const matchNodo = s.uid === uidNodo;
              const matchPin =
                s.pin !== undefined && parseInt(s.pin) === cableFisico - 1;
              const matchCable =
                s.cable !== undefined && parseInt(s.cable) === cableFisico;

              return matchNodo && (matchPin || matchCable);
            });

            if (sensorConfig) {
              let alertaCritica = false;
              const valorFlujo = parseFloat(sensorRaw.valor);
              const isSemilla = sensorConfig.tipo === "semilla";
              const isFerti = sensorConfig.tipo.includes("ferti");

              // ==========================================
              // CÁLCULO DE SEMILLAS POR METRO
              // ==========================================
              let semillasPorMetro = 0;
              const rawPulsos = parseInt(sensorRaw.raw) || 0;

              if (telemetriaAOG.velocidad > 0.5) {
                const velMs = telemetriaAOG.velocidad / 3.6;
                semillasPorMetro = valorFlujo / velMs;
              }

              // --- LÓGICA INTELIGENTE DE ALERTAS ---
              if (isSemilla || isFerti) {
                const numTren = sensorConfig.tren || 1;
                const seccionesTren =
                  numTren === 1
                    ? telemetriaAOG.seccionesT1
                    : telemetriaAOG.seccionesT2;
                const maquinaSembrando =
                  seccionesTren.length > 0 ? seccionesTren.includes(1) : true;

                if (telemetriaAOG.velocidad > 1.5 && maquinaSembrando) {
                  if (valorFlujo === 0) alertaCritica = true;
                  else {
                    const objetivo = configFresca.setup?.densidad_objetivo || 0;
                    if (objetivo > 0 && valorFlujo < objetivo * 0.5)
                      alertaCritica = true;
                  }
                }
              } else if (
                sensorConfig.tipo === "rotacion_eje" ||
                sensorConfig.tipo === "turbina"
              ) {
                if (telemetriaAOG.velocidad > 1.5 && valorFlujo === 0)
                  alertaCritica = true;
              }

              // --- RASTREADOR DEFINITIVO ---
              if (rawPulsos > 0) {
                console.log(
                  `🎯 [EMITIENDO A PANTALLA] Surco: ${sensorConfig.bajada} | Flujo: ${valorFlujo.toFixed(1)}`,
                );
              }

              // Emitimos al Frontend para que dibuje la pastilla
              io.emit("sensor_update", {
                bajada: sensorConfig.bajada,
                tipo: sensorConfig.tipo,
                valor: valorFlujo.toFixed(1),
                alerta: alertaCritica,
                nuevas_semillas: rawPulsos,
                spm: semillasPorMetro.toFixed(1),
              });
            }
          });
        }
      }
    } catch (e) {
      console.error("🚨 ERROR FATAL procesando MQTT:", e);
    }
  });

  return { client };
}

module.exports = initMQTT;
