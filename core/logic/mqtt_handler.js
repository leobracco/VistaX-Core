const mqtt = require("mqtt");

function initMQTT(io, getConfig) {
  const client = mqtt.connect("mqtt://127.0.0.1");

  let telemetriaAOG = { velocidad: 0, seccionesT1: [], seccionesT2: [] };
  const estadoNodos = {}; // { "VX-XXXX": { ip, rssi, uptime_s, version, heap, lastSeen, online } }
  client.on("connect", () => {
    console.log("\x1b[36m[MQTT]\x1b[0m VistaX: Conectado al Broker MQTT local");
    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/pulsos");
    client.subscribe("aog/machine/speed");
    client.subscribe("sections/state");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("vistax/nodos/estado");
  });

  client.on("message", (topic, message) => {
    try {
      const msgStr = message.toString();

      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(msgStr) || 0;
        io.emit("global_update", { velocidad: telemetriaAOG.velocidad });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(msgStr);
      } catch {
        console.error(`❌ Error parseando JSON en tópico ${topic}`);
        return;
      }

      const configFresca = getConfig();

      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        return;
      }
      if (topic === "vistax/nodos/estado") {
        const uid = payload.uid;
        if (!uid) return;

        // Actualizar estado en memoria
        estadoNodos[uid] = {
          uid,
          version: payload.version || estadoNodos[uid]?.version || "?",
          ip: payload.ip || estadoNodos[uid]?.ip || "?",
          rssi: payload.rssi ?? estadoNodos[uid]?.rssi ?? null,
          uptime_s: payload.uptime_s ?? estadoNodos[uid]?.uptime_s ?? 0,
          heap: payload.heap || estadoNodos[uid]?.heap || 0,
          lastSeen: Date.now(),
          online: true,
          msg: payload.msg || null, // ack de comandos
        };

        // Marcar offline si no hay heartbeat en 60s (check periódico)
        io.emit("nodo_estado", estadoNodos[uid]);
        console.log(
          `\x1b[36m[Nodo]\x1b[0m ${uid} | v${estadoNodos[uid].version} | IP: ${estadoNodos[uid].ip} | RSSI: ${estadoNodos[uid].rssi} dBm`,
        );
        return;
      }
      if (topic === "vistax/nodos/registro") {
        console.log(`\n📡 [RADAR MQTT] ${topic}\n📦 ${msgStr}\n`);
        let existe = false;
        if (configFresca?.mapeo_sensores) {
          existe = configFresca.mapeo_sensores.some(
            (s) => s.uid === payload.uid,
          );
        }
        if (!existe) {
          console.log(
            `\x1b[32m[VistaX]\x1b[0m Nuevo nodo: ${payload.uid} (FW: ${payload.firmware})`,
          );
          io.emit("new_node_detected", payload);
        } else {
          console.log(
            `\x1b[33m[VistaX]\x1b[0m Nodo ${payload.uid} ya registrado.`,
          );
        }
        return;
      }

      if (
        (topic === "vistax/nodos/telemetria" ||
          topic === "vistax/nodos/pulsos") &&
        configFresca?.mapeo_sensores
      ) {
        const sensores = payload.sensores || [];
        sensores.forEach((sensor) => {
          const cfg = configFresca.mapeo_sensores.find(
            (s) => s.uid === payload.uid && s.cable === sensor.cable,
          );
          if (!cfg) return;

          const rawPulsos = sensor.raw || 0;
          const valorFlujo = parseFloat(sensor.valor) || 0;
          let alerta = false;

          const secTren =
            cfg.tren === 2
              ? telemetriaAOG.seccionesT2
              : telemetriaAOG.seccionesT1;
          const sembrando = secTren.length > 0 ? secTren.includes(1) : true;

          if (cfg.tipo === "semilla" || cfg.tipo === "ferti_linea") {
            if (telemetriaAOG.velocidad > 1.5 && sembrando) {
              if (valorFlujo === 0) alerta = true;
              else {
                const obj = configFresca.setup?.densidad_objetivo || 0;
                if (obj > 0 && valorFlujo < obj * 0.5) alerta = true;
              }
            }
          } else if (cfg.tipo === "rotacion_eje" || cfg.tipo === "turbina") {
            if (telemetriaAOG.velocidad > 1.5 && valorFlujo === 0)
              alerta = true;
          }

          if (rawPulsos > 0)
            console.log(
              `🎯 Surco: ${cfg.bajada} | Flujo: ${valorFlujo.toFixed(1)} | Pulsos: ${rawPulsos}`,
            );

          io.emit("sensor_update", {
            bajada: cfg.bajada,
            tipo: cfg.tipo,
            valor: valorFlujo.toFixed(1),
            alerta,
            nuevas_semillas: rawPulsos,
            spm: "0.0",
          });
        });
      }
    } catch (e) {
      console.error("🚨 ERROR FATAL procesando MQTT:", e);
    }
  });

  // ══════════════════════════════════════════════════════════
  //  publish() — permite que las rutas Express publiquen
  //  comandos MQTT (OTA, reset, etc.) sin otro cliente MQTT
  // ══════════════════════════════════════════════════════════
  function publish(topic, payload) {
    if (!client.connected) {
      console.warn("[MQTT] No conectado — no se puede publicar en:", topic);
      return false;
    }
    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
    client.publish(topic, msg);
    console.log(`\x1b[36m[MQTT]\x1b[0m ► ${topic}`, msg);
    return true;
  }
  function getEstadoNodos() {
    // Marcar offline los que no enviaron heartbeat en 60s
    const now = Date.now();
    Object.values(estadoNodos).forEach((n) => {
      n.online = now - n.lastSeen < 60000;
    });
    return estadoNodos;
  }
  return { client, publish, getEstadoNodos };
}

module.exports = initMQTT;
