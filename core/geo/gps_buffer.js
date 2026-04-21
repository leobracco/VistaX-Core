// ============================================================
// VistaX — core/geo/gps_buffer.js
//
// Buffer circular de posiciones GPS en memoria.
// Mantiene las últimas N posiciones (default 100 = 10s a 10Hz)
// para interpolación temporal cuando llegan pulsos de sensores.
//
// También escribe GPS submuestreado a disco (1/seg) para
// auditoría y reproceso futuro.
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");

const DEFAULT_CAPACITY     = 100;    // posiciones en RAM (10s a 10Hz)
const SUBSAMPLE_DISK_MS    = 1000;   // escribir a disco cada 1s
const MAX_EXTRAPOLATION_MS = 2000;   // no interpolar más allá de 2s

class GpsBuffer {
  constructor(capacity = DEFAULT_CAPACITY) {
    this._buffer   = [];
    this._capacity = capacity;
    this._lastDiskWrite = 0;
    this._diskStream = null;
  }

  /**
   * Agregar una posición GPS al buffer.
   * @param {number} lat
   * @param {number} lon
   * @param {number} heading - rumbo en grados
   * @param {number} vel - velocidad en km/h
   * @param {number} ts - timestamp en ms (default Date.now())
   */
  push(lat, lon, heading, vel, ts) {
    if (!lat || !lon) return;
    const punto = {
      ts:  ts || Date.now(),
      lat,
      lon,
      hdg: heading || 0,
      vel: vel || 0,
    };

    this._buffer.push(punto);
    if (this._buffer.length > this._capacity) {
      this._buffer.shift();
    }

    // Submuestreo a disco
    if (this._diskStream && (punto.ts - this._lastDiskWrite) >= SUBSAMPLE_DISK_MS) {
      this._lastDiskWrite = punto.ts;
      const linea = JSON.stringify({
        ts:  punto.ts,
        lat: parseFloat(lat.toFixed(7)),
        lon: parseFloat(lon.toFixed(7)),
        hdg: parseFloat(punto.hdg.toFixed(1)),
        vel: parseFloat(punto.vel.toFixed(1)),
      }) + "\n";
      try {
        this._diskStream.write(linea);
      } catch (e) {
        console.error("[GpsBuffer] Error escribiendo GPS a disco:", e.message);
      }
    }
  }

  /**
   * Interpolar posición GPS para un timestamp dado.
   * Retorna {lat, lon, hdg, vel, gps_q} o null si no hay datos.
   *
   * gps_q = distancia en ms al GPS más cercano (calidad):
   *   <250  → bueno
   *   <1000 → aceptable
   *   >1000 → malo
   */
  interpolar(ts) {
    const buf = this._buffer;
    if (!buf.length) return null;

    // Antes del primer punto → usar el primero (si está cerca)
    if (ts <= buf[0].ts) {
      const dt = buf[0].ts - ts;
      if (dt > MAX_EXTRAPOLATION_MS) return null;
      return { ...buf[0], gps_q: dt };
    }

    // Después del último punto → usar el último (si está cerca)
    const ultimo = buf[buf.length - 1];
    if (ts >= ultimo.ts) {
      const dt = ts - ultimo.ts;
      if (dt > MAX_EXTRAPOLATION_MS) return null;
      return { ...ultimo, gps_q: dt };
    }

    // Búsqueda binaria del par que encierra ts
    let lo = 0, hi = buf.length - 1;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (buf[mid].ts <= ts) lo = mid;
      else hi = mid;
    }

    const p1 = buf[lo];
    const p2 = buf[hi];
    const span = p2.ts - p1.ts;
    const t = span > 0 ? (ts - p1.ts) / span : 0;

    return {
      lat: p1.lat + (p2.lat - p1.lat) * t,
      lon: p1.lon + (p2.lon - p1.lon) * t,
      hdg: p1.hdg + (p2.hdg - p1.hdg) * t,
      vel: p1.vel + (p2.vel - p1.vel) * t,
      gps_q: Math.min(ts - p1.ts, p2.ts - ts),  // distancia al más cercano
    };
  }

  /**
   * Iniciar escritura de GPS submuestreado a disco.
   * @param {string} filePath - ruta del archivo gps.ndjson
   */
  iniciarDisco(filePath) {
    this.cerrarDisco();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._diskStream = fs.createWriteStream(filePath, { flags: "a" });
    this._lastDiskWrite = 0;
    console.log(`[GpsBuffer] GPS a disco: ${filePath}`);
  }

  /**
   * Cerrar stream de disco.
   */
  cerrarDisco() {
    if (this._diskStream) {
      try { this._diskStream.end(); } catch {}
      this._diskStream = null;
    }
  }

  /**
   * Cantidad de posiciones en el buffer.
   */
  get size() {
    return this._buffer.length;
  }

  /**
   * Última posición conocida (o null).
   */
  get ultima() {
    return this._buffer.length > 0 ? this._buffer[this._buffer.length - 1] : null;
  }

  /**
   * Limpiar buffer.
   */
  reset() {
    this._buffer = [];
  }
}

module.exports = GpsBuffer;
