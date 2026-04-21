// ============================================================
// VistaX — mqtt_handler.js  v6.3
//
// NUEVO en v6.3: Sistema de activación de monitoreo
//   - Modo "aog":     activo si AOG.painting === true
//   - Modo "semilla": activo si N o más surcos están "vivos"
//                     (reportaron pulsos en los últimos 3s)
//   - Siempre se ven los pulsos (UI pinta verde), PERO las alertas
//     de tapado/falla solo se disparan si monitoreo está activo.
//   - Emite `monitoreo_estado` por Socket.IO cuando cambia el estado
//     (bar muestra badge verde "MONITOREANDO" cuando está activo)
//
// Campos del perfil usados (ya existentes en setup):
//   - setup.modo_monitoreo:           "aog" | "semilla"
//   - setup.surcos_minimos_monitoreo: N (default 3)
//
// FIXES previos (v6.2):
//   9.  find() filtra is_active=false desde el principio
//  10.  Logs diagnósticos en telemetría
//  11.  Log de arranque con conteo de sensores
//
// FIXES previos (v6.1):
//   1-8: singletons mapRecorder/seedRecorder, aog/field/status,
//        posición GPS, registrarVentana, registrarPosicionGPS
// ============================================================

const profilesManager = require("../database/profiles_manager");
const nodosInventory  = require("../database/nodos_inventory");
const loteRecorder    = require("../geo/lote_recorder");
const lotePurge       = require("../geo/lote_purge");
const { publicarConfigCables } = require("./cable_config_publisher");

// ── Constantes del monitoreo activo ──────────────────────────
const VENTANA_SURCO_VIVO_MS = 3000;  // un surco se considera "vivo" si tuvo pulsos en los últimos 3s
const EVAL_MONITOREO_MS     = 500;   // cada 500ms recalcular estado de monitoreo

