const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const recorder = require("./core/logic/map_recorder");
// Importación de lógica y rutas
const initMQTT = require("./core/logic/mqtt_handler");
const profilesManager = require("./core/database/profiles_manager");
const configRoutes = require("./routes/config.routes");
const lotesRoutes = require("./routes/lotes.routes");

const iniciarSimulador = require("./simulador");

const mapaRoutes = require("./routes/mapa.routes");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

console.log(`\x1b[33m[VistaX]\x1b[0m Levantando servidor...`);

// ==========================================
// INICIALIZACIÓN MQTT CON CONFIGURACIÓN DINÁMICA
// ==========================================
// Le pasamos una FUNCIÓN en lugar de un objeto fijo.
// Así, cada vez que llegue un dato de los sensores, buscará la configuración más fresca.
const mqttHandler = initMQTT(io, () => {
  let activeProfileName = profilesManager.getLastProfileName();
  let currentConfig = profilesManager.getActiveProfile(activeProfileName);

  // Si el archivo fue borrado por error, cargamos el default
  if (!currentConfig) {
    currentConfig = profilesManager.getActiveProfile("tanzi_default");
  }
  return currentConfig;
});

// Rutas
app.use("/api/config", configRoutes);
app.use("/api/lotes", lotesRoutes);
app.use("/api/mapa", mapaRoutes);

// Y agregar la ruta de la vista del mapa:
app.get("/mapa", (req, res) => {
  let activeProfileName = profilesManager.getLastProfileName();
  let machineConfig =
    profilesManager.getActiveProfile(activeProfileName) ||
    profilesManager.getActiveProfile("tanzi_default") ||
    {};

  res.render("mapa", {
    config: machineConfig,
    loteActivo: recorder.getLoteActivo() || null,
  });
});
app.get("/", (req, res) => {
  let activeProfileName = profilesManager.getLastProfileName();
  let machineConfig =
    profilesManager.getActiveProfile(activeProfileName) ||
    profilesManager.getActiveProfile("tanzi_default");

  res.render("index", {
    config: machineConfig,
    loteActivo: recorder.getLoteActivo() || null, // <-- agregar esto
  });
});

// iniciarSimulador(io, () => profilesManager.getActiveProfile(profilesManager.getLastProfileName()));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(
    `\x1b[32m[VistaX]\x1b[0m Monitor corriendo en http://localhost:${PORT}`,
  );
});
