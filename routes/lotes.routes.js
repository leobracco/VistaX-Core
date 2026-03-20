const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const LOTES_DIR = path.join(__dirname, "../data/lotes");

// Listar historial de lotes
router.get("/historial", (req, res) => {
  const archivos = fs.readdirSync(LOTES_DIR);
  const lotes = archivos.map((file) => {
    const stats = fs.statSync(path.join(LOTES_DIR, file));
    return { nombre: file.replace(".json", ""), fecha: stats.mtime };
  });
  res.json(lotes);
});

// Iniciar un nuevo lote (Limpiar acumuladores)
router.post("/nuevo", (req, res) => {
  const { nombreLote, cultivo } = req.body;
  // Lógica para cerrar el anterior y preparar el nuevo
  res.json({ status: "ok", lote: nombreLote });
});

module.exports = router;
