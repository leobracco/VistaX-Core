const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const os = require("os");
const profilesManager = require("../core/database/profiles_manager");
const { publicarConfigCables } = require("../core/logic/cable_config_publisher");

// ══════════════════════════════════════════════════════════
// PERFILES — CRUD completo para el tab Perfiles
// ══════════════════════════════════════════════════════════

// GET /api/config/perfiles — Lista detallada con metadata
router.get("/perfiles", (req, res) => {
  try {
    const perfiles = profilesManager.listProfilesDetailed();
    const activo = profilesManager.getLastProfileName();
    res.json({ ok: true, perfiles, activo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/config/perfiles/activar — Cambiar perfil activo
router.post("/perfiles/activar", (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: "Falta id" });

  const profile = profilesManager.getActiveProfile(id);
  if (!profile) return res.status(404).json({ ok: false, error: "Perfil no encontrado" });

  profilesManager.setLastProfileName(id);
  console.log(`\x1b[32m[Perfiles]\x1b[0m Perfil activado: ${id}`);

  // ── Republicar config de cables a los nodos ──
  const mqttHandler = req.app.locals.mqttHandler;
  if (mqttHandler?.recargarConfig) mqttHandler.recargarConfig();
  if (mqttHandler?.republicarConfigCables) {
    mqttHandler.republicarConfigCables();
  } else if (mqttHandler) {
    // Fallback si el handler viejo no expone la API nueva
    publicarConfigCables(mqttHandler, profile);
  }

  // Notificar a todas las ventanas (bar, monitor) que recarguen
  const io = req.app.locals.io;
  if (io) io.emit("profile_changed", { id, nombre: profile.nombre });

  res.json({ ok: true, id });
});

// POST /api/config/perfiles/nuevo — Crear perfil vacío
router.post("/perfiles/nuevo", (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ ok: false, error: "Falta nombre" });

  const id = profilesManager.createEmptyProfile(nombre.trim());
  if (!id) return res.status(409).json({ ok: false, error: "Ya existe un perfil con ese nombre" });

  console.log(`\x1b[32m[Perfiles]\x1b[0m Perfil creado: ${id}`);
  res.json({ ok: true, id });
});

// POST /api/config/perfiles/duplicar — Duplicar perfil existente
router.post("/perfiles/duplicar", (req, res) => {
  const { sourceId, nombre } = req.body;
  if (!sourceId || !nombre) return res.status(400).json({ ok: false, error: "Faltan sourceId y nombre" });

  const newId = profilesManager.duplicateProfile(sourceId, nombre.trim());
  if (!newId) return res.status(409).json({ ok: false, error: "No se pudo duplicar (origen no existe o nombre duplicado)" });

  console.log(`\x1b[32m[Perfiles]\x1b[0m Perfil duplicado: ${sourceId} → ${newId}`);
  res.json({ ok: true, id: newId });
});

// DELETE /api/config/perfiles/:id — Borrar perfil
router.delete("/perfiles/:id", (req, res) => {
  const id = req.params.id;
  const ok = profilesManager.deleteProfile(id);
  if (!ok) return res.status(400).json({ ok: false, error: "No se puede borrar (activo, bloqueado o no existe)" });

  console.log(`\x1b[31m[Perfiles]\x1b[0m Perfil borrado: ${id}`);
  res.json({ ok: true, id });
});

// POST /api/config/perfiles/lock — Toggle bloqueo
router.post("/perfiles/lock", (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: "Falta id" });

  const locked = profilesManager.toggleLockProfile(id);
  if (locked === null) return res.status(404).json({ ok: false, error: "Perfil no encontrado" });

  console.log(`\x1b[33m[Perfiles]\x1b[0m ${id} → ${locked ? "BLOQUEADO" : "DESBLOQUEADO"}`);
  res.json({ ok: true, id, locked });
});

// ══════════════════════════════════════════════════════════
// MÁQUINAS
// ══════════════════════════════════════════════════════════

router.get("/maquinas", (req, res) => {
  try {
    const lista = profilesManager.listProfiles();
    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: "Error al listar máquinas" });
  }
});

router.get("/maquinas/:id", (req, res) => {
  const profile = profilesManager.getActiveProfile(req.params.id);
  if (profile) res.json(profile);
  else res.status(404).send("Máquina no encontrada");
});

