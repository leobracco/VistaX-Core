// ============================================================
// VistaX — routes/audio.routes.js  (v3.0)
//
// Lista los archivos de audio disponibles en public/audio/
// El tab "Pantalla y Sonidos" usa esto para poblar los dropdowns
// de selección de archivo por evento.
//
// Formatos soportados: .mp3, .wav, .ogg, .m4a
// ============================================================
console.log("[Audio] 🔊 audio.routes.js CARGADO");
const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");

const AUDIO_DIR = path.join(__dirname, "../public/audio");
const FORMATOS_OK = [".mp3", ".wav", ".ogg", ".m4a"];

// Asegurar que el directorio exista
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  console.log("[Audio] Directorio creado: public/audio/");
}

// ── GET /api/audio/archivos ──
// Devuelve los archivos de audio disponibles
router.get("/archivos", (req, res) => {
  console.log("[Audio] 📥 GET /archivos recibido!");
  try {
    const archivos = fs
      .readdirSync(AUDIO_DIR)
      .filter(f => FORMATOS_OK.includes(path.extname(f).toLowerCase()))
      .sort()
      .map(f => {
        const stats = fs.statSync(path.join(AUDIO_DIR, f));
        return {
          nombre:  f,
          tamano:  stats.size,
          fecha:   stats.mtime,
        };
      });

    res.json({ ok: true, archivos, total: archivos.length });
  } catch (e) {
    console.error("[Audio] Error listando archivos:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
console.log("[Audio] 🔊 router exportado, rutas registradas");
console.log("[Audio] 🔍 Rutas registradas en el router:");
router.stack.forEach(layer => {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
    console.log(`   ${methods} ${layer.route.path}`);
  }
});
module.exports = router;
