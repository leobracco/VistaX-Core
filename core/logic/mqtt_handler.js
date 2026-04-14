// ============================================================
// VistaX — mqtt_handler.js  v6.1
//
// FIXES sobre v6:
//   1. Eliminado `let mapRecorder = null` (shadoweaba el require del top)
//   2. seedRecorder: singleton, no clase → usar iniciarLote() / cerrarLote()
//   3. mapRecorder: singleton, no clase → no instanciar, no llamar close()
//   4. aog/field/status ahora lee `accion` (no `status`)
//   5. Suscripción a aog/machine/position + lat/lon en telemetriaAOG
//   6. mapRecorder.onSensorData() llamado después de io.emit("sensor_update")
//   7. seedRecorder usa registrarVentana() en lugar de append()
//   8. seedRecorder.registrarPosicionGPS() llamado en cada posición GPS
// ============================================================

const profilesManager = require("../database/profiles_manager");
const nodosInventory  = require("../database/nodos_inventory");
const mapRecorder     = require("./map_recorder");       // singleton — NO instanciar
const seedRecorder    = require("./seed_recorder");      // singleton — NO instanciar
const { publicarConfigCables } = require("./cable_config_publisher");

function initMQTT(io) {
  const mqtt = require("mqtt");

  const client = mqtt.connect("mqtt://127.0.0.1");

  let configFresca = null;
  let telemetriaAOG = {
    velocidad:   0,
    lat:         0,     // FIX 5
    lon:         0,     // FIX 5
    seccionesT1: [],
    seccionesT2: [],
  };
  let loteActual     = null;
  // FIX 1: ELIMINADO → let mapRecorder = null;
  // FIX 2: ELIMINADO → let seedRecorder = null; (el singleton se importa arriba)
  let _secDebugCount = 0;

  const estadoNodos       = {};
  const estadoHerramienta = new Map();
  const DEBOUNCE_HERRAMIENTA_MS = 150;
  const TOPIC_AOG_CMD           = "vistax/corex/aog/cmd";

  // ── Cargar config del perfil ACTIVO ──────────────────────────
  function recargarConfig() {
    try {
      const nombreActivo = profilesManager.getLastProfileName();
      const perfil       = profilesManager.getActiveProfile(nombreActivo);
      if (perfil) configFresca = perfil;
    } catch (e) {
      console.error("Error cargando config:", e);
    }
  }

  recargarConfig();
  setInterval(recargarConfig, 5000);

  function _objetivoTren(numTren) {
    const porTren = configFresca?.setup?.objetivos_tren;
    if (porTren && porTren[numTren] !== undefined) return parseFloat(porTren[numTren]);
    return parseFloat(configFresca?.setup?.densidad_objetivo) || 16;
  }

  // ── CONNECT ──────────────────────────────────────────────────
  client.on("connect", () => {
    console.log("\x1b[32m[VistaX MQTT]\x1b[0m Conectado al broker");
    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("vistax/nodos/estado");
    client.subscribe("vistax/nodos/heartbeat");
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/machine/position");   // FIX 5
    client.subscribe("aog/field/status");
    client.subscribe("sections/state");
    client.subscribe("vistax/control/lote");
    client.subscribe("vistax/debug/#");

    mapRecorder.iniciar(client, io);            // inicializa el singleton

    setTimeout(() => {
      if (configFresca) {
        publicarConfigCables({ publish }, configFresca);
        console.log("\x1b[32m[VistaX]\x1b[0m Config de cables republicada al arranque");
      }
    }, 1500);
  });

  // ═══ CICLO DE VIDA DEL LOTE ══════════════════════════════════

  function _iniciarLote(data) {
    loteActual = {
      id:              data.id || `lote_${Date.now()}`,
      nombre:          data.nombre || "Sin nombre",
      cultivo:         data.cultivo || "",
      variedad:        data.variedad || "",
      establecimiento: data.establecimiento || "",
      inicio:          new Date().toISOString(),
      activo:          true,
    };
    console.log(`\x1b[32m[VistaX]\x1b[0m Lote iniciado: ${loteActual.nombre}`);

    // FIX 2: seedRecorder es singleton — usar su API de módulo
    try {
      seedRecorder.iniciarLote(loteActual.id, loteActual.nombre);
    } catch (e) {
      console.warn("[VistaX] seedRecorder.iniciarLote falló:", e.message);
    }

    // FIX 3: mapRecorder maneja su propio ciclo via aog/field/status —
    //         NO instanciar ni llamar ningún método aquí.

    io.emit("lote_update", loteActual);
  }

  function _cerrarLote() {
    if (!loteActual) return;
    console.log(`\x1b[33m[VistaX]\x1b[0m Lote cerrado: ${loteActual.nombre}`);
    loteActual.activo = false;
    loteActual.fin    = new Date().toISOString();
    io.emit("lote_update", { activo: false });

    // FIX 2: API correcta del singleton
    try { seedRecorder.cerrarLote(); } catch (e) { /* sin lote activo en seedRecorder */ }
    // FIX 3: mapRecorder.close() no existe — el mapa persiste y se cierra vía MQTT

    loteActual = null;
  }

  // Exponer para rutas Express
  client.cerrarLoteDesdeRuta  = _cerrarLote;
  client.iniciarLoteDesdeRuta = _iniciarLote;
  client.getLoteActual        = () => loteActual;

  // ═══ GLOBAL STATS ════════════════════════════════════════════
  let statsBuffer = {};
  let statsTimer  = null;

  function _emitirGlobalStats() {
    if (!configFresca?.mapeo_sensores) return;
    const sensoresSemilla = configFresca.mapeo_sensores.filter(
      s => s.tipo === "semilla" && s.is_active !== false
    );
    let sumaFlujo = 0, count = 0;
    sensoresSemilla.forEach(s => {
      const key = `${s.uid}-${s.cable || s.pin}`;
      if (statsBuffer[key] !== undefined) { sumaFlujo += statsBuffer[key]; count++; }
    });
    io.emit("global_update", {
      velocidad: telemetriaAOG.velocidad,
      promedio:  (count > 0 ? sumaFlujo / count : 0).toFixed(1),
    });
  }

  if (!statsTimer) statsTimer = setInterval(_emitirGlobalStats, 1000);

  // ═══ HANDLER PRINCIPAL DE MENSAJES ═══════════════════════════
  client.on("message", (topic, message) => {
    try {
      if (topic.startsWith("vistax/debug/")) {
        io.emit("debug_msg", {
          uid: topic.replace("vistax/debug/", ""),
          msg: message.toString(),
          ts:  Date.now(),
        });
        return;
      }

      const payload = JSON.parse(message.toString());

      // ── VELOCIDAD ────────────────────────────────────────────
      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(payload) || 0;
        return;
      }

      // FIX 5+8: ── POSICIÓN GPS ────────────────────────────────
      if (topic === "aog/machine/position") {
        if (payload.lat && payload.lon) {
          telemetriaAOG.lat = payload.lat;
          telemetriaAOG.lon = payload.lon;
          // FIX 8: alimentar al seedRecorder para interpolación temporal
          seedRecorder.registrarPosicionGPS(
            payload.lat,
            payload.lon,
            payload.heading || 0,
            Date.now()
          );
        }
        // mapRecorder recibe este mismo topic vía su propio listener
        return;
      }

      // ── SECCIONES ────────────────────────────────────────────
      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        io.emit("sections_update", {
          t1: telemetriaAOG.seccionesT1,
          t2: telemetriaAOG.seccionesT2,
        });
        return;
      }

      // ── CONTROL LOTE (desde UI o CoreX) ──────────────────────
      if (topic === "vistax/control/lote") {
        if (payload.accion === "iniciar")     _iniciarLote(payload);
        else if (payload.accion === "cerrar") _cerrarLote();
        return;
      }

      // FIX 4: ── AOG FIELD STATUS ──────────────────────────────
      // aog_log_watcher publica { fieldName, accion, painting, ts }
      // El campo correcto es `accion`, NO `status`.
      if (topic === "aog/field/status") {
        const { accion, fieldName } = payload;
        if (["abierto", "nuevo", "continuar"].includes(accion) && !loteActual) {
          _iniciarLote({ nombre: fieldName || "AOG Field", cultivo: "auto" });
        } else if (accion === "cerrado" && loteActual) {
          _cerrarLote();
        }
        // mapRecorder maneja su propio ciclo con este mismo mensaje
        return;
      }

      // ── HEARTBEAT / ESTADO DE NODO ───────────────────────────
      if (topic === "vistax/nodos/estado" || topic === "vistax/nodos/heartbeat") {
        const uid = payload.uid;
        if (!uid || nodosInventory.estaIgnorado(uid)) return;

        nodosInventory.upsertFromHeartbeat(payload);
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

      // ── REGISTRO DE NODO ─────────────────────────────────────
      if (topic === "vistax/nodos/registro") {
        const uid = payload.uid;
        nodosInventory.upsertFromHeartbeat(payload);
        if (!uid) return;

        if (nodosInventory.estaIgnorado(uid)) {
          console.log(`\x1b[90m[VistaX]\x1b[0m Nodo ignorado se registró: ${uid}`);
          return;
        }

        const { esNuevo } = nodosInventory.upsertFromHeartbeat(payload);
        if (esNuevo) {
          console.log(`\x1b[32m[VistaX]\x1b[0m 🆕 Nodo nuevo: ${uid} (FW: ${payload.firmware || "?"})`);
          io.emit("new_node_detected", payload);
        } else {
          console.log(`\x1b[90m[VistaX]\x1b[0m Nodo conocido reconectado: ${uid}`);
        }
        io.emit("nodos_inventario_changed");
        if (configFresca) {
          setTimeout(() => publicarConfigCables({ publish }, configFresca), 500);
        }
        return;
      }

      // ── TELEMETRÍA DE SENSORES ───────────────────────────────
      if (topic === "vistax/nodos/telemetria") {
        const uidNodo = payload.uid;
        if (payload?.uid) nodosInventory.upsertFromHeartbeat({ uid: payload.uid });
        if (!payload.sensores || !configFresca?.mapeo_sensores) return;

        payload.sensores.forEach(sensorRaw => {
          const cableFisico  = parseInt(sensorRaw.cable);
          const sensorConfig = configFresca.mapeo_sensores.find(s => {
            const matchNodo  = s.uid === uidNodo;
            const matchPin   = s.pin   !== undefined && parseInt(s.pin)   === cableFisico - 1;
            const matchCable = s.cable !== undefined && parseInt(s.cable) === cableFisico;
            return matchNodo && (matchPin || matchCable);
          });

          if (!sensorConfig || sensorConfig.is_active === false) return;

          // BAJADA DE HERRAMIENTA → CoreX → AOG
          if (sensorConfig.tipo === "bajada_herramienta") {
            handleBajadaHerramienta(sensorConfig, sensorRaw, client, io);
            return;
          }

          // Procesamiento normal
          let alertaCritica = false;
          const valorFlujo  = parseFloat(sensorRaw.valor);
          const isSemilla   = sensorConfig.tipo === "semilla";
          const isFerti     = sensorConfig.tipo.includes("ferti");
          const rawPulsos   = parseInt(sensorRaw.raw) || 0;
          const numTren     = sensorConfig.tren || 1;

          let semillasPorMetro = 0;
          if (telemetriaAOG.velocidad > 0.5) {
            semillasPorMetro = valorFlujo / (telemetriaAOG.velocidad / 3.6);
          }

          statsBuffer[`${uidNodo}-${cableFisico}`] = semillasPorMetro;

          // Alertas
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
                if (objetivo > 0 && valorFlujo < objetivo * 0.5) alertaCritica = true;
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

          // FIX 6: GRABAR EN MAPA DE SIEMBRA (mapRecorder singleton)
          mapRecorder.onSensorData(
            sensorConfig.bajada,
            sensorConfig.tipo,
            semillasPorMetro
          );

          // FIX 7: GRABAR SEMILLA GEORREFERENCIADA (API correcta del singleton)
          // La posición ya fue alimentada en el handler de aog/machine/position (FIX 8)
          if (rawPulsos > 0 && telemetriaAOG.lat) {
            try {
              seedRecorder.registrarVentana(
                uidNodo,
                sensorConfig.bajada,
                rawPulsos,
                Date.now()
              );
            } catch (e) { /* lote no activo en seedRecorder — ignorar */ }
          }
        });
      }

    } catch (e) {
      console.error("🚨 ERROR FATAL procesando MQTT:", e);
    }
  });

  // ── SOCKET: Omisión de sensor ─────────────────────────────────
  io.on("connection", (clientSocket) => {
    clientSocket.on("toggle_omitir_sensor", (data) => {
      const { bajada, tren, omitido } = data;
      console.log(`\x1b[33m[Omisión]\x1b[0m Surco ${bajada} Tren ${tren} → ${omitido ? "OMITIDO" : "REACTIVADO"}`);
      io.emit("sensor_omision_update", { bajada, tren, omitido });
    });
  });

  // ── Bajada de herramienta ──────────────────────────────────────
  function handleBajadaHerramienta(cfg, sensor, mqttClient, io) {
    const key  = `${cfg.uid}_${cfg.cable}`;
    const raw  = parseInt(sensor.raw)     || 0;
    const val  = parseFloat(sensor.valor) || 0;
    let estado = (raw > 0 || val > 0) ? 1 : 0;
    if (cfg.logica_invertida === true) estado = estado ? 0 : 1;

    const prev = estadoHerramienta.get(key) || { value: null, pending: null, debounceTimer: null };

    if (estado === prev.value && prev.pending === null) return;
    if (prev.pending === estado && prev.debounceTimer)  return;
    if (prev.debounceTimer) clearTimeout(prev.debounceTimer);

    const timer = setTimeout(() => {
      mqttClient.publish(TOPIC_AOG_CMD, JSON.stringify({
        funcion: "bajada_herramienta",
        value:   estado,
        source:  { uid: cfg.uid, cable: cfg.cable, nombre: cfg.nombre },
        ts:      Date.now(),
      }), { qos: 1 });

      estadoHerramienta.set(key, { value: estado, pending: null, debounceTimer: null, lastSent: Date.now() });

      console.log(
        `\x1b[35m[AOG-CMD]\x1b[0m 🔧 ${cfg.nombre} (${cfg.uid}/c${cfg.cable}) → ` +
        `${estado === 1 ? "BAJADA ⬇" : "LEVANTADA ⬆"}`
      );
      io.emit("herramienta_update", { uid: cfg.uid, cable: cfg.cable, nombre: cfg.nombre, estado });
    }, DEBOUNCE_HERRAMIENTA_MS);

    estadoHerramienta.set(key, { value: prev.value, pending: estado, debounceTimer: timer, lastSent: prev.lastSent || 0 });
  }

  // ── API pública para rutas Express ────────────────────────────
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

  function getEstadoNodos() {
    const now = Date.now();
    Object.values(estadoNodos).forEach(n => { n.online = now - n.lastSeen < 60000; });
    return estadoNodos;
  }

  function republicarConfigCables() {
    if (!configFresca) return false;
    publicarConfigCables({ publish }, configFresca);
    return true;
  }

  return { client, publish, getEstadoNodos, republicarConfigCables };
}

module.exports = initMQTT;