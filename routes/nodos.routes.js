// ════════════════════════════════════════════════════════════════
// PARCHE 3: nodos_routes.js — VALIDAR IMPORTS Y LOGS
// 
// PROBLEMA: GET /api/nodos devuelve vacío
// SOLUCIÓN: Verificar require() correcto y añadir diagnostics
// ════════════════════════════════════════════════════════════════

const express = require("express");
const router  = express.Router();

// ▶ CRÍTICO: Este require DEBE existir y funcionar
let nodosInventory;
try {
  nodosInventory = require("../core/database/nodos_inventory");
  console.log(`\x1b[32m[Nodos Routes]\x1b[0m ✅ nodos_inventory cargado`);
} catch (e) {
  console.error(`\x1b[31m[Nodos Routes]\x1b[0m ❌ ERROR CARGANDO nodos_inventory:`, e.message);
  console.error("   Ruta intenta: ../core/database/nodos_inventory");
  console.error("   Asegurate que existe: vistax-server/core/database/nodos_inventory.js");
  nodosInventory = {
    listAll: () => [],
    get: () => null,
    delete: () => ({ ok: false }),
    setIgnorado: () => ({}),
    setAlias: () => ({}),
    setNotas: () => ({})
  };
}

// ── GET /api/nodos — Lista completa con estado ──
router.get("/", (req, res) => {
  try {
    const filtro = req.query.estado;
    const nodos = nodosInventory.listAll(filtro);
    
    // ▶ DEBUG: Loguear si está vacío
    if (!nodos || nodos.length === 0) {
      console.log(`\x1b[33m[Nodos]\x1b[0m ⚠️ GET /api/nodos devolvió vacío (filtro: ${filtro || "ninguno"})`);
      console.log(`       → Ejecutar en servidor: node DIAGNOSTICO_3_BUGS.js`);
    }
    
    res.json({ ok: true, nodos, total: nodos.length });
  } catch (err) {
    console.error("[Nodos] Error en GET /:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/nodos/:uid — Detalle de un nodo ──
router.get("/:uid", (req, res) => {
  try {
    const nodo = nodosInventory.get(req.params.uid);
    if (!nodo) {
      return res.status(404).json({ ok: false, error: "no_existe" });
    }
    res.json({ ok: true, nodo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/nodos/:uid ──
router.delete("/:uid", (req, res) => {
  try {
    const result = nodosInventory.delete(req.params.uid);
    if (!result.ok) {
      return res.status(400).json(result);
    }

    const io = req.app.locals.io;
    if (io) io.emit("nodos_inventario_changed");

    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PATCH /api/nodos/:uid ──
router.patch("/:uid", (req, res) => {
  try {
    const { uid } = req.params;
    const { alias, ignorado, notas } = req.body;

    const cambios = {};
    if (alias !== undefined)    cambios.alias    = nodosInventory.setAlias(uid, alias);
    if (ignorado !== undefined) cambios.ignorado = nodosInventory.setIgnorado(uid, ignorado);
    if (notas !== undefined)    cambios.notas    = nodosInventory.setNotas(uid, notas);

    const io = req.app.locals.io;
    if (io) io.emit("nodos_inventario_changed");

    res.json({ ok: true, uid, cambios });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/nodos/:uid/comando ──
router.post("/:uid/comando", (req, res) => {
  try {
    const { uid } = req.params;
    const { cmd } = req.body;

    const comandosValidos = ["reiniciar", "borrar_wifi", "estado"];
    if (!comandosValidos.includes(cmd)) {
      return res.status(400).json({ 
        ok: false, 
        error: `Comando inválido. Válidos: ${comandosValidos.join(", ")}` 
      });
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
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/nodos/:uid/perfiles ──
router.get("/:uid/perfiles", (req, res) => {
  try {
    const perfiles = nodosInventory.buscarEnPerfiles(req.params.uid);
    res.json({ ok: true, uid: req.params.uid, perfiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
router.post("/:uidViejo/reemplazar", (req, res) => {
  try {
    const { uidViejo } = req.params;
    const { uidNuevo, heredarAlias, heredarNotas } = req.body;
 
    if (!uidNuevo) {
      return res.status(400).json({ ok: false, error: "Falta uidNuevo" });
    }
 
    const result = nodosInventory.reemplazarNodo(uidViejo, uidNuevo, {
      heredarAlias: !!heredarAlias,
      heredarNotas: !!heredarNotas,
    });
 
    if (!result.ok) return res.status(400).json(result);
 
    // Republicar config de cables porque los UIDs cambiaron en el perfil
    const mqttHandler = req.app.locals.mqttHandler;
    if (mqttHandler?.republicarConfigCables) {
      try { mqttHandler.republicarConfigCables(); }
      catch (e) { console.warn("[Nodos] republicar cables:", e.message); }
    }
 
    const io = req.app.locals.io;
    if (io) {
      io.emit("nodos_inventario_changed");
      io.emit("config_saved");
    }
 
    console.log(`\x1b[33m[Nodos]\x1b[0m Reemplazo: ${uidViejo} → ${uidNuevo}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
module.exports = router;