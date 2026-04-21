// ============================================================
// VistaX — core/geo/lote_purge.js
//
// Auto-borrado de lotes viejos por antigüedad.
// Se ejecuta una vez por hora. Lee metadata.json de cada lote
// y si la fecha de cierre tiene más de N días, borra la carpeta.
//
// Configurable desde el perfil:
//   setup.lotes_auto_purge_dias: 90  (default)
//
// Protecciones:
//   - Nunca borra lotes sin cerrar (fin === null)
//   - Nunca borra lotes sin metadata.json
//   - Loguea cada borrado
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");

const LOTES_DIR       = path.join(__dirname, "../../data/lotes");
const CHECK_INTERVAL  = 60 * 60 * 1000;  // cada 1 hora
const DEFAULT_DIAS    = 90;

let _timer = null;
let _getDias = () => DEFAULT_DIAS;  // función que retorna los días configurados

/**
 * Iniciar el auto-purge.
 * @param {function} getDias - función que retorna los días de retención
 *                             (ej: () => perfil.setup.lotes_auto_purge_dias || 90)
 */
function iniciar(getDias) {
  if (getDias) _getDias = getDias;
  if (_timer) clearInterval(_timer);

  // Primera ejecución a los 5 minutos del arranque (no inmediato)
  setTimeout(_ejecutarPurge, 5 * 60 * 1000);
  _timer = setInterval(_ejecutarPurge, CHECK_INTERVAL);

  console.log(`[LotePurge] Auto-purge activo (cada 1h, retención: ${_getDias()} días)`);
}

function _ejecutarPurge() {
  const diasRetencion = _getDias();
  if (!diasRetencion || diasRetencion <= 0) return; // 0 = deshabilitado

  const limiteMs = Date.now() - (diasRetencion * 24 * 60 * 60 * 1000);

  try {
    if (!fs.existsSync(LOTES_DIR)) return;

    const dirs = fs.readdirSync(LOTES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let borrados = 0;
    for (const dir of dirs) {
      const loteDir = path.join(LOTES_DIR, dir);
      const metaPath = path.join(loteDir, "metadata.json");

      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

        // Nunca borrar lotes sin cerrar
        if (!meta.fin) continue;

        const finMs = new Date(meta.fin).getTime();
        if (isNaN(finMs)) continue;

        if (finMs < limiteMs) {
          // Borrar carpeta completa
          fs.rmSync(loteDir, { recursive: true, force: true });
          borrados++;
          console.log(
            `[LotePurge] 🗑 Lote borrado: "${meta.nombre || dir}" ` +
            `(cerrado hace ${Math.round((Date.now() - finMs) / 86400000)} días)`
          );
        }
      } catch (e) {
        console.error(`[LotePurge] Error procesando ${dir}:`, e.message);
      }
    }

    if (borrados > 0) {
      console.log(`[LotePurge] ${borrados} lote(s) purgado(s)`);
    }
  } catch (e) {
    console.error("[LotePurge] Error en purge:", e.message);
  }
}

/**
 * Ejecutar purge manualmente (para API de admin).
 */
function ejecutarAhora() {
  _ejecutarPurge();
}

module.exports = { iniciar, ejecutarAhora };