function initMQTT(io) {
  const mqtt = require("mqtt");

  const client = mqtt.connect("mqtt://127.0.0.1");

  let configFresca = null;
  let telemetriaAOG = {
    velocidad:   0,
    lat:         0,
    lon:         0,
    seccionesT1: [],
    seccionesT2: [],
    painting:    false,    // ← NUEVO: estado de pintado para modo AOG
  };
  let loteActual     = null;
  let _secDebugCount = 0;
  let _telemDebugCount = 0;

  // ── Estado del monitoreo activo ──────────────────────────────
  // ultimoPulsoSurco: Map<bajada_tren, timestamp> — último pulso de cada surco
  // monitoreoActivo:  bool — si las alertas están habilitadas actualmente
  const ultimoPulsoSurco = new Map();
  let monitoreoActivo = false;

  const estadoNodos       = {};
  const estadoHerramienta = new Map();
  const ciclosCeroConsecutivos = new Map();
  const DEBOUNCE_HERRAMIENTA_MS = 150;
  const TOPIC_AOG_CMD           = "vistax/corex/aog/cmd";

  // ── Cargar config del perfil ACTIVO ──────────────────────────
  function recargarConfig() {
    try {
      const nombreActivo = profilesManager.getLastProfileName();
      const perfil       = profilesManager.getActiveProfile(nombreActivo);
      if (perfil) {
        const antes = configFresca?.mapeo_sensores?.filter(s => s.is_active !== false).length || 0;
        configFresca = perfil;
        const despues = perfil.mapeo_sensores?.filter(s => s.is_active !== false).length || 0;
        if (antes !== despues) {
          console.log(`\x1b[32m[VistaX MQTT]\x1b[0m Perfil "${nombreActivo}" recargado — ${despues} sensores activos (antes: ${antes})`);
        }
      }
    } catch (e) {
      console.error("[VistaX MQTT] Error cargando config:", e);
    }
  }

  recargarConfig();
  setInterval(recargarConfig, 5000);

  function _objetivoTren(numTren) {
    const porTren = configFresca?.setup?.objetivos_tren;
    if (porTren && porTren[numTren] !== undefined) return parseFloat(porTren[numTren]);
    return parseFloat(configFresca?.setup?.densidad_objetivo) || 16;
  }

  // ─────────────────────────────────────────────────────────────
  //  SISTEMA DE MONITOREO ACTIVO
  // ─────────────────────────────────────────────────────────────

  /**
   * Retorna cuántos surcos están "vivos" (reportaron pulsos en los
   * últimos VENTANA_SURCO_VIVO_MS milisegundos).
   */
  function _contarSurcosVivos() {
    const ahora = Date.now();
    let vivos = 0;
    for (const [, ts] of ultimoPulsoSurco) {
      if (ahora - ts <= VENTANA_SURCO_VIVO_MS) vivos++;
    }
    return vivos;
  }

  /**
   * Limpia entradas viejas del map (más de VENTANA_SURCO_VIVO_MS + margen)
   * para evitar que crezca sin límite.
   */
  function _limpiarSurcosViejos() {
    const limite = Date.now() - VENTANA_SURCO_VIVO_MS - 5000;
    for (const [key, ts] of ultimoPulsoSurco) {
      if (ts < limite) ultimoPulsoSurco.delete(key);
    }
  }

  /**
   * Recalcula si el monitoreo debe estar activo según el modo configurado.
   * Si hay cambio de estado, emite evento por Socket.IO y loguea.
   */
  function _evaluarMonitoreo() {
    const modo = configFresca?.setup?.modo_monitoreo || "semilla";
    const umbral = parseInt(configFresca?.setup?.surcos_minimos_monitoreo) || 3;

    let deberiaEstarActivo = false;
    let razon = "";

    if (modo === "aog") {
      // Modo A: seguir el estado painting de AOG
      deberiaEstarActivo = telemetriaAOG.painting === true;
      razon = deberiaEstarActivo ? "AOG painting=true" : "AOG painting=false";
    } else {
      // Modo B: contar surcos vivos (semilla)
      const vivos = _contarSurcosVivos();
      deberiaEstarActivo = vivos >= umbral;
      razon = `${vivos}/${umbral} surcos vivos`;
    }

    if (deberiaEstarActivo !== monitoreoActivo) {
      monitoreoActivo = deberiaEstarActivo;
      const color = monitoreoActivo ? "\x1b[32m" : "\x1b[33m";
      const label = monitoreoActivo ? "🟢 MONITOREANDO" : "⏸ STAND-BY";
      console.log(`${color}[Monitoreo]\x1b[0m ${label} (${razon}, modo=${modo})`);
      io.emit("monitoreo_estado", {
        activo: monitoreoActivo,
        modo,
        razon,
        umbral,
        surcosVivos: modo === "semilla" ? _contarSurcosVivos() : null,
      });
    }
  }

  // Evaluar monitoreo cada 500ms
  setInterval(() => {
    _limpiarSurcosViejos();
    _evaluarMonitoreo();
  }, EVAL_MONITOREO_MS);

  // Emitir estado inicial cuando se conecta un cliente socket
  // (para que la bar pinte el badge correctamente al cargar)
  io.on("connection", (clientSocket) => {
    clientSocket.emit("monitoreo_estado", {
      activo: monitoreoActivo,
      modo: configFresca?.setup?.modo_monitoreo || "semilla",
      umbral: parseInt(configFresca?.setup?.surcos_minimos_monitoreo) || 3,
    });
  });

  // ── CONNECT ──────────────────────────────────────────────────
  client.on("connect", () => {
    console.log("\x1b[32m[VistaX MQTT]\x1b[0m Conectado al broker");
    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("vistax/nodos/estado");
    client.subscribe("vistax/nodos/heartbeat");
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/machine/position");
    client.subscribe("aog/field/status");
    client.subscribe("sections/state");
    client.subscribe("vistax/control/lote");
    client.subscribe("vistax/debug/#");

    const activos = configFresca?.mapeo_sensores?.filter(s => s.is_active !== false).length || 0;
    const modo = configFresca?.setup?.modo_monitoreo || "semilla";
    const umbral = parseInt(configFresca?.setup?.surcos_minimos_monitoreo) || 3;
    console.log(`\x1b[32m[VistaX MQTT]\x1b[0m Perfil activo con ${activos} sensores activos`);
    console.log(`\x1b[32m[VistaX MQTT]\x1b[0m Modo monitoreo: "${modo}", umbral: ${umbral} surcos`);

    loteRecorder.init(io);
    lotePurge.iniciar(() => configFresca?.setup?.lotes_auto_purge_dias || 90);

    setTimeout(() => {
      if (configFresca) {
        publicarConfigCables({ publish }, configFresca);
        console.log("\x1b[32m[VistaX MQTT]\x1b[0m Config de cables republicada al arranque");
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
     try {
      loteRecorder.iniciarLote(loteActual.id, loteActual.nombre, configFresca);
    } catch (e) {
      console.warn("[VistaX] loteRecorder.iniciarLote falló:", e.message);
    }
    io.emit("lote_update", loteActual);
  }

  function _cerrarLote() {
    if (!loteActual) return;
    console.log(`\x1b[33m[VistaX]\x1b[0m Lote cerrado: ${loteActual.nombre}`);
    loteActual.activo = false;
    loteActual.fin    = new Date().toISOString();
    io.emit("lote_update", { activo: false });
    try { loteRecorder.cerrarLote(); } catch (e) { /* sin lote activo */ }
    loteActual = null;
  }

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

      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(payload) || 0;
        return;
      }

      if (topic === "aog/machine/position") {
      if (payload.lat && payload.lon) {
        telemetriaAOG.lat = payload.lat;
        telemetriaAOG.lon = payload.lon;
        loteRecorder.registrarGPS(
          payload.lat,
          payload.lon,
          payload.heading || 0,
          telemetriaAOG.velocidad,
          Date.now()
        );
      }
      return;
    }

      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        io.emit("sections_update", {
          t1: telemetriaAOG.seccionesT1,
          t2: telemetriaAOG.seccionesT2,
        });
        return;
      }

      if (topic === "vistax/control/lote") {
        if (payload.accion === "iniciar")     _iniciarLote(payload);
        else if (payload.accion === "cerrar") _cerrarLote();
        return;
      }

      if (topic === "aog/field/status") {
        const { accion, fieldName, painting } = payload;

        // ── NUEVO v6.3: actualizar estado painting para modo AOG ──
        if (typeof painting === "boolean") {
          telemetriaAOG.painting = painting;
          // Re-evaluar monitoreo inmediatamente (no esperar el setInterval)
          _evaluarMonitoreo();
        }

        if (["abierto", "nuevo", "continuar"].includes(accion) && !loteActual) {
          _iniciarLote({ nombre: fieldName || "AOG Field", cultivo: "auto" });
        } else if (accion === "cerrado" && loteActual) {
          _cerrarLote();
        }
        return;
      }

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
        if (!payload.sensores || !configFresca?.mapeo_sensores) {
          if (!configFresca?.mapeo_sensores) {
            if (++_telemDebugCount % 50 === 1) {
              console.log(`\x1b[31m[VistaX MQTT]\x1b[0m ⚠ Telemetría de ${uidNodo} ignorada: configFresca no cargada`);
            }
          }
          return;
        }

        payload.sensores.forEach(sensorRaw => {
          const cableFisico  = parseInt(sensorRaw.cable);
          const rawPulsos    = parseInt(sensorRaw.raw) || 0;

          const sensorConfig = configFresca.mapeo_sensores.find(s => {
            if (s.is_active === false) return false;
            const matchNodo  = s.uid === uidNodo;
            const matchPin   = s.pin   !== undefined && parseInt(s.pin)   === cableFisico - 1;
            const matchCable = s.cable !== undefined && parseInt(s.cable) === cableFisico - 1;
            return matchNodo && (matchPin || matchCable);
          });

          if (rawPulsos > 0 && !sensorConfig) {
            const mapeadosEseNodo = configFresca.mapeo_sensores
              .filter(s => s.uid === uidNodo && s.is_active !== false)
              .map(s => `c${s.cable ?? (s.pin + 1)}→${s.tipo}/b${s.bajada ?? "?"}`)
              .join(", ") || "NINGUNO";
            console.log(
              `\x1b[33m[VistaX MQTT]\x1b[0m ⚠ Pulsos en ${uidNodo} c${cableFisico} (raw=${rawPulsos}) — sin mapeo activo. ` +
              `Activos en ese nodo: ${mapeadosEseNodo}`
            );
          }

          if (!sensorConfig) return;

          if (sensorConfig.tipo === "bajada_herramienta") {
            handleBajadaHerramienta(sensorConfig, sensorRaw, client, io);
            return;
          }

          // ── NUEVO v6.3: registrar pulso de surco en el tracker ──
          //    Solo para tipos de siembra (semilla/ferti), que son los
          //    que determinan si el sistema está "trabajando".
          const isSemilla = sensorConfig.tipo === "semilla";
          const isFerti   = sensorConfig.tipo.includes("ferti");
          if ((isSemilla || isFerti) && rawPulsos > 0) {
            const surcoKey = `${sensorConfig.tren || 1}-${sensorConfig.bajada}`;
            ultimoPulsoSurco.set(surcoKey, Date.now());
          }

          // Procesamiento normal
          let alertaCritica = false;
          const valorFlujo  = parseFloat(sensorRaw.valor);
          const numTren     = sensorConfig.tren || 1;

          let semillasPorMetro = 0;
          if (telemetriaAOG.velocidad > 0.5) {
            semillasPorMetro = valorFlujo / (telemetriaAOG.velocidad / 3.6);
          }

          statsBuffer[`${uidNodo}-${cableFisico}`] = semillasPorMetro;

          // ── Alertas SOLO si el monitoreo está activo ──
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

            // ── NUEVO v6.3: alerta solo si monitoreo activo ──
           if (monitoreoActivo && !seccionCortada) {
              const alarmaSeg = parseFloat(configFresca?.setup?.alarma_tiempo_seg) || 2;
              const ciclosNecesarios = Math.ceil(alarmaSeg / 0.5);
              const keyAlarma = `${numTren}_${sensorConfig.bajada}`;

              if (valorFlujo === 0) {
                const actual = (ciclosCeroConsecutivos.get(keyAlarma) || 0) + 1;
                ciclosCeroConsecutivos.set(keyAlarma, actual);

                if (actual >= ciclosNecesarios) {
                  alertaCritica = true;
                }
              } else {
                ciclosCeroConsecutivos.delete(keyAlarma);

                const objetivo = _objetivoTren(numTren);
                if (objetivo > 0 && valorFlujo < objetivo * 0.5) {
                  alertaCritica = true;
                }
              }
            }
            sensorConfig._seccionCortada = seccionCortada;

          } else if (sensorConfig.tipo === "rotacion_eje" || sensorConfig.tipo === "turbina") {
            // ── NUEVO v6.3: alerta de eje/turbina solo si monitoreo activo ──
            if (monitoreoActivo && valorFlujo === 0) alertaCritica = true;
          }

          if (rawPulsos > 0) {
            const label = sensorConfig.bajada
              ? `Surco ${sensorConfig.bajada} (T${numTren})`
              : `${sensorConfig.tipo}${sensorConfig.nombre ? ' "' + sensorConfig.nombre + '"' : ''} [${uidNodo} c${parseInt(sensorConfig.cable)}]`;
            console.log(
              `\x1b[32m🎯 [EMIT]\x1b[0m ${uidNodo} c${cableFisico} → ${label} | Flujo: ${valorFlujo.toFixed(1)} | SPM: ${semillasPorMetro.toFixed(1)}`
            );
          }

          io.emit("sensor_update", {
            uid:             uidNodo,
            cable:           parseInt(sensorConfig.cable),
            bajada:          sensorConfig.bajada,
            tipo:            sensorConfig.tipo,
            tren:            numTren,
            valor:           valorFlujo.toFixed(1),
            alerta:          alertaCritica,
            nuevas_semillas: rawPulsos,
            spm:             semillasPorMetro.toFixed(1),
            seccion_cortada: sensorConfig._seccionCortada || false,
          });

         loteRecorder.registrarEvento({
            uid:    uidNodo,
            cable:  parseInt(sensorConfig.cable),
            bajada: sensorConfig.bajada,
            tipo:   sensorConfig.tipo,
            raw:    rawPulsos,
            spm:    semillasPorMetro,
            ts:     Date.now(),
          });
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

  // ── API pública ──────────────────────────────────────────────
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
