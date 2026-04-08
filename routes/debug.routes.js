// ============================================================
// routes/debug.routes.js — Simuladores de triggers
// Solo para desarrollo/testing. Emiten eventos Socket.IO
// como si vinieran del MQTT real.
// ============================================================

const express = require("express");

module.exports = (io) => {
  const router = express.Router();

  // ── T2: Simular AOG Bridge pintando ──
  router.post("/simular-bridge", (req, res) => {
    const { painting, fieldName } = req.body;

    io.emit("field_status", {
      painting: !!painting,
      fieldName: fieldName || "Debug Field",
      ts: Date.now(),
    });

    console.log(`\x1b[33m[DEBUG]\x1b[0m Bridge simulado: painting=${painting} field="${fieldName}"`);
    res.json({ ok: true, painting, fieldName });
  });

  // ── T3: Simular caída de semilla en N bajadas ──
  router.post("/simular-semilla", (req, res) => {
    const cantBajadas = parseInt(req.body.cantBajadas) || 3;

    // Emitir sensor_update para cada bajada simulada
    for (let i = 1; i <= cantBajadas; i++) {
      io.emit("sensor_update", {
        bajada: i,
        tipo: "semilla",
        tren: i <= 22 ? 2 : 1,
        valor: (12 + Math.random() * 8).toFixed(1),
        alerta: false,
        nuevas_semillas: Math.floor(3 + Math.random() * 5),
        spm: (14 + Math.random() * 4).toFixed(1),
        seccion_cortada: false,
      });
    }

    console.log(`\x1b[33m[DEBUG]\x1b[0m Semilla simulada: ${cantBajadas} bajadas`);
    res.json({ ok: true, cantBajadas });
  });

  // ── T4: Simular herramienta baja/sube ──
  router.post("/simular-herramienta", (req, res) => {
    const abajo = !!req.body.abajo;

    io.emit("sensor_update", {
      bajada: 1,
      tipo: "bajada_herramienta",
      tren: 1,
      valor: abajo ? "1" : "0",
      alerta: false,
      nuevas_semillas: 0,
      spm: "0",
      seccion_cortada: false,
    });

    console.log(`\x1b[33m[DEBUG]\x1b[0m Herramienta simulada: ${abajo ? "BAJA" : "SUBE"}`);
    res.json({ ok: true, abajo });
  });

  // ── Simular velocidad ──
  router.post("/simular-velocidad", (req, res) => {
    const vel = parseFloat(req.body.velocidad) || 0;

    io.emit("global_update", { velocidad: vel, promedio: "0.0" });

    console.log(`\x1b[33m[DEBUG]\x1b[0m Velocidad simulada: ${vel} km/h`);
    res.json({ ok: true, velocidad: vel });
  });

  // ── Simular secciones ──
  router.post("/simular-secciones", (req, res) => {
    const t1 = req.body.t1 || [];
    const t2 = req.body.t2 || [];

    io.emit("sections_update", { t1, t2 });

    console.log(`\x1b[33m[DEBUG]\x1b[0m Secciones simuladas: T1=[${t1}] T2=[${t2}]`);
    res.json({ ok: true, t1, t2 });
  });

  return router;
};
