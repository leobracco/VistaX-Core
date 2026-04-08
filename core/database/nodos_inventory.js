// ============================================================
// VistaX — nodos_inventory.js
//
// Gestor central del inventario de nodos ESP32.
// Mantiene un JSON único con todos los nodos vistos alguna vez,
// independiente de los perfiles de implemento.
//
// Estados (algunos calculados, otros persistidos):
//   - registrado    : el UID aparece en al menos un perfil (calculado)
//   - sin_registrar : detectado pero no aparece en ningún perfil (calculado)
//   - ignorado      : el usuario lo marcó manualmente (persistido)
//   - offline       : no envió heartbeat en los últimos N segundos (calculado)
//   - error         : no envió heartbeat en mucho tiempo (>1h) o sin firmware
// ============================================================

const fs = require("fs");
const path = require("path");
const profilesManager = require("./profiles_manager");

const INVENTORY_PATH = path.join(__dirname, "../../data/nodos_inventario.json");
const OFFLINE_TIMEOUT_MS = 60 * 1000;          // 60s sin heartbeat → offline
const ERROR_TIMEOUT_MS   = 60 * 60 * 1000;     // 1h sin heartbeat → error

// Estructura interna en memoria
let inventario = { nodos: {} };

// ── Persistencia ────────────────────────────────────────────
function _cargar() {
  try {
    if (fs.existsSync(INVENTORY_PATH)) {
      const raw = fs.readFileSync(INVENTORY_PATH, "utf-8");
      inventario = JSON.parse(raw);
      if (!inventario.nodos) inventario.nodos = {};
    }
  } catch (e) {
    console.error("[NodosInv] Error cargando inventario:", e.message);
    inventario = { nodos: {} };
  }
}

function _guardar() {
  try {
    fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventario, null, 2));
  } catch (e) {
    console.error("[NodosInv] Error guardando inventario:", e.message);
  }
}

_cargar();

// ── Helpers ─────────────────────────────────────────────────
/**
 * Devuelve la lista de IDs de perfiles que contienen este UID en su mapeo.
 */
function buscarEnPerfiles(uid) {
  const resultado = [];
  try {
    const todosLosPerfiles = profilesManager.listProfiles();
    for (const id of todosLosPerfiles) {
      const p = profilesManager.getActiveProfile(id);
      if (p?.mapeo_sensores?.some(s => s.uid === uid)) {
        resultado.push(id);
      }
    }
  } catch (e) {
    console.error("[NodosInv] Error buscando en perfiles:", e.message);
  }
  return resultado;
}

/**
 * Calcula el estado actual de un nodo en base a:
 * - su flag "ignorado" persistido
 * - su última conexión
 * - su presencia en perfiles
 */
function _calcularEstado(nodo) {
  if (nodo.ignorado) return "ignorado";

  const ahora = Date.now();
  const ultimo = nodo.ultimo_visto ? new Date(nodo.ultimo_visto).getTime() : 0;
  const sinHeartbeat = ahora - ultimo;

  if (sinHeartbeat > ERROR_TIMEOUT_MS || !nodo.firmware) return "error";

  const perfiles = buscarEnPerfiles(nodo.uid);
  const enPerfil = perfiles.length > 0;

  if (sinHeartbeat > OFFLINE_TIMEOUT_MS) {
    return enPerfil ? "offline" : "sin_registrar";
  }

  return enPerfil ? "registrado" : "sin_registrar";
}

// ── API pública ─────────────────────────────────────────────

/**
 * Inserta o actualiza un nodo desde un heartbeat MQTT.
 * Se llama desde mqtt_handler.js cuando llega vistax/nodos/registro
 * o vistax/nodos/estado.
 *
 * @param {object} payload - { uid, ip, rssi, firmware, version, capacidad_cables }
 * @returns {object} { nodo, esNuevo }
 */
function upsertFromHeartbeat(payload) {
  if (!payload?.uid) return { nodo: null, esNuevo: false };

  const uid = payload.uid;
  const ahora = new Date().toISOString();
  const existia = !!inventario.nodos[uid];

  const nodoExistente = inventario.nodos[uid] || {};

  inventario.nodos[uid] = {
    uid,
    alias:            nodoExistente.alias || "",
    ignorado:         nodoExistente.ignorado || false,
    primer_visto:     nodoExistente.primer_visto || ahora,
    ultimo_visto:     ahora,
    ip:               payload.ip       || nodoExistente.ip       || "?",
    rssi:             payload.rssi     ?? nodoExistente.rssi     ?? null,
    firmware:         payload.firmware || payload.version || nodoExistente.firmware || "?",
    capacidad_cables: payload.capacidad_cables || nodoExistente.capacidad_cables || 0,
    notas:            nodoExistente.notas || "",
  };

  _guardar();
  return { nodo: inventario.nodos[uid], esNuevo: !existia };
}

/**
 * Lista todos los nodos del inventario con su estado calculado.
 * @param {string} [filtroEstado] - opcional: "registrado" | "sin_registrar" | "ignorado" | "offline" | "error"
 */