router.post("/maquinas/guardar", (req, res) => {
  const config = req.body;
  const profileId = config.id || config.nombre.toLowerCase().replace(/ /g, "_");
  config.id = profileId;

  const PROFILES_DIR = path.join(__dirname, "../data/implementos");
  fs.writeFileSync(
    path.join(PROFILES_DIR, `${profileId}.json`),
    JSON.stringify(config, null, 2),
  );

  profilesManager.setLastProfileName(profileId);
  console.log(`Configuración guardada y activada: ${profileId}`);

  // ── Republicar config de cables a los nodos ──
  const mqttHandler = req.app.locals.mqttHandler;
  if (mqttHandler?.recargarConfig) mqttHandler.recargarConfig();
  if (mqttHandler?.republicarConfigCables) {
    mqttHandler.republicarConfigCables();
  } else if (mqttHandler) {
    publicarConfigCables(mqttHandler, config);
  }

  // Notificar a todas las ventanas que recarguen
  const io = req.app.locals.io;
  if (io) io.emit("profile_changed", { id: profileId });

  res.json({ status: "ok", id: profileId });
});

// ══════════════════════════════════════════════════════════
// OTA — Envío de firmware a nodos
// ══════════════════════════════════════════════════════════

router.post("/nodos/comando-ota", (req, res) => {
  const { uid, filename } = req.body;

  if (!uid || !filename) {
    return res.status(400).json({ ok: false, error: "Faltan parámetros: uid y filename" });
  }

  const safe = filename.replace(/[^a-zA-Z0-9.\-_]/g, "");
  if (!safe.endsWith(".bin") || !safe.startsWith("VX-")) {
    return res.status(400).json({ ok: false, error: "Nombre de firmware inválido" });
  }

  const FIRMWARE_DIR = path.join(__dirname, "../public/firmware");
  const filePath = path.join(FIRMWARE_DIR, safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: `Firmware ${safe} no encontrado` });
  }

  const version = safe.replace(/^VX-/, "").replace(/\.bin$/, "");
  const PORT = process.env.PORT || 3000;
  const localIP = getLocalIP();
  const url = `http://${localIP}:${PORT}/firmware/${safe}`;
  const topic = `vistax/nodos/comando/${uid}`;
  const payload = { cmd: "ota", url, version };

  const mqttHandler = req.app.locals.mqttHandler;
  if (!mqttHandler?.publish) {
    return res.status(503).json({ ok: false, error: "MQTT no disponible" });
  }

  const enviado = mqttHandler.publish(topic, payload);
  if (enviado) {
    console.log(`\x1b[33m[OTA]\x1b[0m ► Nodo: ${uid} | ${version} | ${url}`);
    res.json({ ok: true, uid, version, url, topic });
  } else {
    res.status(503).json({ ok: false, error: "Broker MQTT no conectado" });
  }
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

// ══════════════════════════════════════════════════════════
// NODOS — Estado y comandos
// ══════════════════════════════════════════════════════════

router.get("/nodos/estado", (req, res) => {
  const mqttHandler = req.app.locals.mqttHandler;
  if (!mqttHandler?.getEstadoNodos) return res.json({ ok: true, nodos: {} });
  res.json({ ok: true, nodos: mqttHandler.getEstadoNodos() });
});

router.post("/nodos/comando", (req, res) => {
  const { uid, cmd } = req.body;
  if (!uid || !cmd) return res.status(400).json({ ok: false, error: "Faltan uid y cmd" });

  const comandosValidos = ["reiniciar", "borrar_wifi", "estado"];
  if (!comandosValidos.includes(cmd)) {
    return res.status(400).json({ ok: false, error: `Comando inválido. Válidos: ${comandosValidos.join(", ")}` });
  }

  const topic = `vistax/nodos/comando/${uid}`;
  const payload = { cmd };
  const mqttHandler = req.app.locals.mqttHandler;
  if (!mqttHandler?.publish) return res.status(503).json({ ok: false, error: "MQTT no disponible" });

  const enviado = mqttHandler.publish(topic, payload);
  if (enviado) {
    console.log(`\x1b[36m[Nodo CMD]\x1b[0m → ${uid}: ${cmd}`);
    res.json({ ok: true, uid, cmd, topic });
  } else {
    res.status(503).json({ ok: false, error: "Broker MQTT no conectado" });
  }
});

// ══════════════════════════════════════════════════════════
// CABLES CONFIG — Forzar resincronización con los nodos
// ══════════════════════════════════════════════════════════

router.post("/nodos/resync-cables", (req, res) => {
  const activo = profilesManager.getLastProfileName();
  const perfil = profilesManager.getActiveProfile(activo);

  if (!perfil) {
    return res.status(404).json({ ok: false, error: "No hay perfil activo" });
  }

  const mqttHandler = req.app.locals.mqttHandler;
  if (!mqttHandler) {
    return res.status(503).json({ ok: false, error: "MQTT no disponible" });
  }

  let resultado;
  if (mqttHandler.republicarConfigCables) {
    const ok = mqttHandler.republicarConfigCables();
    resultado = { ok, perfil: activo };
  } else {
    resultado = publicarConfigCables(mqttHandler, perfil);
  }

  console.log(`\x1b[36m[Resync]\x1b[0m Solicitado por usuario`);
  res.json(resultado);
});

module.exports = router;