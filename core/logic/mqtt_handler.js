// ============================================================
// VistaX — mqtt_handler.js  v5
//
// CAMBIOS v5:
//   1. Sensores con is_active === false se IGNORAN completamente
//   2. Alerta de desvío usa objetivo por tren (setup.objetivos_tren[N])
//   3. Emite densidad individual (spm) por surco
// ============================================================

function initMQTT(io) {
  const mqtt = require("mqtt");
  const fs = require("fs");
  const path = require("path");

  const client = mqtt.connect("mqtt://127.0.0.1");

  let configFresca = null;
  let telemetriaAOG = {
    velocidad: 0,
    seccionesT1: [],
    seccionesT2: [],
  };
  let loteActual = null;
  let seedRecorder = null;
  let mapRecorder = null;

  // Cargar config fresca
  function recargarConfig() {
    try {
      const configDir = path.join(__dirname, "../../data/implementos");
      const archivos = fs
        .readdirSync(configDir)
        .filter((f) => f.endsWith(".json"));
      if (archivos.length > 0) {
        const raw = fs.readFileSync(path.join(configDir, archivos[0]), "utf-8");
        configFresca = JSON.parse(raw);
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

  /**
   * Tolerancia de desvío en porcentaje
   */
  function _toleranciaDesvio() {
    return parseFloat(configFresca?.setup?.tolerancia_desvio) || 20;
  }

  client.on("connect", () => {
    console.log("\x1b[32m[VistaX MQTT]\x1b[0m Conectado al broker");
    client.subscribe("vistax/nodos/telemetria");
    client.subscribe("vistax/nodos/registro");
    client.subscribe("aog/machine/speed");
    client.subscribe("aog/field/status");
    client.subscribe("sections/state");
    client.subscribe("vistax/control/lote");
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

    if (seedRecorder) {
      seedRecorder.close();
      seedRecorder = null;
    }
    if (mapRecorder) {
      mapRecorder.close();
      mapRecorder = null;
    }
    loteActual = null;
  }

  // Exponer para rutas
  client.cerrarLoteDesdeRuta = _cerrarLote;
  client.iniciarLoteDesdeRuta = _iniciarLote;
  client.getLoteActual = () => loteActual;

  // ═══ Global stats ═══
  let statsBuffer = {};
  let statsTimer = null;

  function _emitirGlobalStats() {
    if (!configFresca?.mapeo_sensores) return;

    const sensoresSemilla = configFresca.mapeo_sensores.filter(
      (s) => s.tipo === "semilla" && s.is_active !== false,
    );

    let sumaFlujo = 0;
    let count = 0;
    sensoresSemilla.forEach((s) => {
      const key = `${s.uid}-${s.cable || s.pin}`;
      if (statsBuffer[key] !== undefined) {
        sumaFlujo += statsBuffer[key];
        count++;
      }
    });

    const promedio = count > 0 ? sumaFlujo / count : 0;

    io.emit("global_update", {
      velocidad: telemetriaAOG.velocidad,
      promedio: promedio.toFixed(1),
    });
  }

  if (!statsTimer) {
    statsTimer = setInterval(_emitirGlobalStats, 1000);
  }

  client.on("message", (topic, message) => {
    try {
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
          _iniciarLote({
            nombre: payload.field_name || "AOG Field",
            cultivo: "auto",
          });
        } else if (payload.status === "field_close" && loteActual) {
          _cerrarLote();
        }
        return;
      }

      // ═══ REGISTRO NODOS ═══
      if (topic === "vistax/nodos/registro") {
        let nodoExiste = false;
        if (configFresca?.mapeo_sensores) {
          nodoExiste = configFresca.mapeo_sensores.some(
            (s) => s.uid === payload.uid,
          );
        }
        if (!nodoExiste) {
          console.log(`\x1b[32m[VistaX]\x1b[0m Nuevo nodo: ${payload.uid}`);
          io.emit("new_node_detected", payload);
        }
        return;
      }

      // ═══ TELEMETRÍA DE SENSORES ═══
      if (topic === "vistax/nodos/telemetria") {
        const uidNodo = payload.uid;

        if (payload.sensores && configFresca?.mapeo_sensores) {
          payload.sensores.forEach((sensorRaw) => {
            const cableFisico = parseInt(sensorRaw.cable);
            const sensorConfig = configFresca.mapeo_sensores.find((s) => {
              const matchNodo = s.uid === uidNodo;
              const matchPin =
                s.pin !== undefined && parseInt(s.pin) === cableFisico - 1;
              const matchCable =
                s.cable !== undefined && parseInt(s.cable) === cableFisico;
              return matchNodo && (matchPin || matchCable);
            });

            if (!sensorConfig) return;

            // ═══ SOFT-DELETE: ignorar sensores inactivos ═══
            if (sensorConfig.is_active === false) return;

            let alertaCritica = false;
            const valorFlujo = parseFloat(sensorRaw.valor);
            const isSemilla = sensorConfig.tipo === "semilla";
            const isFerti = sensorConfig.tipo.includes("ferti");
            const rawPulsos = parseInt(sensorRaw.raw) || 0;
            const numTren = sensorConfig.tren || 1;

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
              const seccionesTren =
                numTren === 1
                  ? telemetriaAOG.seccionesT1
                  : telemetriaAOG.seccionesT2;
              const maquinaSembrando =
                seccionesTren.length > 0 ? seccionesTren.includes(1) : true;

              if (telemetriaAOG.velocidad > 1.5 && maquinaSembrando) {
                if (valorFlujo === 0) {
                  alertaCritica = true;
                } else {
                  const objetivo = _objetivoTren(numTren);
                  if (objetivo > 0 && valorFlujo < objetivo * 0.5) {
                    alertaCritica = true;
                  }
                }
              }
            } else if (
              sensorConfig.tipo === "rotacion_eje" ||
              sensorConfig.tipo === "turbina"
            ) {
              if (telemetriaAOG.velocidad > 1.5 && valorFlujo === 0)
                alertaCritica = true;
            }

            if (rawPulsos > 0) {
              console.log(
                `🎯 [EMIT] Surco: ${sensorConfig.bajada} | Flujo: ${valorFlujo.toFixed(1)} | SPM: ${semillasPorMetro.toFixed(1)}`,
              );
            }

            io.emit("sensor_update", {
              bajada: sensorConfig.bajada,
              tipo: sensorConfig.tipo,
              tren: numTren,
              valor: valorFlujo.toFixed(1),
              alerta: alertaCritica,
              nuevas_semillas: rawPulsos,
              spm: semillasPorMetro.toFixed(1),
            });

            // Grabar semilla georeferenciada
            if (seedRecorder && rawPulsos > 0 && telemetriaAOG.lat) {
              seedRecorder.append({
                bajada: sensorConfig.bajada,
                tipo: sensorConfig.tipo,
                pulsos: rawPulsos,
                spm: semillasPorMetro.toFixed(2),
                lat: telemetriaAOG.lat,
                lon: telemetriaAOG.lon,
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
