// ============================================================
// VistaX - routes/mapa.routes.js
// REST API para el mapa de siembra (lotes, GeoJSON, exports)
// ============================================================

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const recorder = require("../core/logic/map_recorder");

const LOTES_DIR = path.join(__dirname, "../data/lotes");

// ------------------------------------------------------------------
// GET /api/mapa/lote-activo
// Estado del lote activo (para el footer y el mapa en vivo)
// ------------------------------------------------------------------
router.get("/lote-activo", (req, res) => {
  const lote = recorder.getLoteActivo();
  res.json(lote || { activo: false });
});

// ------------------------------------------------------------------
// POST /api/mapa/iniciar
// Body: { nombre, cultivo, anchoPasada }
// ------------------------------------------------------------------
router.post("/iniciar", (req, res) => {
  const { nombre, cultivo, anchoPasada } = req.body;

  if (!nombre || !cultivo) {
    return res.status(400).json({ error: "nombre y cultivo son requeridos" });
  }

  const lote = recorder.iniciarLote(nombre, cultivo, anchoPasada);
  res.json({ ok: true, lote });
});

// ------------------------------------------------------------------
// POST /api/mapa/cerrar
// Cierra el lote activo y genera el GeoJSON
// ------------------------------------------------------------------
router.post("/cerrar", (req, res) => {
  const resultado = recorder.cerrarLote();
  if (!resultado) {
    return res.status(400).json({ error: "No hay lote activo" });
  }
  res.json({ ok: true, ...resultado });
});

// ------------------------------------------------------------------
// GET /api/mapa/geojson/live
// GeoJSON de puntos del lote activo (para el mapa en vivo)
// ------------------------------------------------------------------
router.get("/geojson/live", (req, res) => {
  res.json(recorder.getGeoJSONLive());
});

// ------------------------------------------------------------------
// GET /api/mapa/geojson/pasadas
// GeoJSON de líneas del lote activo (pasadas)
// ------------------------------------------------------------------
router.get("/geojson/pasadas", (req, res) => {
  res.json(recorder.getGeoJSONPasadas());
});

// ------------------------------------------------------------------
// GET /api/mapa/historial
// Lista todos los lotes grabados
// ------------------------------------------------------------------
router.get("/historial", (req, res) => {
  res.json(recorder.listarLotes());
});

// ------------------------------------------------------------------
// GET /api/mapa/geojson/:loteId
// GeoJSON de un lote cerrado
// ------------------------------------------------------------------
router.get("/geojson/:loteId", (req, res) => {
  const geojson = recorder.cargarGeoJSONLote(req.params.loteId);
  if (!geojson) {
    return res.status(404).json({ error: "Lote no encontrado o sin GeoJSON" });
  }
  res.json(geojson);
});

// ------------------------------------------------------------------
// GET /api/mapa/export/:loteId
// Descarga el .geojson como archivo
// ------------------------------------------------------------------
router.get("/export/:loteId", (req, res) => {
  const filePath = path.join(LOTES_DIR, `${req.params.loteId}.geojson`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Archivo no encontrado" });
  }
  res.download(filePath, `${req.params.loteId}.geojson`);
});

module.exports = router;
