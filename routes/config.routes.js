const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
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

// NUEVO: Ruta para guardar la configuración recibida del Modal
router.post("/maquinas/guardar", (req, res) => {
  const config = req.body;
  // Si no tiene ID, le generamos uno basado en el nombre (ej: "Tanzi 48" -> "tanzi_48")
  const profileId = config.id || config.nombre.toLowerCase().replace(/ /g, "_");
  config.id = profileId;

  // 1. Guardar el archivo JSON de la sembradora
  const PROFILES_DIR = path.join(__dirname, "../data/implementos");
  fs.writeFileSync(
    path.join(PROFILES_DIR, `${profileId}.json`),
    JSON.stringify(config, null, 2),
  );

  // 2. Establecerla como la última usada
  profilesManager.setLastProfileName(profileId);

  console.log(`Configuración guardada y activada: ${profileId}`);
  res.json({ status: "ok", id: profileId });
});

module.exports = router;
