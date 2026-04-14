// ============================================================
// VistaX — server.js  (v3)
//
// CAMBIOS:
//   1. mapa_routes recibe (io, mqttHandler) para cierre centralizado
//   2. Se elimina la ruta GET /mapa (visualización → OrbitSyncX)
//   3. Se incluye firmware.routes y seeds.routes
//   4. mqttHandler expuesto en app.locals para config.routes
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const recorder = require("./core/logic/map_recorder");
const seedRecorder = require("./core/logic/seed_recorder");
const initMQTT = require("./core/logic/mqtt_handler");
const profilesManager = require("./core/database/profiles_manager");
const configRoutes = require("./routes/config.routes");
const lotesRoutes = require("./routes/lotes.routes");
const firmwareRoutes = require("./routes/firmware.routes");
const debugRoutes = require("./routes/debug.routes");
const nodosRoutes = require("./routes/nodos.routes");



const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.locals.io = io; 
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/api/debug", debugRoutes(io));
console.log(`\x1b[33m[VistaX]\x1b[0m Levantando servidor...`);
app.use("/api/nodos", nodosRoutes);
console.log("[VistaX] ✅ nodos.routes cargado");
// ══════════════════════════════════════════
// MQTT + CONFIGURACIÓN DINÁMICA
// ══════════════════════════════════════════
const mqttHandler = initMQTT(io, () => {
  const name = profilesManager.getLastProfileName();
  return (
    profilesManager.getActiveProfile(name) ||
    profilesManager.getActiveProfile("tanzi_default")
  );
});

app.locals.mqttHandler = mqttHandler;

// ══════════════════════════════════════════
// RECUPERAR LOTE ACTIVO (si el server se reinició)
// ══════════════════════════════════════════
seedRecorder.recuperarLoteActivo();

// ══════════════════════════════════════════
// RUTAS API
// ══════════════════════════════════════════
app.use("/api/config", configRoutes);
app.use("/api/lotes", lotesRoutes);
app.use("/api/firmware", firmwareRoutes);

// Mapa: recibe (io, mqttHandler) para cierre centralizado
let mapaRoutes;
try {
  const factory = require("./routes/mapa_routes");
  mapaRoutes =
    typeof factory === "function" ? factory(io, mqttHandler) : factory;
  console.log("[VistaX] ✅ mapa_routes cargado");
} catch (e) {
  console.error("[VistaX] ❌ mapa_routes:", e.message);
  mapaRoutes = require("express").Router();
}
app.use("/api/mapa", mapaRoutes);

// Semillas georeferenciadas
try {
  const seedsFactory = require("./routes/seeds.routes");
  app.use("/api/semillas", seedsFactory(io));
  console.log("[VistaX] ✅ seeds.routes cargado");
} catch (e) {
  console.warn("[VistaX] ⚠ seeds.routes:", e.message);
}

// ══════════════════════════════════════════
// VISTA PRINCIPAL (Monitor)
// ══════════════════════════════════════════
app.get("/", (req, res) => {
  const name = profilesManager.getLastProfileName();
  const config =
    profilesManager.getActiveProfile(name) ||
    profilesManager.getActiveProfile("tanzi_default") ||
    {};

  res.render("index", {
    config,
    loteActivo: mqttHandler.client?.getLoteActual?.() || null,
  });
});
app.get("/detalle-surco", (req, res) => {
  const name = profilesManager.getLastProfileName();
  const config = profilesManager.getActiveProfile(name) || {};
  res.render("detalle_surco", { config });
});
app.get("/config", (req, res) => {
  const name = profilesManager.getLastProfileName();
  const config = profilesManager.getActiveProfile(name) || {};
  res.render("config_standalone", { config });
});
app.get("/iniciar-lote", (req, res) => {
  const name = profilesManager.getLastProfileName();
  const config = profilesManager.getActiveProfile(name) || {};
  res.render("iniciar_lote_standalone", { config });
});
app.get("/bar", (req, res) => {
  const name = profilesManager.getLastProfileName();
  const config = profilesManager.getActiveProfile(name) || {};
  res.render("bar", { config });
});
app.get("/debug", (req, res) => {
  res.render("debug_monitoreo");
});
app.get("/debug-serial", (req, res) => {
  res.render("debug_serial");
});
// ══════════════════════════════════════════
// ARRANCAR
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\x1b[32m[VistaX]\x1b[0m Monitor → http://localhost:${PORT}`);
  console.log(
    `\x1b[36m[VistaX]\x1b[0m API grabado → /api/mapa  (OrbitSyncX ready)`,
  );
});
