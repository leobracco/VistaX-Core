// ============================================================
// VistaX — routes/seeds.routes.js
// API REST para semillas georeferenciadas
// POST /api/semillas/iniciar   — inicia grabación de semillas
// POST /api/semillas/cerrar    — cierra y genera GeoJSON
// GET  /api/semillas/stats     — estadísticas del lote activo
// GET  /api/semillas/geojson/:loteId — descarga GeoJSON
// ============================================================

const express      = require("express");
const path         = require("path");
const fs           = require("fs");
const seedRecorder = require("../core/logic/seed_recorder");

const LOTES_DIR = path.join(__dirname, "../data/lotes");

module.exports = (io) => {
  const router = express.Router();

  // ------------------------------------------------------------------
  // POST /api/semillas/iniciar
  // Body: { loteId, nombre }
  // Se llama al mismo tiempo que /api/mapa/iniciar
  // ------------------------------------------------------------------
  router.post("/iniciar", (req, res) => {
    const { loteId, nombre } = req.body;

    if (!loteId || !nombre) {
      return res.status(400).json({ error: "loteId y nombre son requeridos" });
    }

    seedRecorder.iniciarLote(loteId, nombre);

    io.emit("seeds_lote_iniciado", { loteId, nombre });
    res.json({ ok: true, loteId, nombre });
  });

  // ------------------------------------------------------------------
  // POST /api/semillas/cerrar
  // ------------------------------------------------------------------
  router.post("/cerrar", (req, res) => {
    const resultado = seedRecorder.cerrarLote();

    if (!resultado) {
      return res.status(400).json({ error: "No hay lote de semillas activo" });
    }

    io.emit("seeds_lote_cerrado", {
      loteId:        resultado.loteTerminado.id,
      totalSemillas: resultado.loteTerminado.totalSemillas,
    });

    res.json({ ok: true, ...resultado });
  });

  // ------------------------------------------------------------------
  // GET /api/semillas/stats
  // ------------------------------------------------------------------
  router.get("/stats", (req, res) => {
    const stats = seedRecorder.getEstadisticas();
    res.json(stats || { activo: false });
  });

  // ------------------------------------------------------------------
  // GET /api/semillas/geojson/:loteId
  // ------------------------------------------------------------------
  router.get("/geojson/:loteId", (req, res) => {
    const geojson = seedRecorder.cargarGeoJSON(req.params.loteId);
    if (!geojson) {
      return res.status(404).json({ error: "GeoJSON de semillas no encontrado" });
    }
    res.json(geojson);
  });

  // ------------------------------------------------------------------
  // GET /api/semillas/export/:loteId
  // Descarga el .geojson de semillas
  // ------------------------------------------------------------------
  router.get("/export/:loteId", (req, res) => {
    const filePath = path.join(LOTES_DIR, `${req.params.loteId}_semillas.geojson`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Archivo no encontrado" });
    }
    res.download(filePath, `${req.params.loteId}_semillas.geojson`);
  });

  return router;
};
