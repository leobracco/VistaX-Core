// ============================================================
// VistaX — core/logic/mqtt_handler.js  (v3 — fix cierre lote)
//
// FIXES:
//   1. Cierre de lote: ahora al cerrar se emite lote_update
//      con {activo:false} SIEMPRE, sin importar el origen
//   2. Se escucha vistax/control/lote para cierre desde CoreX
//   3. Se limpia _cierreTimeout al iniciar lote nuevo
// ============================================================

const mqtt = require("mqtt");
const mapRecorder   = require("./map_recorder");
const seedRecorder  = require("./seed_recorder");

function initMQTT(io, getConfig) {
  const client = mqtt.connect("mqtt://127.0.0.1");

  let telemetriaAOG = { velocidad: 0, seccionesT1: [], seccionesT2: [] };
  const estadoNodos = {};
  let _cierreTimeout = null;
  let _descartesGPS  = 0;

  // ══════════════════════════════════════════
  // HELPERS — Iniciar / Cerrar lote centralizados
  // ══════════════════════════════════════════
  function _iniciarLote(nombre, cultivo, meta = {}) {
    // Cancelar cierre pendiente
    if (_cierreTimeout) { clearTimeout(_cierreTimeout); _cierreTimeout = null; }

    const lote = mapRecorder.iniciarLote(nombre, cultivo, meta.anchoPasada, meta);
    seedRecorder.iniciarLote(lote.id, nombre);

    io.emit("lote_update", {
      activo:  true,
      id:      lote.id,
      nombre:  lote.nombre,
      cultivo: lote.cultivo,
    });

    console.log(`\x1b[32m[VistaX]\x1b[0m ✅ LOTE INICIADO → "${nombre}" (${lote.id})`);
    return lote;
  }

  function _cerrarLote(motivo) {
    const loteActual = mapRecorder.getLoteActivo();
    if (!loteActual) return null;

    const resultado = mapRecorder.cerrarLote();
    seedRecorder.cerrarLote();

    // ═══ FIX PRINCIPAL: emitir SIEMPRE ═══
    io.emit("lote_update", { activo: false });

    console.log(`\x1b[33m[VistaX]\x1b[0m ✅ LOTE CERRADO → "${loteActual.nombre}" (motivo: ${motivo})`);
    return resultado;
  }

  // ══════════════════════════════════════════
  // CONEXIÓN Y SUSCRIPCIONES
  // ══════════════════════════════════════════
  client.on("connect", () => {
    console.log("\x1b[36m[MQTT]\x1b[0m VistaX: Conectado al Broker MQTT local");

    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/pulsos");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("vistax/nodos/estado");
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/machine/position");
    client.subscribe("aog/field/name");
    client.subscribe("aog/field/status");
    client.subscribe("sections/state");

    // ═══ NUEVO: Tópico de control de lote desde CoreX ═══
    client.subscribe("vistax/control/lote");
  });

  // ══════════════════════════════════════════
  // MENSAJES ENTRANTES
  // ══════════════════════════════════════════
  client.on("message", (topic, message) => {
    try {
      const msgStr = message.toString();

      // ── Velocidad (texto plano) ──
      if (topic === "aog/machine/speed") {
        telemetriaAOG.velocidad = parseFloat(msgStr) || 0;
        io.emit("global_update", { velocidad: telemetriaAOG.velocidad });
        return;
      }

      // ── Campo AOG: nombre (texto plano) ──
      if (topic === "aog/field/name") {
        const nombre = msgStr.trim();
        if (!nombre) return;
        const loteActual = mapRecorder.getLoteActivo();
        if (loteActual && loteActual.nombre === nombre) return;
        if (loteActual) _cerrarLote("campo-aog-cambio");
        _iniciarLote(nombre, "Sin definir");
        return;
      }

      // ══════════════════════════════════════
      // CONTROL DE LOTE DESDE COREX (NUEVO)
      // Payload: { cmd: "iniciar"|"cerrar", nombre?, cultivo? }
      // ══════════════════════════════════════
      if (topic === "vistax/control/lote") {
        let payload;
        try { payload = JSON.parse(msgStr); } catch { return; }

        if (payload.cmd === "cerrar") {
          _cerrarLote("corex-mqtt");
          return;
        }
        if (payload.cmd === "iniciar" && payload.nombre) {
          const loteActual = mapRecorder.getLoteActivo();
          if (loteActual) _cerrarLote("corex-nuevo-lote");
          _iniciarLote(payload.nombre, payload.cultivo || "Sin definir");
          return;
        }
        return;
      }

      // ── Parseo JSON seguro para el resto ──
      let payload;
      try { payload = JSON.parse(msgStr); }
      catch { return; }

      const configFresca = getConfig();

      // ── Posición GPS ──
      if (topic === "aog/machine/position") {
        const lat     = payload.lat     || payload.latitude  || 0;
        const lon     = payload.lon     || payload.longitude || 0;
        const heading = payload.heading || payload.hdg       || 0;
        const speed   = payload.speed   || payload.vel       || telemetriaAOG.velocidad || 0;
        if (!lat || !lon) return;

        // Registrar en seed_recorder para interpolación
        seedRecorder.registrarPosicionGPS(lat, lon, heading, Date.now());

        const punto = mapRecorder.actualizarGPS(lat, lon, heading, speed);
        if (punto) {
          io.emit("map_point", punto);
          const lote = mapRecorder.getLoteActivo();
          if (lote && lote.puntosGrabados % 10 === 0) {
            io.emit("map_stats", lote.estadisticasLive);
          }
        }
        return;
      }

      // ── Secciones ──
      if (topic === "sections/state") {
        telemetriaAOG.seccionesT1 = payload.t1 || [];
        telemetriaAOG.seccionesT2 = payload.t2 || [];
        return;
      }

      // ── Campo AOG: status ──
      if (topic === "aog/field/status") {
        const nombre     = payload.fieldName || "";
        const loteActual = mapRecorder.getLoteActivo();

        // Re-emitir para trigger_manager del frontend
        io.emit("field_status", payload);

        // Auto-inicio
        if (nombre && !loteActual) {
          _iniciarLote(nombre, "Sin definir");
          return;
        }
        if (nombre && loteActual && loteActual.nombre !== nombre) {
          _cerrarLote("campo-aog-cambio-status");
          _iniciarLote(nombre, "Sin definir");
          return;
        }
        if (!loteActual) return;

        // ═══ FIX: Auto-cierre cuando AOG deja de pintar ═══
        if (!payload.painting && loteActual.puntosGrabados > 10) {
          if (!_cierreTimeout) {
            _cierreTimeout = setTimeout(() => {
              _cierreTimeout = null;
              const loteVigente = mapRecorder.getLoteActivo();
              if (!loteVigente || loteVigente.puntosGrabados <= 10) return;
              _cerrarLote("aog-paro-de-pintar");
            }, 30000);
          }
        } else if (payload.painting && _cierreTimeout) {
          clearTimeout(_cierreTimeout);
          _cierreTimeout = null;
        }
        return;
      }

      // ── Estado del nodo ──
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
        return;
      }

      // ── Registro de nodo nuevo ──
      if (topic === "vistax/nodos/registro") {
        let existe = false;
        if (configFresca?.mapeo_sensores) {
          existe = configFresca.mapeo_sensores.some(s => s.uid === payload.uid);
        }
        if (!existe) {
          console.log(`\x1b[32m[VistaX]\x1b[0m Nuevo nodo: ${payload.uid} (FW: ${payload.firmware})`);
          io.emit("new_node_detected", payload);
        }
        return;
      }

      // ── Telemetría / pulsos de sensores ──
      if (
        (topic === "vistax/nodos/telemetria" || topic === "vistax/nodos/pulsos") &&
        configFresca?.mapeo_sensores
      ) {
        const sensores = payload.sensores || [];

        sensores.forEach((sensor) => {
          const cfg = configFresca.mapeo_sensores.find(
            s => s.uid === payload.uid && (
              (s.cable !== undefined && parseInt(s.cable) === parseInt(sensor.cable)) ||
              (s.pin  !== undefined && parseInt(s.pin) === parseInt(sensor.cable) - 1)
            )
          );
          if (!cfg) return;

          const rawPulsos  = parseInt(sensor.raw) || 0;
          const valorFlujo = parseFloat(sensor.valor) || 0;
          let alerta = false;

          const secTren   = (cfg.tren || 1) === 2 ? telemetriaAOG.seccionesT2 : telemetriaAOG.seccionesT1;
          const sembrando = secTren.length > 0 ? secTren.includes(1) : true;

          // Semillas/metro
          let spm = 0;
          if (telemetriaAOG.velocidad > 0.5) {
            const velMs = telemetriaAOG.velocidad / 3.6;
            spm = valorFlujo / velMs;
          }

          // Alertas
          const isSiembra = cfg.tipo === "semilla" || cfg.tipo.includes("ferti");
          if (isSiembra) {
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

          if (rawPulsos > 0) {
            console.log(`🎯 Surco: ${cfg.bajada} | Flujo: ${valorFlujo.toFixed(1)} | spm: ${spm.toFixed(1)}`);
          }

          // Informar al mapa
          mapRecorder.actualizarSensor(cfg.bajada, spm.toFixed(1), alerta);

          // Emitir al monitor
          io.emit("sensor_update", {
            bajada:          cfg.bajada,
            tipo:            cfg.tipo,
            valor:           valorFlujo.toFixed(1),
            alerta,
            nuevas_semillas: rawPulsos,
            spm:             spm.toFixed(1),
          });
        });
      }

    } catch (e) {
      console.error("🚨 ERROR FATAL procesando MQTT:", e);
    }
  });

  // ── publish() — rutas Express pueden enviar comandos MQTT ──
  function publish(topic, payload) {
    if (!client.connected) return false;
    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
    client.publish(topic, msg);
    return true;
  }

  function getEstadoNodos() {
    const now = Date.now();
    Object.values(estadoNodos).forEach(n => { n.online = now - n.lastSeen < 60000; });
    return estadoNodos;
  }

  // Exponer helpers de lote para que las rutas REST los usen
  function iniciarLoteDesdeRuta(nombre, cultivo, meta) { return _iniciarLote(nombre, cultivo, meta); }
  function cerrarLoteDesdeRuta() { return _cerrarLote("api-rest"); }

  return { client, publish, getEstadoNodos, iniciarLoteDesdeRuta, cerrarLoteDesdeRuta };
}

module.exports = initMQTT;
