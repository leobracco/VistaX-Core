const mqtt     = require("mqtt");
const recorder = require("./map_recorder"); // ← NUEVO

function initMQTT(io, getConfig) {
  const client = mqtt.connect("mqtt://127.0.0.1");

  let telemetriaAOG = { velocidad: 0, seccionesT1: [], seccionesT2: [] };
  const estadoNodos = {};

  client.on("connect", () => {
    console.log("\x1b[36m[MQTT]\x1b[0m VistaX: Conectado al Broker MQTT local");
    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/pulsos");
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/machine/position");   // ← NUEVO: GPS del bridge
    client.subscribe("sections/state");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("vistax/nodos/estado");
    client.subscribe("aog/field/name");    // nombre del campo AOG → auto-iniciar lote
    client.subscribe("aog/field/status");  // estado pintado AOG → auto-cerrar lote
  });

  client.on("message", (topic, message) => {
    try {
      const msgStr = message.toString();

      // ── Velocidad ────────────────────────────────────────────
      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(msgStr) || 0;
        io.emit("global_update", { velocidad: telemetriaAOG.velocidad });
        return;
      }

      // ── Campo AOG: nombre (llega como texto plano, no JSON) ─────
      if (topic === "aog/field/name") {
        const nombre = msgStr.trim();
        if (!nombre) return;

        const loteActual = recorder.getLoteActivo();

        // Si ya hay un lote con ese nombre, no hacer nada
        if (loteActual && loteActual.nombre === nombre) {
          console.log(`\x1b[90m[DEBUG]\x1b[0m Campo AOG "${nombre}" ya tiene lote activo — ignorado`);
          return;
        }

        // Si hay un lote distinto abierto, cerrarlo primero
        if (loteActual) {
          const resultado = recorder.cerrarLote();
          if (resultado) {
            io.emit("lote_update", { activo: false });
            console.log(`\x1b[33m[MapRecorder]\x1b[0m Lote anterior cerrado: ${loteActual.nombre}`);
          }
        }

        // Iniciar el nuevo lote con el nombre del campo de AOG
        const loteNuevo = recorder.iniciarLote(nombre, "Sin definir");
        io.emit("lote_update", {
          activo:  true,
          id:      loteNuevo.id,
          nombre:  loteNuevo.nombre,
          cultivo: loteNuevo.cultivo,
        });
        console.log(`\x1b[32m[MapRecorder]\x1b[0m Lote auto-iniciado desde AOG: "${nombre}"`);
        console.log(`\x1b[32m[DEBUG]\x1b[0m ✅ LOTE INICIADO → id: ${loteNuevo.id} | nombre: "${loteNuevo.nombre}"`);
        return;
      }

      let payload;
      try { payload = JSON.parse(msgStr); }
      catch { console.error(`❌ Error parseando JSON en tópico ${topic}`); return; }

      const configFresca = getConfig();

      // ── Posición GPS ─────────────────────────────────────────
      if (topic === "aog/machine/position") {
        const lat     = payload.lat     || payload.latitude  || 0;
        const lon     = payload.lon     || payload.longitude || 0;
        const heading = payload.heading || payload.hdg       || 0;
        const speed   = payload.speed   || payload.vel       || telemetriaAOG.velocidad || 0;

        if (!lat || !lon) return;

        // Grabar punto en el backend
        const punto = recorder.actualizarGPS(lat, lon, heading, speed);

        if (punto) {
          io.emit("map_point", punto);
          const lote = recorder.getLoteActivo();
          if (lote) {
            // Log cada 10 puntos para no saturar la consola
            if (lote.puntosGrabados % 10 === 0) {
              console.log(`\x1b[36m[DEBUG]\x1b[0m 📍 Grabando punto #${lote.puntosGrabados} | lat:${lat.toFixed(6)} lon:${lon.toFixed(6)} | spmProm:${punto.spmPromedio}`);
              io.emit("map_stats", lote.estadisticasLive);
            }
          }
        } else {
          // Solo loguear cada 50 descartes para no saturar
          if (!_descartesGPS) _descartesGPS = 0;
          _descartesGPS++;
          if (_descartesGPS % 50 === 1) {
            const lote = recorder.getLoteActivo();
            if (!lote) {
              console.log(`\x1b[33m[DEBUG]\x1b[0m ⚠ GPS descartado — SIN LOTE ACTIVO (lat:${lat} lon:${lon})`);
            } else {
              console.log(`\x1b[90m[DEBUG]\x1b[0m GPS descartado — distancia mínima no alcanzada`);
            }
          }
        }
        return;
      }

      // ── Estado de secciones ───────────────────────────────────
      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        return;
      }

      // ── Campo AOG: status (heartbeat cada 3s) → iniciar o cerrar lote ─
      if (topic === "aog/field/status") {
        // payload: { painting, fieldName, ts }
        const nombre     = payload.fieldName || "";
        const loteActual = recorder.getLoteActivo();

        // ── Auto-inicio: si hay nombre de campo y no hay lote activo ──
        if (nombre && !loteActual) {
          const loteNuevo = recorder.iniciarLote(nombre, "Sin definir");
          io.emit("lote_update", {
            activo:  true,
            id:      loteNuevo.id,
            nombre:  loteNuevo.nombre,
            cultivo: loteNuevo.cultivo,
          });
          console.log(`\x1b[32m[MapRecorder]\x1b[0m Lote auto-iniciado desde field/status: "${nombre}"`);
          console.log(`\x1b[32m[DEBUG]\x1b[0m ✅ LOTE INICIADO → id: ${loteNuevo.id}`);
          return;
        }

        // ── Auto-inicio: campo cambió ──
        if (nombre && loteActual && loteActual.nombre !== nombre) {
          const anterior = recorder.cerrarLote();
          if (anterior) io.emit("lote_update", { activo: false });
          const loteNuevo = recorder.iniciarLote(nombre, "Sin definir");
          io.emit("lote_update", { activo: true, id: loteNuevo.id, nombre: loteNuevo.nombre, cultivo: loteNuevo.cultivo });
          console.log(`\x1b[32m[DEBUG]\x1b[0m ✅ LOTE CAMBIADO → "${nombre}"`);
          return;
        }

        if (!loteActual) return;

        // Si AOG dejó de pintar Y hay suficientes puntos grabados → cerrar
        if (!payload.painting && loteActual.puntosGrabados > 10) {
          // Esperar 30s antes de cerrar (puede ser una cabecera)
          if (!_cierreTimeout) {
            _cierreTimeout = setTimeout(() => {
              _cierreTimeout = null;
              const loteVigente = recorder.getLoteActivo();
              if (!loteVigente || loteVigente.puntosGrabados <= 10) return;
              const resultado = recorder.cerrarLote();
              if (resultado) {
                io.emit("lote_update", { activo: false });
                console.log(`\x1b[33m[MapRecorder]\x1b[0m Lote auto-cerrado (AOG paró): "${loteVigente.nombre}"`);
              console.log(`\x1b[33m[DEBUG]\x1b[0m ✅ LOTE CERRADO → ${loteVigente.puntosGrabados} puntos grabados`);
              }
            }, 30000);
          }
        } else if (payload.painting && _cierreTimeout) {
          // Si volvió a pintar, cancelar el cierre
          clearTimeout(_cierreTimeout);
          _cierreTimeout = null;
        }
        return;
      }

      // ── Estado del nodo (heartbeat / ACK) ────────────────────
      if (topic === "vistax/nodos/estado") {
        const uid = payload.uid;
        if (!uid) return;
        estadoNodos[uid] = {
          uid,
          version:  payload.version  || estadoNodos[uid]?.version  || "?",
          ip:       payload.ip       || estadoNodos[uid]?.ip       || "?",
          rssi:     payload.rssi     ?? estadoNodos[uid]?.rssi     ?? null,
          uptime_s: payload.uptime_s ?? estadoNodos[uid]?.uptime_s ?? 0,
          heap:     payload.heap     || estadoNodos[uid]?.heap     || 0,
          lastSeen: Date.now(),
          online:   true,
          msg:      payload.msg || null,
        };
        io.emit("nodo_estado", estadoNodos[uid]);
        console.log(`\x1b[36m[Nodo]\x1b[0m ${uid} | v${estadoNodos[uid].version} | IP: ${estadoNodos[uid].ip} | RSSI: ${estadoNodos[uid].rssi} dBm`);
        return;
      }

      // ── Registro de nodo nuevo ────────────────────────────────
      if (topic === "vistax/nodos/registro") {
        console.log(`\n📡 [RADAR MQTT] ${topic}\n📦 ${msgStr}\n`);
        let existe = false;
        if (configFresca?.mapeo_sensores) {
          existe = configFresca.mapeo_sensores.some(s => s.uid === payload.uid);
        }
        if (!existe) {
          console.log(`\x1b[32m[VistaX]\x1b[0m Nuevo nodo: ${payload.uid} (FW: ${payload.firmware})`);
          io.emit("new_node_detected", payload);
        } else {
          console.log(`\x1b[33m[VistaX]\x1b[0m Nodo ${payload.uid} ya registrado.`);
        }
        return;
      }

      // ── Telemetría / pulsos de sensores ───────────────────────
      if (
        (topic === "vistax/nodos/telemetria" || topic === "vistax/nodos/pulsos") &&
        configFresca?.mapeo_sensores
      ) {
        const sensores = payload.sensores || [];

        sensores.forEach((sensor) => {
          const cfg = configFresca.mapeo_sensores.find(
            s => s.uid === payload.uid && s.cable === sensor.cable
          );
          if (!cfg) return;

          const rawPulsos  = sensor.raw   || 0;
          const valorFlujo = parseFloat(sensor.valor) || 0;
          let alerta = false;

          const secTren   = cfg.tren === 2 ? telemetriaAOG.seccionesT2 : telemetriaAOG.seccionesT1;
          const sembrando = secTren.length > 0 ? secTren.includes(1) : true;

          // Calcular semillas/metro para el mapa
          const semillasPorMetro = telemetriaAOG.velocidad > 0
            ? parseFloat((valorFlujo / telemetriaAOG.velocidad).toFixed(1))
            : 0;

          if (cfg.tipo === "semilla" || cfg.tipo === "ferti_linea") {
            if (telemetriaAOG.velocidad > 1.5 && sembrando) {
              if (valorFlujo === 0) alerta = true;
              else {
                const obj = configFresca.setup?.densidad_objetivo || 0;
                if (obj > 0 && valorFlujo < obj * 0.5) alerta = true;
              }
            }
          } else if (cfg.tipo === "rotacion_eje" || cfg.tipo === "turbina") {
            if (telemetriaAOG.velocidad > 1.5 && valorFlujo === 0) alerta = true;
          }

          if (rawPulsos > 0)
            console.log(`🎯 Surco: ${cfg.bajada} | Flujo: ${valorFlujo.toFixed(1)} | spm: ${semillasPorMetro}`);

          // ── Actualizar mapa en el backend ─────────────────────
          recorder.actualizarSensor(cfg.bajada, semillasPorMetro, alerta);

          // ── Emitir al monitor (pastillas) ─────────────────────
          io.emit("sensor_update", {
            bajada:          cfg.bajada,
            tipo:            cfg.tipo,
            valor:           valorFlujo.toFixed(1),
            alerta,
            nuevas_semillas: rawPulsos,
            spm:             semillasPorMetro.toFixed(1),
          });
        });
      }

    } catch (e) {
      console.error("🚨 ERROR FATAL procesando MQTT:", e);
    }
  });

  // ── Timeout para auto-cierre de lote ────────────────────────
  let _cierreTimeout  = null;
  let _descartesGPS   = 0;

  // ── publish() — rutas Express pueden enviar comandos MQTT ────
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

  // ── getEstadoNodos() — para el panel OTA ────────────────────
  function getEstadoNodos() {
    const now = Date.now();
    Object.values(estadoNodos).forEach(n => {
      n.online = now - n.lastSeen < 60000;
    });
    return estadoNodos;
  }

  return { client, publish, getEstadoNodos };
}

module.exports = initMQTT;
