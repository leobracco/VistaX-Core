const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const os = require("os");
const profilesManager = require("../core/database/profiles_manager");

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
  res.json({ status: "ok", id: profileId });
});

// ══════════════════════════════════════════════════════════
// POST /api/config/nodos/comando-ota
// Body: { uid: "VX-XXXX", filename: "VX-v1.3.0.bin" }
// Construye la URL automáticamente y publica por MQTT
// ══════════════════════════════════════════════════════════
router.post("/nodos/comando-ota", (req, res) => {
  const { uid, filename } = req.body;

  if (!uid || !filename) {
    return res.status(400).json({
      ok: false,
      error: "Faltan parámetros: uid y filename son obligatorios",
    });
  }

  // Validar nombre seguro
  const safe = filename.replace(/[^a-zA-Z0-9.\-_]/g, "");
  if (!safe.endsWith(".bin") || !safe.startsWith("VX-")) {
    return res.status(400).json({ ok: false, error: "Nombre de firmware inválido" });
  }

  // Verificar que el archivo existe físicamente
  // Misma ruta que usa firmware.routes.js
  const FIRMWARE_DIR = path.join(__dirname, "../public/firmware");
  const filePath = path.join(FIRMWARE_DIR, safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      ok: false,
      error: `Firmware ${safe} no encontrado en el servidor`,
    });
  }

  // Extraer versión del nombre: VX-v1.3.0.bin → v1.3.0
  const version = safe.replace(/^VX-/, "").replace(/\.bin$/, "");

  // Construir URL con la IP local (visible desde el ESP32 en la misma red)
  const PORT = process.env.PORT || 3000;
  const localIP = getLocalIP();
  const url = `http://${localIP}:${PORT}/firmware/${safe}`;

  const topic = `vistax/nodos/comando/${uid}`;
  const payload = { cmd: "ota", url, version };

  const mqttHandler = req.app.locals.mqttHandler;
  if (!mqttHandler?.publish) {
    return res.status(503).json({ ok: false, error: "MQTT no disponible en app.locals" });
  }

  const enviado = mqttHandler.publish(topic, payload);

  if (enviado) {
    console.log(`\x1b[33m[OTA]\x1b[0m ► Nodo: ${uid} | ${version} | ${url}`);
    res.json({ ok: true, uid, version, url, topic });
  } else {
    res.status(503).json({ ok: false, error: "Broker MQTT no conectado" });
  }
});

// ── Obtener IP local de la PC (la que ve el ESP32) ────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

module.exports = router;

// ══════════════════════════════════════════════════════════
// GET /api/config/nodos/estado
// Devuelve el estado en memoria de todos los nodos
// ══════════════════════════════════════════════════════════
router.get("/nodos/estado", (req, res) => {
    const mqttHandler = req.app.locals.mqttHandler;
    if (!mqttHandler?.getEstadoNodos) {
        return res.json({ ok: true, nodos: {} });
    }
    res.json({ ok: true, nodos: mqttHandler.getEstadoNodos() });
});

// ══════════════════════════════════════════════════════════
// POST /api/config/nodos/comando
// Body: { uid, cmd } — cmd: "reiniciar" | "borrar_wifi" | "estado"
// ══════════════════════════════════════════════════════════
router.post("/nodos/comando", (req, res) => {
    const { uid, cmd } = req.body;

    if (!uid || !cmd) {
        return res.status(400).json({ ok: false, error: "Faltan uid y cmd" });
    }

    const comandosValidos = ["reiniciar", "borrar_wifi", "estado"];
    if (!comandosValidos.includes(cmd)) {
        return res.status(400).json({ ok: false, error: `Comando inválido. Válidos: ${comandosValidos.join(", ")}` });
    }

    const topic   = `vistax/nodos/comando/${uid}`;
    const payload = { cmd };

    const mqttHandler = req.app.locals.mqttHandler;
    if (!mqttHandler?.publish) {
        return res.status(503).json({ ok: false, error: "MQTT no disponible" });
    }

    const enviado = mqttHandler.publish(topic, payload);
    if (enviado) {
        console.log(`\x1b[36m[Nodo CMD]\x1b[0m → ${uid}: ${cmd}`);
        res.json({ ok: true, uid, cmd, topic });
    } else {
        res.status(503).json({ ok: false, error: "Broker MQTT no conectado" });
    }
});
