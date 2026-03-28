// ============================================================
// VistaX - routes/mapa_routes.js  (v3 — fix cierre lote)
//
// FIX: Ahora iniciar/cerrar lote usa las funciones centralizadas
//      del mqttHandler que SIEMPRE emiten lote_update por socket.
//      Antes, si se cerraba desde CoreX o desde la UI REST,
//      el io.emit no llegaba porque mapa_routes.js tenía su
//      propia lógica desacoplada.
// ============================================================

const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const recorder   = require("../core/logic/map_recorder");
const seedRecorder = require("../core/logic/seed_recorder");
const LOTES_DIR  = path.join(__dirname, "../data/lotes");

module.exports = (io, mqttHandler) => {
  const router = express.Router();

  // GET /api/mapa/lote-activo
  router.get("/lote-activo", (req, res) => {
    const lote = recorder.getLoteActivo();
    res.json(lote || { activo: false });
  });

  // POST /api/mapa/iniciar
  router.post("/iniciar", (req, res) => {
    const { nombre, cultivo, variedad, estab, anchoPasada } = req.body;
    if (!nombre || !cultivo) {
      return res.status(400).json({ error: "nombre y cultivo son requeridos" });
    }

    // Usar la función centralizada que EMITE lote_update
    if (mqttHandler?.iniciarLoteDesdeRuta) {
      const lote = mqttHandler.iniciarLoteDesdeRuta(nombre, cultivo, { variedad, estab, anchoPasada });
      return res.json({ ok: true, lote });
    }

    // Fallback si mqttHandler no tiene la función (compatibilidad)
    const lote = recorder.iniciarLote(nombre, cultivo, anchoPasada, { variedad, estab });
    seedRecorder.iniciarLote(lote.id, nombre);
    io.emit("lote_update", { activo: true, id: lote.id, nombre: lote.nombre, cultivo: lote.cultivo });
    res.json({ ok: true, lote });
  });

  // POST /api/mapa/cerrar
  router.post("/cerrar", (req, res) => {
    // Usar la función centralizada que EMITE lote_update
    if (mqttHandler?.cerrarLoteDesdeRuta) {
      const resultado = mqttHandler.cerrarLoteDesdeRuta();
      if (!resultado) return res.status(400).json({ error: "No hay lote activo" });
      return res.json({ ok: true, ...resultado });
    }

    // Fallback
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

  // GET /api/mapa/historial
  router.get("/historial", (req, res) => {
    res.json(recorder.listarLotes());
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

  // DELETE /api/mapa/lote/:loteId
  router.delete("/lote/:loteId", (req, res) => {
    const id   = req.params.loteId.replace(/[^a-z0-9_]/gi, "");
    const json = path.join(LOTES_DIR, `${id}.json`);
    const geo  = path.join(LOTES_DIR, `${id}.geojson`);
    const jsonl = path.join(LOTES_DIR, `${id}_semillas.jsonl`);
    const sgeo  = path.join(LOTES_DIR, `${id}_semillas.geojson`);
    const meta  = path.join(LOTES_DIR, `${id}_meta.json`);
    let borrados = 0;
    [json, geo, jsonl, sgeo, meta].forEach(f => {
      if (fs.existsSync(f)) { fs.unlinkSync(f); borrados++; }
    });
    if (!borrados) return res.status(404).json({ error: "Lote no encontrado" });
    res.json({ ok: true, id });
  });

  return router;
};
