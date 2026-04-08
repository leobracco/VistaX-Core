// ============================================================
// VistaX — nodos.routes.js
//
// API REST del panel de Nodos.
// Montar en server.js: app.use("/api/nodos", nodosRoutes);
// ============================================================

const express = require("express");
const router  = express.Router();
const nodosInventory = require("../core/database/nodos_inventory");

// ── GET /api/nodos — Lista completa con estado y filtro opcional ──
router.get("/", (req, res) => {
  try {
    const filtro = req.query.estado;
    const nodos = nodosInventory.listAll(filtro);
    res.json({ ok: true, nodos, total: nodos.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/nodos/:uid — Detalle de un nodo ──
router.get("/:uid", (req, res) => {
  const nodo = nodosInventory.get(req.params.uid);
  if (!nodo) return res.status(404).json({ ok: false, error: "no_existe" });
  res.json({ ok: true, nodo });
});

// ── DELETE /api/nodos/:uid — Borrar de inventario y perfiles ──
router.delete("/:uid", (req, res) => {
  const result = nodosInventory.delete(req.params.uid);
  if (!result.ok) return res.status(400).json(result);

  // Notificar a todas las ventanas que el inventario cambió
  const io = req.app.locals.io;
  if (io) io.emit("nodos_inventario_changed");

  res.json(result);
});

// ── PATCH /api/nodos/:uid — Editar alias / ignorado / notas ──
router.patch("/:uid", (req, res) => {
  const { uid } = req.params;
  const { alias, ignorado, notas } = req.body;

  const cambios = {};
  if (alias !== undefined)    cambios.alias    = nodosInventory.setAlias(uid, alias);
  if (ignorado !== undefined) cambios.ignorado = nodosInventory.setIgnorado(uid, ignorado);
  if (notas !== undefined)    cambios.notas    = nodosInventory.setNotas(uid, notas);

  const io = req.app.locals.io;
  if (io) io.emit("nodos_inventario_changed");

  res.json({ ok: true, uid, cambios });
});

// ── POST /api/nodos/:uid/comando — Reiniciar / borrar_wifi / etc ──
router.post("/:uid/comando", (req, res) => {
  const { uid } = req.params;
  const { cmd } = req.body;

  const comandosValidos = ["reiniciar", "borrar_wifi", "estado"];
  if (!comandosValidos.includes(cmd)) {
    return res.status(400).json({ ok: false, error: `Comando inválido. Válidos: ${comandosValidos.join(", ")}` });
  }

  const mqttHandler = req.app.locals.mqttHandler;
  if (!mqttHandler?.publish) {
    return res.status(503).json({ ok: false, error: "MQTT no disponible" });
  }

  const enviado = mqttHandler.publish(`vistax/nodos/comando/${uid}`, { cmd });
  if (!enviado) {
    return res.status(503).json({ ok: false, error: "Broker MQTT no conectado" });
  }

  console.log(`\x1b[36m[Nodos]\x1b[0m → ${uid}: ${cmd}`);
  res.json({ ok: true, uid, cmd });
});

// ── GET /api/nodos/:uid/perfiles — Qué perfiles contienen este nodo ──
router.get("/:uid/perfiles", (req, res) => {
  const perfiles = nodosInventory.buscarEnPerfiles(req.params.uid);
  res.json({ ok: true, uid: req.params.uid, perfiles });
});

module.exports = router;