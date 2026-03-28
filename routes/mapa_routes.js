// ============================================================
// VistaX - routes/mapa.routes.js
// ============================================================
const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const recorder   = require("../core/logic/map_recorder");
const seedRecorder = require("../core/logic/seed_recorder");
const LOTES_DIR  = path.join(__dirname, "../data/lotes");

module.exports = (io) => {
  const router = express.Router();

  // GET /api/mapa/lote-activo
  router.get("/lote-activo", (req, res) => {
    res.json(recorder.getLoteActivo() || { activo: false });
  });

  // POST /api/mapa/iniciar
  router.post("/iniciar", (req, res) => {
    const { nombre, cultivo, anchoPasada } = req.body;
    if (!nombre || !cultivo) {
      return res.status(400).json({ error: "nombre y cultivo son requeridos" });
    }
    const lote = recorder.iniciarLote(nombre, cultivo, anchoPasada);
    seedRecorder.iniciarLote(lote.id, nombre);
    io.emit("lote_update", { activo: true, id: lote.id, nombre: lote.nombre, cultivo: lote.cultivo });
    res.json({ ok: true, lote });
  });

  // POST /api/mapa/cerrar
  router.post("/cerrar", (req, res) => {
    const resultado = recorder.cerrarLote();
    seedRecorder.cerrarLote();
    if (!resultado) return res.status(400).json({ error: "No hay lote activo" });
    io.emit("lote_update", { activo: false });
    res.json({ ok: true, ...resultado });
  });

  // GET /api/mapa/geojson/live
  router.get("/geojson/live", (req, res) => {
    res.json(recorder.getGeoJSONLive());
  });

  // GET /api/mapa/geojson/pasadas
  router.get("/geojson/pasadas", (req, res) => {
    res.json(recorder.getGeoJSONPasadas());
  });

  // GET /api/mapa/historial?page=0&limit=10
  router.get("/historial", (req, res) => {
    const page  = parseInt(req.query.page)  || 0;
    const limit = parseInt(req.query.limit) || 10;
    res.json(recorder.listarLotes(page, limit));
  });

  // GET /api/mapa/geojson/:loteId
  router.get("/geojson/:loteId", (req, res) => {
    const geojson = recorder.cargarGeoJSONLote(req.params.loteId);
    if (!geojson) return res.status(404).json({ error: "Lote no encontrado o sin GeoJSON" });
    res.json(geojson);
  });

  // GET /api/mapa/export/:loteId
  router.get("/export/:loteId", (req, res) => {
    const filePath = path.join(LOTES_DIR, `${req.params.loteId}.geojson`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Archivo no encontrado" });
    res.download(filePath, `${req.params.loteId}.geojson`);
  });

  // DELETE /api/mapa/lote/:loteId — eliminar lote del historial
  router.delete("/lote/:loteId", (req, res) => {
    const id   = req.params.loteId.replace(/[^a-z0-9_]/gi, "");
    const json = path.join(LOTES_DIR, `${id}.json`);
    const geo  = path.join(LOTES_DIR, `${id}.geojson`);
    let borrados = 0;
    if (fs.existsSync(json))  { fs.unlinkSync(json);  borrados++; }
    if (fs.existsSync(geo))   { fs.unlinkSync(geo);   borrados++; }
    if (!borrados) return res.status(404).json({ error: "Lote no encontrado" });
    res.json({ ok: true, id });
  });

  return router;
};
