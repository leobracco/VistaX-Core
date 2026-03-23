// ============================================================
// VistaX - routes/mapa.routes.js
// REST API para el mapa de siembra (lotes, GeoJSON, exports)
// Recibe io para emitir lote_update a todos los clientes
// ============================================================

const express  = require("express");
const path     = require("path");
const fs       = require("fs");
const recorder = require("../core/logic/map_recorder");

const LOTES_DIR = path.join(__dirname, "../data/lotes");

module.exports = (io) => {
  const router = express.Router();

  // ------------------------------------------------------------------
  // GET /api/mapa/lote-activo
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

    // Notificar a todos los clientes conectados (monitor + mapa)
    io.emit("lote_update", {
      activo:  true,
      id:      lote.id,
      nombre:  lote.nombre,
      cultivo: lote.cultivo,
    });

    res.json({ ok: true, lote });
  });

  // ------------------------------------------------------------------
  // POST /api/mapa/cerrar
  // ------------------------------------------------------------------
  router.post("/cerrar", (req, res) => {
    const resultado = recorder.cerrarLote();

    if (!resultado) {
      return res.status(400).json({ error: "No hay lote activo" });
    }

    // Notificar a todos los clientes
    io.emit("lote_update", { activo: false });

    res.json({ ok: true, ...resultado });
  });

  // ------------------------------------------------------------------
  // GET /api/mapa/geojson/live
  // ------------------------------------------------------------------
  router.get("/geojson/live", (req, res) => {
    res.json(recorder.getGeoJSONLive());
  });

  // ------------------------------------------------------------------
  // GET /api/mapa/geojson/pasadas
  // ------------------------------------------------------------------
  router.get("/geojson/pasadas", (req, res) => {
    res.json(recorder.getGeoJSONPasadas());
  });

  // ------------------------------------------------------------------
  // GET /api/mapa/historial
  // ------------------------------------------------------------------
  router.get("/historial", (req, res) => {
    res.json(recorder.listarLotes());
  });

  // ------------------------------------------------------------------
  // GET /api/mapa/geojson/:loteId
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

  return router;
};
