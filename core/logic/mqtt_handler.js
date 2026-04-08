// ============================================================
// VistaX — mqtt_handler.js  v6
//
// CAMBIOS v6:
//   1. Lee el perfil ACTIVO (no el primero alfabético) usando profilesManager
//   2. Exporta publish() y getEstadoNodos() correctamente
//   3. publish() acepta opciones (retain, qos)
//   4. Tracking de estado de nodos (heartbeat para panel OTA)
//   5. Republicación de config de cables a nodos al arrancar y al cambiar perfil
//   6. Bajada de herramienta con debounce robusto (de v5)
// ============================================================

const profilesManager = require("../database/profiles_manager");
const nodosInventory  = require("../database/nodos_inventory");
const { publicarConfigCables } = require("./cable_config_publisher");
function initMQTT(io) {
  const mqtt = require("mqtt");

  const client = mqtt.connect("mqtt://192.168.1.11");

  let configFresca = null;
  let telemetriaAOG = {
    velocidad: 0,
    seccionesT1: [],
    seccionesT2: [],
  };
  let loteActual = null;
  let seedRecorder = null;
  let mapRecorder = null;
  let _secDebugCount = 0;

  // ── Estado de nodos (para panel OTA / health check) ──
  const estadoNodos = {};

  // ── Estado de bajada de herramienta (debounce + dedupe) ──
  const estadoHerramienta = new Map();
  const DEBOUNCE_HERRAMIENTA_MS = 150;
  const TOPIC_AOG_CMD = "vistax/corex/aog/cmd";

  // ── Cargar config del perfil ACTIVO ──
  function recargarConfig() {
    try {
      const nombreActivo = profilesManager.getLastProfileName();
      const perfil = profilesManager.getActiveProfile(nombreActivo);
      if (perfil) {
        configFresca = perfil;
      }
    } catch (e) {
      console.error("Error cargando config:", e);
    }
  }

  recargarConfig();
  setInterval(recargarConfig, 5000);

  /**
   * Obtiene el objetivo de densidad para un tren específico.
   */
  function _objetivoTren(numTren) {
    const porTren = configFresca?.setup?.objetivos_tren;
    if (porTren && porTren[numTren] !== undefined) {
      return parseFloat(porTren[numTren]);
    }
    return parseFloat(configFresca?.setup?.densidad_objetivo) || 16;
  }

  client.on("connect", () => {
    console.log("\x1b[32m[VistaX MQTT]\x1b[0m Conectado al broker");
    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("vistax/nodos/estado");
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/field/status");
    client.subscribe("sections/state");
    client.subscribe("vistax/control/lote");
    client.subscribe("vistax/debug/#");

    // ── Republicar config de cables al perfil activo (con delay para que el broker quede listo) ──
    setTimeout(() => {
      if (configFresca) {
        publicarConfigCables({ publish }, configFresca);
        console.log("\x1b[32m[VistaX]\x1b[0m Config de cables republicada al arranque");
      }
    }, 1500);
  });

  // ═══ Funciones centralizadas de lote ═══
  function _iniciarLote(data) {
    loteActual = {
      id: data.id || `lote_${Date.now()}`,
      nombre: data.nombre || "Sin nombre",
      cultivo: data.cultivo || "",
      variedad: data.variedad || "",
      establecimiento: data.establecimiento || "",
      inicio: new Date().toISOString(),
      activo: true,
    };
    console.log(`\x1b[32m[VistaX]\x1b[0m Lote iniciado: ${loteActual.nombre}`);

    try {
      const SeedRecorder = require("./seed_recorder");
      seedRecorder = new SeedRecorder(loteActual.id);
      const MapRecorder = require("./map_recorder");
      mapRecorder = new MapRecorder(loteActual.id);
    } catch (e) {
      console.log("Recorders no disponibles:", e.message);
    }

    io.emit("lote_update", loteActual);
  }

  function _cerrarLote() {
    if (!loteActual) return;
    console.log(`\x1b[33m[VistaX]\x1b[0m Lote cerrado: ${loteActual.nombre}`);
    loteActual.activo = false;
    loteActual.fin = new Date().toISOString();
    io.emit("lote_update", { activo: false });

    if (seedRecorder) { seedRecorder.close(); seedRecorder = null; }
    if (mapRecorder)  { mapRecorder.close();  mapRecorder  = null; }
    loteActual = null;
  }

  // Exponer para rutas
  client.cerrarLoteDesdeRuta  = _cerrarLote;
  client.iniciarLoteDesdeRuta = _iniciarLote;
  client.getLoteActual        = () => loteActual;

  // ═══ Global stats ═══
  let statsBuffer = {};
  let statsTimer  = null;

  function _emitirGlobalStats() {
    if (!configFresca?.mapeo_sensores) return;

    const sensoresSemilla = configFresca.mapeo_sensores.filter(
      s => s.tipo === "semilla" && s.is_active !== false
    );

    let sumaFlujo = 0;
    let count = 0;
    sensoresSemilla.forEach(s => {
      const key = `${s.uid}-${s.cable || s.pin}`;
      if (statsBuffer[key] !== undefined) {
        sumaFlujo += statsBuffer[key];
        count++;
      }
    });

    const promedio = count > 0 ? sumaFlujo / count : 0;
    io.emit("global_update", {
      velocidad: telemetriaAOG.velocidad,
      promedio:  promedio.toFixed(1),
    });
  }

  if (!statsTimer) {
    statsTimer = setInterval(_emitirGlobalStats, 1000);
  }

  // ═══ HANDLER PRINCIPAL DE MENSAJES ═══
  client.on("message", (topic, message) => {
    try {
      // ── Debug genérico ──
      if (topic.startsWith("vistax/debug/")) {
        const uid = topic.replace("vistax/debug/", "");
        io.emit("debug_msg", { uid, msg: message.toString(), ts: Date.now() });
        return;
      }

      const payload = JSON.parse(message.toString());

      // ═══ VELOCIDAD ═══
      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(payload) || 0;
        return;
      }

      // ═══ SECCIONES ═══
      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        io.emit("sections_update", {
          t1: telemetriaAOG.seccionesT1,
          t2: telemetriaAOG.seccionesT2,
        });
        return;
      }

      // ═══ CONTROL LOTE (desde CoreX) ═══
      if (topic === "vistax/control/lote") {
        if (payload.accion === "iniciar") _iniciarLote(payload);
        else if (payload.accion === "cerrar") _cerrarLote();
        return;
      }

      // ═══ AOG FIELD STATUS ═══
      if (topic === "aog/field/status") {
        if (payload.status === "field_open" && !loteActual) {
          _iniciarLote({ nombre: payload.field_name || "AOG Field", cultivo: "auto" });
        } else if (payload.status === "field_close" && loteActual) {
          _cerrarLote();
        }
        return;
      }

      // ═══ ESTADO NODO (heartbeat) ═══
      if (topic === "vistax/nodos/estado") {
  const uid = payload.uid;
  if (!uid) return;

  // Si está ignorado, no actualizar (no queremos que aparezca en stats)
  if (nodosInventory.estaIgnorado(uid)) return;

  // Actualizar inventario central
  nodosInventory.upsertFromHeartbeat(payload);

  // Mantener compatibilidad con el legacy estadoNodos para getEstadoNodos()
  estadoNodos[uid] = {
    uid,
    version:  payload.version  || estadoNodos[uid]?.version  || "?",
    ip:       payload.ip       || estadoNodos[uid]?.ip       || "?",
    rssi:     payload.rssi     ?? estadoNodos[uid]?.rssi     ?? null,
    uptime_s: payload.uptime_s ?? estadoNodos[uid]?.uptime_s ?? 0,
    heap:     payload.heap     || estadoNodos[uid]?.heap     || 0,
    lastSeen: Date.now(),
    online:   true,
  };
  io.emit("nodo_estado", estadoNodos[uid]);
  io.emit("nodos_inventario_changed");
  return;
}

      // ═══ REGISTRO NODOS ═══
      if (topic === "vistax/nodos/registro") {
  const uid = payload.uid;
  if (!uid) return;

  // Si está ignorado, no notificar ni configurar
  if (nodosInventory.estaIgnorado(uid)) {
    console.log(`\x1b[90m[VistaX]\x1b[0m Nodo ignorado se registró: ${uid}`);
    return;
  }

  // Upsert al inventario y detectar si es realmente nuevo
  const { esNuevo } = nodosInventory.upsertFromHeartbeat(payload);

  // Solo emitir toast si es la primera vez que se ve este UID
  if (esNuevo) {
    console.log(`\x1b[32m[VistaX]\x1b[0m 🆕 Nodo nuevo detectado: ${uid} (FW: ${payload.firmware || '?'})`);
    io.emit("new_node_detected", payload);
  } else {
    console.log(`\x1b[90m[VistaX]\x1b[0m Nodo conocido reconectado: ${uid}`);
  }

  io.emit("nodos_inventario_changed");

  // Republicar config de cables al nodo (siempre, cubre el caso de reinicio)
  if (configFresca) {
    setTimeout(() => publicarConfigCables({ publish }, configFresca), 500);
  }
  return;
}

      // ═══ TELEMETRÍA DE SENSORES ═══
      if (topic === "vistax/nodos/telemetria") {
        const uidNodo = payload.uid;
        if (!payload.sensores || !configFresca?.mapeo_sensores) return;

        payload.sensores.forEach(sensorRaw => {
          const cableFisico = parseInt(sensorRaw.cable);
          const sensorConfig = configFresca.mapeo_sensores.find(s => {
            const matchNodo  = s.uid === uidNodo;
            const matchPin   = s.pin   !== undefined && parseInt(s.pin)   === cableFisico - 1;
            const matchCable = s.cable !== undefined && parseInt(s.cable) === cableFisico;
            return matchNodo && (matchPin || matchCable);
          });

          if (!sensorConfig) return;
          if (sensorConfig.is_active === false) return;

          // ╔══════════════════════════════════════════════════════╗
          // ║  BAJADA DE HERRAMIENTA → cortocircuito hacia AOG     ║
          // ╚══════════════════════════════════════════════════════╝
          if (sensorConfig.tipo === "bajada_herramienta") {
            handleBajadaHerramienta(sensorConfig, sensorRaw, client, io);
            return;
          }

          // ── (Futuro) otros tipos STATE ──
          // tolva_vacia, tolva_llena, presion, final_carrera...
          // si querés que solo se reflejen en UI sin lógica especial, dejá
          // que caigan en el flujo normal de abajo (van a aparecer como sensor_update).

          // ── Procesamiento normal (semilla / ferti / turbina / tolva) ──
          let alertaCritica = false;
          const valorFlujo  = parseFloat(sensorRaw.valor);
          const isSemilla   = sensorConfig.tipo === "semilla";
          const isFerti     = sensorConfig.tipo.includes("ferti");
          const rawPulsos   = parseInt(sensorRaw.raw) || 0;
          const numTren     = sensorConfig.tren || 1;

          // ═══ DENSIDAD INDIVIDUAL ═══
          let semillasPorMetro = 0;
          if (telemetriaAOG.velocidad > 0.5) {
            const velMs = telemetriaAOG.velocidad / 3.6;
            semillasPorMetro = valorFlujo / velMs;
          }

          // Buffer para global stats
          const bufKey = `${uidNodo}-${cableFisico}`;
          statsBuffer[bufKey] = semillasPorMetro;

          // ═══ ALERTAS CON OBJETIVO POR TREN ═══
          if (isSemilla || isFerti) {
            const seccionesTren = numTren === 1
              ? telemetriaAOG.seccionesT1
              : telemetriaAOG.seccionesT2;

            let seccionCortada = false;
            if (seccionesTren.length > 0) {
              const surcosTren = configFresca.mapeo_sensores
                .filter(s => s.is_active !== false && (s.tren || 1) === numTren && s.tipo === "semilla")
                .sort((a, b) => a.bajada - b.bajada);
              const idxEnTren = surcosTren.findIndex(s => s.bajada === sensorConfig.bajada);
              if (idxEnTren >= 0 && idxEnTren < seccionesTren.length) {
                seccionCortada = seccionesTren[idxEnTren] === 0;
              }
              if (++_secDebugCount % 20 === 1) {
                console.log(`\x1b[90m[Secciones]\x1b[0m T${numTren} bajada:${sensorConfig.bajada} idx:${idxEnTren} cortada:${seccionCortada}`);
              }
            }

            if (!seccionCortada && telemetriaAOG.velocidad > 1.5) {
              if (valorFlujo === 0) {
                alertaCritica = true;
              } else {
                const objetivo = _objetivoTren(numTren);
                if (objetivo > 0 && valorFlujo < objetivo * 0.5) {
                  alertaCritica = true;
                }
              }
            }

            sensorConfig._seccionCortada = seccionCortada;
          } else if (sensorConfig.tipo === "rotacion_eje" || sensorConfig.tipo === "turbina") {
            if (telemetriaAOG.velocidad > 1.5 && valorFlujo === 0) alertaCritica = true;
          }

          if (rawPulsos > 0) {
            console.log(`🎯 [EMIT] Surco: ${sensorConfig.bajada} | Flujo: ${valorFlujo.toFixed(1)} | SPM: ${semillasPorMetro.toFixed(1)}`);
          }

          io.emit("sensor_update", {
            bajada:          sensorConfig.bajada,
            tipo:            sensorConfig.tipo,
            tren:            numTren,
            valor:           valorFlujo.toFixed(1),
            alerta:          alertaCritica,
            nuevas_semillas: rawPulsos,
            spm:             semillasPorMetro.toFixed(1),
            seccion_cortada: sensorConfig._seccionCortada || false,
          });

          // Grabar semilla georeferenciada
          if (seedRecorder && rawPulsos > 0 && telemetriaAOG.lat) {
            seedRecorder.append({
              bajada: sensorConfig.bajada,
              tipo:   sensorConfig.tipo,
              pulsos: rawPulsos,
              spm:    semillasPorMetro.toFixed(2),
              lat:    telemetriaAOG.lat,
              lon:    telemetriaAOG.lon,
            });
          }
        });
      }
    } catch (e) {
      console.error("🚨 ERROR FATAL procesando MQTT:", e);
    }
  });

  // ═══ SOCKET: Omisión de sensor desde ventana detalle ═══
  io.on("connection", (clientSocket) => {
    clientSocket.on("toggle_omitir_sensor", (data) => {
      const { bajada, tren, omitido } = data;
      console.log(`\x1b[33m[Omisión]\x1b[0m Surco ${bajada} Tren ${tren} → ${omitido ? "OMITIDO" : "REACTIVADO"}`);
      io.emit("sensor_omision_update", { bajada, tren, omitido });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Bajada de herramienta → publica comando para CoreX → AOG
  // ─────────────────────────────────────────────────────────────
  function handleBajadaHerramienta(cfg, sensor, mqttClient, io) {
    const key = `${cfg.uid}_${cfg.cable}`;

    const raw = parseInt(sensor.raw) || 0;
    const val = parseFloat(sensor.valor) || 0;
    let estado = (raw > 0 || val > 0) ? 1 : 0;
    if (cfg.logica_invertida === true) estado = estado ? 0 : 1;

    const prev = estadoHerramienta.get(key) || {
      value:         null,
      pending:       null,
      debounceTimer: null,
    };

    if (estado === prev.value && prev.pending === null) return;
    if (prev.pending === estado && prev.debounceTimer) return;
    if (prev.debounceTimer) clearTimeout(prev.debounceTimer);

    const timer = setTimeout(() => {
      const payloadAog = {
        funcion: "bajada_herramienta",
        value:   estado,
        source:  { uid: cfg.uid, cable: cfg.cable, nombre: cfg.nombre },
        ts:      Date.now(),
      };

      mqttClient.publish(TOPIC_AOG_CMD, JSON.stringify(payloadAog), { qos: 1 });

      estadoHerramienta.set(key, {
        value:         estado,
        pending:       null,
        debounceTimer: null,
        lastSent:      Date.now(),
      });

      console.log(
        `\x1b[35m[AOG-CMD]\x1b[0m 🔧 ${cfg.nombre} (${cfg.uid}/c${cfg.cable}) → ` +
        `${estado === 1 ? "BAJADA ⬇" : "LEVANTADA ⬆"}`
      );

      io.emit("herramienta_update", {
        uid:    cfg.uid,
        cable:  cfg.cable,
        nombre: cfg.nombre,
        estado,
      });
    }, DEBOUNCE_HERRAMIENTA_MS);

    estadoHerramienta.set(key, {
      value:         prev.value,
      pending:       estado,
      debounceTimer: timer,
      lastSent:      prev.lastSent || 0,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // API pública del módulo (para rutas Express)
  // ─────────────────────────────────────────────────────────────

  /**
   * Publica un mensaje MQTT con opciones (retain, qos, etc).
   * @param {string} topic
   * @param {string|object} payload
   * @param {object} [opts]  { retain, qos }
   */
  function publish(topic, payload, opts) {
    if (!client.connected) {
      console.warn("[MQTT] No conectado — no se puede publicar en:", topic);
      return false;
    }
    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
    client.publish(topic, msg, opts || {});
    if (opts?.retain) {
      console.log(`\x1b[36m[MQTT]\x1b[0m ► ${topic} \x1b[33m[retained]\x1b[0m`, msg);
    } else {
      console.log(`\x1b[36m[MQTT]\x1b[0m ► ${topic}`, msg);
    }
    return true;
  }

  /**
   * Devuelve el estado conocido de los nodos (para panel OTA / dashboards).
   * Marca como offline los que no enviaron heartbeat en > 60s.
   */
  function getEstadoNodos() {
    const now = Date.now();
    Object.values(estadoNodos).forEach(n => {
      n.online = now - n.lastSeen < 60000;
    });
    return estadoNodos;
  }

  /**
   * Forzar republicación de la config de cables a los nodos.
   * Útil cuando se cambia el perfil activo desde una ruta Express.
   */
  function republicarConfigCables() {
    if (!configFresca) return false;
    publicarConfigCables({ publish }, configFresca);
    return true;
  }

  return {
    client,
    publish,
    getEstadoNodos,
    republicarConfigCables,
  };
}

module.exports = initMQTT;