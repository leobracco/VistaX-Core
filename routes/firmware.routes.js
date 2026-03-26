// ══════════════════════════════════════════════════════════
// routes/firmware.routes.js
// Maneja subida, listado y descarga de firmwares .bin
// ══════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const FIRMWARE_DIR = path.join("./public/firmware/");

// Crear directorio si no existe
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

// ── Multer: solo acepta .bin con nombre VX-*.bin ──────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FIRMWARE_DIR),
  filename: (req, file, cb) => {
    // Sanitizar: solo letras, números, guiones y puntos
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "");
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB máx (ESP32 flash)
  fileFilter: (req, file, cb) => {
    // Solo .bin cuyo nombre empiece con VX-
    if (!file.originalname.endsWith(".bin")) {
      return cb(new Error("Solo se aceptan archivos .bin"));
    }
    if (!file.originalname.startsWith("VX-")) {
      return cb(
        new Error("El nombre debe comenzar con VX- (ej: VX-1.2.0.bin)"),
      );
    }
    cb(null, true);
  },
});

// ── GET /api/firmware — listar firmwares disponibles ─────
router.get("/", (req, res) => {
  const todos = fs.readdirSync(FIRMWARE_DIR);
  console.log("[Firmware] Archivos en carpeta:", todos); // ← agregar
  try {
    const files = fs
      .readdirSync(FIRMWARE_DIR)
      .filter((f) => f.endsWith(".bin") && f.startsWith("VX-"))
      .map((f) => {
        const stats = fs.statSync(path.join(FIRMWARE_DIR, f));
        // Extraer versión del nombre: VX-1.2.0.bin → 1.2.0
        const version = f.replace(/^VX-/, "").replace(/\.bin$/, "");
        return {
          filename: f,
          version,
          size: stats.size,
          fecha: stats.mtime,
        };
      })
      // Ordenar por fecha descendente (el más nuevo primero)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json({ ok: true, firmwares: files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/firmware/upload — subir un .bin ─────────────
router.post("/upload", upload.single("firmware"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ ok: false, error: "No se recibió ningún archivo" });
  }
  const version = req.file.filename.replace(/^VX-/, "").replace(/\.bin$/, "");
  console.log(
    `\x1b[33m[Firmware]\x1b[0m Nuevo firmware subido: ${req.file.filename} (${(req.file.size / 1024).toFixed(1)} KB)`,
  );
  res.json({
    ok: true,
    filename: req.file.filename,
    version,
    size: req.file.size,
  });
});

// ── DELETE /api/firmware/:filename — eliminar un .bin ─────
router.delete("/:filename", (req, res) => {
  const safe = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, "");
  if (!safe.endsWith(".bin") || !safe.startsWith("VX-")) {
    return res
      .status(400)
      .json({ ok: false, error: "Nombre de archivo inválido" });
  }
  const filePath = path.join(FIRMWARE_DIR, safe);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: "Archivo no encontrado" });
  }
  fs.unlinkSync(filePath);
  console.log(`\x1b[31m[Firmware]\x1b[0m Eliminado: ${safe}`);
  res.json({ ok: true, deleted: safe });
});

// ── Manejo de errores de multer ───────────────────────────
router.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({ ok: false, error: "Archivo demasiado grande (máx 4MB)" });
  }
  res.status(400).json({ ok: false, error: err.message });
});

module.exports = router;
