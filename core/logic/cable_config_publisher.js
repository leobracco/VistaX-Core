// ============================================================
// VistaX — cable_config_publisher.js
//
// Publica vía MQTT (retained) la configuración de modos de cable
// para cada nodo ESP32, derivada del perfil de implemento activo.
//
// Modos:
//   - "pulse" → cuenta interrupciones (semilla, ferti, turbina, RPM)
//   - "state" → lectura digital con debounce (herramienta, tolva)
//
// El nodo recibe el mensaje, persiste en LittleFS y reconfigura
// los pines en caliente. Como es retained, los nodos que se
// reinicien lo reciben automáticamente al reconectar.
// ============================================================

// Tipos que requieren modo STATE en el ESP32
const TIPOS_STATE = new Set([
  "bajada_herramienta",
  "tolva_vacia",
  "tolva_llena",
  "presion",
  "final_carrera",
]);

function tipoAModo(tipo) {
  return TIPOS_STATE.has(tipo) ? "state" : "pulse";
}

/**
 * Publica la config de cables a TODOS los nodos del perfil.
 * @param {object} mqttHandler  el handler de mqtt_handler.js
 * @param {object} perfil       el JSON del perfil de implemento
 */
function publicarConfigCables(mqttHandler, perfil) {
  if (!mqttHandler?.publish) {
    console.warn("\x1b[33m[CFG-CABLES]\x1b[0m mqttHandler no disponible");
    return { ok: false, error: "mqtt_no_disponible" };
  }

  if (!perfil?.mapeo_sensores || !Array.isArray(perfil.mapeo_sensores)) {
    console.warn("\x1b[33m[CFG-CABLES]\x1b[0m Perfil sin mapeo_sensores");
    return { ok: false, error: "perfil_sin_mapeo" };
  }

  // Agrupar sensores por UID de nodo
  const porNodo = {};
  for (const s of perfil.mapeo_sensores) {
    if (!s.uid || !s.cable) continue;
    if (s.is_active === false) continue; // ignorar sensores soft-deleted

    if (!porNodo[s.uid]) porNodo[s.uid] = [];
    porNodo[s.uid].push({
      cable:     parseInt(s.cable),
      modo:      tipoAModo(s.tipo),
      invertido: s.logica_invertida || false,
    });
  }

  const resultados = [];
  for (const [uid, cables] of Object.entries(porNodo)) {
    const topic   = `vistax/nodos/${uid}/cables/config`;
    const payload = { cables };
    const enviado = mqttHandler.publish(topic, payload, { qos: 1, retain: true });

    if (enviado) {
      const resumen = cables
        .map(c => `c${c.cable}:${c.modo}${c.invertido ? "↯" : ""}`)
        .join(" ");
      console.log(
        `\x1b[36m[CFG-CABLES]\x1b[0m → ${uid} (${cables.length} cables): ${resumen}`
      );
      resultados.push({ uid, ok: true, cables: cables.length });
    } else {
      console.warn(`\x1b[33m[CFG-CABLES]\x1b[0m ⚠ falló envío a ${uid}`);
      resultados.push({ uid, ok: false });
    }
  }

  return { ok: true, nodos: resultados };
}

module.exports = { publicarConfigCables, tipoAModo };