function listAll(filtroEstado) {
  const todos = Object.values(inventario.nodos).map(n => ({
    ...n,
    estado:               _calcularEstado(n),
    perfiles_asignado:    buscarEnPerfiles(n.uid),
    online:               (Date.now() - new Date(n.ultimo_visto).getTime()) < OFFLINE_TIMEOUT_MS,
    segundos_desde_visto: Math.floor((Date.now() - new Date(n.ultimo_visto).getTime()) / 1000),
  }));

  if (filtroEstado) {
    return todos.filter(n => n.estado === filtroEstado);
  }

  // Orden: online primero, después por última conexión descendente
  return todos.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return new Date(b.ultimo_visto) - new Date(a.ultimo_visto);
  });
}

/**
 * Devuelve un nodo específico con estado calculado.
 */
function get(uid) {
  const nodo = inventario.nodos[uid];
  if (!nodo) return null;
  return {
    ...nodo,
    estado:            _calcularEstado(nodo),
    perfiles_asignado: buscarEnPerfiles(uid),
    online:            (Date.now() - new Date(nodo.ultimo_visto).getTime()) < OFFLINE_TIMEOUT_MS,
  };
}

/**
 * Borra un nodo del inventario Y de todos los perfiles que lo contengan.
 * Operación destructiva — usar con confirmación del usuario.
 */
function deleteNodo(uid) {
  if (!inventario.nodos[uid]) return { ok: false, error: "no_existe" };

  // 1. Quitar de todos los perfiles
  const perfilesAfectados = [];
  try {
    const PROFILES_DIR = path.join(__dirname, "../../data/implementos");
    const todosLosPerfiles = profilesManager.listProfiles();

    for (const id of todosLosPerfiles) {
      const p = profilesManager.getActiveProfile(id);
      if (!p?.mapeo_sensores) continue;

      const original = p.mapeo_sensores.length;
      p.mapeo_sensores = p.mapeo_sensores.filter(s => s.uid !== uid);

      if (p.mapeo_sensores.length !== original) {
        // Bloqueado: no se puede modificar
        if (p._locked) {
          console.warn(`[NodosInv] No se puede borrar ${uid} de ${id}: perfil bloqueado`);
          continue;
        }
        fs.writeFileSync(
          path.join(PROFILES_DIR, `${id}.json`),
          JSON.stringify(p, null, 2)
        );
        perfilesAfectados.push(id);
      }
    }
  } catch (e) {
    console.error("[NodosInv] Error limpiando perfiles:", e.message);
  }

  // 2. Borrar del inventario
  delete inventario.nodos[uid];
  _guardar();

  console.log(`[NodosInv] Nodo ${uid} borrado (afectó ${perfilesAfectados.length} perfil/es)`);
  return { ok: true, perfilesAfectados };
}

/**
 * Marca o desmarca un nodo como ignorado.
 */
function setIgnorado(uid, ignorado) {
  if (!inventario.nodos[uid]) {
    // Crear entrada mínima si no existe (para poder ignorar antes de que se conecte)
    inventario.nodos[uid] = {
      uid,
      alias:            "",
      ignorado:         !!ignorado,
      primer_visto:     new Date().toISOString(),
      ultimo_visto:     new Date(0).toISOString(),
      ip:               "?",
      rssi:             null,
      firmware:         "?",
      capacidad_cables: 0,
      notas:            "",
    };
  } else {
    inventario.nodos[uid].ignorado = !!ignorado;
  }
  _guardar();
  return { ok: true, uid, ignorado: !!ignorado };
}

/**
 * Cambia el alias amigable de un nodo.
 */
function setAlias(uid, alias) {
  if (!inventario.nodos[uid]) return { ok: false, error: "no_existe" };
  inventario.nodos[uid].alias = (alias || "").trim().substring(0, 64);
  _guardar();
  return { ok: true, uid, alias: inventario.nodos[uid].alias };
}

/**
 * Cambia las notas internas del nodo (texto libre).
 */
function setNotas(uid, notas) {
  if (!inventario.nodos[uid]) return { ok: false, error: "no_existe" };
  inventario.nodos[uid].notas = (notas || "").trim().substring(0, 500);
  _guardar();
  return { ok: true, uid };
}

/**
 * Devuelve solo los UIDs marcados como ignorados (uso interno desde mqtt_handler).
 */
function getUidsIgnorados() {
  return Object.values(inventario.nodos)
    .filter(n => n.ignorado)
    .map(n => n.uid);
}

/**
 * Indica si un UID está ignorado (uso interno).
 */
function estaIgnorado(uid) {
  return !!inventario.nodos[uid]?.ignorado;
}

module.exports = {
  upsertFromHeartbeat,
  listAll,
  get,
  delete: deleteNodo,
  setIgnorado,
  setAlias,
  setNotas,
  buscarEnPerfiles,
  getUidsIgnorados,
  estaIgnorado,
};