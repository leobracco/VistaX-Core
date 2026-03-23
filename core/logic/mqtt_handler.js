// ============================================================
// VistaX — core/logic/mqtt_handler.js
// ============================================================

const mqtt         = require("mqtt");
const mapRecorder  = require("./map_recorder");
const seedRecorder = require("./seed_recorder");

function initMQTT(io, getConfig) {
  const client = mqtt.connect("mqtt://127.0.0.1");

  let telemetriaAOG = {
    velocidad:   0,
    seccionesT1: [],
    seccionesT2: [],
  };

  // ==========================================
  // CONEXIÓN Y SUSCRIPCIONES
  // ==========================================
  client.on("connect", () => {
    console.log("\x1b[36m[MQTT]\x1b[0m VistaX: Conectado al Broker MQTT local");

    client.subscribe("vistax/nodos/telemetria");  // batch legacy (modo densidad)
    client.subscribe("vistax/nodos/pulso");        // NUEVO: un mensaje por semilla
    client.subscribe("vistax/sync/time");          // NUEVO: sincronización de tiempo
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/machine/position");
    client.subscribe("sections/state");
    client.subscribe("vistax/nodos/registro");
  });

  // ==========================================
  // MENSAJES ENTRANTES
  // ==========================================
  client.on("message", (topic, message) => {
    try {
      const msgStr = message.toString();

      if (topic.includes("registro")) {
        console.log(`\n📡 [RADAR MQTT] Tópico: ${topic}`);
        console.log(`📦 [RADAR MQTT] Payload: ${msgStr}\n`);
      }

      // ------------------------------------------
      // 1. VELOCIDAD (texto plano desde el Bridge)
      // ------------------------------------------
      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(msgStr) || 0;
        io.emit("global_update", { velocidad: telemetriaAOG.velocidad });
        return;
      }

      // ------------------------------------------
      // PARSEO JSON SEGURO (todos los demás topics)
      // ------------------------------------------
      let payload;
      try {
        payload = JSON.parse(msgStr);
      } catch (parseErr) {
        console.error(`❌ Error parseando JSON en tópico ${topic}:`, msgStr);
        return;
      }

      const configFresca = getConfig();

      // ------------------------------------------
      // 2. SINCRONIZACIÓN DE TIEMPO ESP32 ↔ GPS
      //    El bridge publica cada 1s en vistax/sync/time
      //    Payload: { gps_ts: <unix ms>, lat, lon }
      // ------------------------------------------
      if (topic === "vistax/sync/time") {
        seedRecorder.registrarSyncTime(payload);
        return;
      }

      // ------------------------------------------
      // 3. POSICIÓN GPS (viene del Bridge como JSON)
      //    Alimenta AMBOS recorders: mapa y semillas
      // ------------------------------------------
      if (topic === "aog/machine/position") {
        // Alimentar el interpolador del seed_recorder
        seedRecorder.registrarPosicionGPS(
          payload.lat,
          payload.lon,
          payload.heading,
          payload.gps_ts || Date.now(),
        );

        // Alimentar el map_recorder (mapa de densidad por pasada)
        const punto = mapRecorder.actualizarGPS(
          payload.lat,
          payload.lon,
          payload.heading,
          telemetriaAOG.velocidad,
        );

        if (punto) {
          io.emit("map_point", punto);

          const loteInfo = mapRecorder.getLoteActivo();
          if (loteInfo && loteInfo.puntosGrabados % 10 === 0) {
            io.emit("map_stats", loteInfo.estadisticasLive);
          }
        }
        return;
      }

      // ------------------------------------------
      // 4. ESTADO DE CORTES DE SECCIÓN (del Bridge)
      // ------------------------------------------
      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        return;
      }

      // ------------------------------------------
      // 5. REGISTRO DE NUEVOS NODOS (Plug & Play)
      // ------------------------------------------
      if (topic === "vistax/nodos/registro") {
        console.log("--> [DEBUG] Entró al bloque de registro MQTT");
        let nodoExiste = false;

        if (configFresca?.mapeo_sensores && Array.isArray(configFresca.mapeo_sensores)) {
          nodoExiste = configFresca.mapeo_sensores.some(s => s.uid === payload.uid);
          console.log(`--> [DEBUG] ¿Nodo ya registrado?: ${nodoExiste ? "SÍ" : "NO"}`);
        } else {
          console.log("--> [DEBUG] Máquina sin mapeo_sensores previo (es nueva)");
        }

        if (!nodoExiste) {
          console.log(`\x1b[32m[VistaX]\x1b[0m Nuevo nodo: ${payload.uid} (FW: ${payload.firmware})`);
          io.emit("new_node_detected", payload);
        } else {
          console.log(`\x1b[33m[VistaX]\x1b[0m Nodo ${payload.uid} ya registrado. Ignorado.`);
        }
        return;
      }

      // ------------------------------------------
      // 6. PULSO INDIVIDUAL DE SEMILLA (NUEVO)
      //    Payload: { uid, surco, t_ms }
      //    Un mensaje por semilla detectada por la ISR
      // ------------------------------------------
      if (topic === "vistax/nodos/pulso") {
        const { uid, surco, t_ms } = payload;
        if (!uid || surco === undefined) return;

        // Verificar que este surco es de tipo semilla en la config
        const sensorConfig = configFresca?.mapeo_sensores?.find(
          s => s.uid === uid && s.bajada === parseInt(surco) && s.tipo === "semilla"
        );
        if (!sensorConfig) return;

        // No georeferir si la sección está cortada (cabecera)
        const numTren = sensorConfig.tren || 1;
        const seccionesTren = numTren === 1 ? telemetriaAOG.seccionesT1 : telemetriaAOG.seccionesT2;
        const maquinaSembrando = seccionesTren.length > 0 ? seccionesTren.includes(1) : true;
        if (!maquinaSembrando) return;

        const semilla = seedRecorder.registrarPulso(uid, surco, t_ms || Date.now());

        if (semilla) {
          // Log cada 100 semillas para no saturar la consola
          const stats = seedRecorder.getEstadisticas();
          if (stats && stats.totalSemillas % 100 === 0) {
            console.log(`\x1b[32m[SeedRecorder]\x1b[0m ${stats.totalSemillas} semillas georeferenciadas`);
          }
        }
        return;
      }

      // ------------------------------------------
      // 7. TELEMETRÍA BATCH (modo densidad, legacy)
      //    Intacto — alimenta el monitor de pastillas
      // ------------------------------------------
      if (topic === "vistax/nodos/telemetria") {
        const uidNodo = payload.uid;

        if (payload.sensores && configFresca?.mapeo_sensores) {
          payload.sensores.forEach((sensorRaw) => {
            const cableFisico  = parseInt(sensorRaw.cable);
            const sensorConfig = configFresca.mapeo_sensores.find((s) => {
              const matchNodo  = s.uid === uidNodo;
              const matchPin   = s.pin   !== undefined && parseInt(s.pin)   === cableFisico - 1;
              const matchCable = s.cable !== undefined && parseInt(s.cable) === cableFisico;
              return matchNodo && (matchPin || matchCable);
            });

            if (!sensorConfig) return;

            let alertaCritica   = false;
            const valorFlujo    = parseFloat(sensorRaw.valor);
            const rawPulsos     = parseInt(sensorRaw.raw) || 0;
            const isSemilla     = sensorConfig.tipo === "semilla";
            const isFerti       = sensorConfig.tipo.includes("ferti");

            let semillasPorMetro = 0;
            if (telemetriaAOG.velocidad > 0.5) {
              const velMs      = telemetriaAOG.velocidad / 3.6;
              semillasPorMetro = valorFlujo / velMs;
            }

            if (isSemilla || isFerti) {
              const numTren       = sensorConfig.tren || 1;
              const seccionesTren = numTren === 1 ? telemetriaAOG.seccionesT1 : telemetriaAOG.seccionesT2;
              const maquinaSembrando = seccionesTren.length > 0 ? seccionesTren.includes(1) : true;

              if (telemetriaAOG.velocidad > 1.5 && maquinaSembrando) {
                if (valorFlujo === 0) {
                  alertaCritica = true;
                } else {
                  const objetivo = configFresca.setup?.densidad_objetivo || 0;
                  if (objetivo > 0 && valorFlujo < objetivo * 0.5) alertaCritica = true;
                }
              }
            } else if (sensorConfig.tipo === "rotacion_eje" || sensorConfig.tipo === "turbina") {
              if (telemetriaAOG.velocidad > 1.5 && valorFlujo === 0) alertaCritica = true;
            }

            if (rawPulsos > 0) {
              console.log(`🎯 Surco: ${sensorConfig.bajada} | Flujo: ${valorFlujo.toFixed(1)}`);
            }

            mapRecorder.actualizarSensor(sensorConfig.bajada, semillasPorMetro.toFixed(1), alertaCritica);

            io.emit("sensor_update", {
              bajada:          sensorConfig.bajada,
              tipo:            sensorConfig.tipo,
              valor:           valorFlujo.toFixed(1),
              alerta:          alertaCritica,
              nuevas_semillas: rawPulsos,
              spm:             semillasPorMetro.toFixed(1),
            });
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
