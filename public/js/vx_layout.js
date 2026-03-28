// ============================================================
// public/js/vx_layout.js
// Gestión del nuevo layout:
//   - Construye tubos de ensayo reemplazando las surco-column
//   - Inserta separador visual entre Tren 1 y Tren 2
//   - Colapso del strip de surcos y del mapa
//   - Modos normal / compact / mini
//   - Ajuste dinámico de altura del mapa-strip
// ============================================================
(function () {
  "use strict";

  const MODOS    = ["normal", "compact", "mini"];
  let _modo      = 0;
  let _surcosOk  = false;
  let

  // ── Al cargar: construir estructura de tubos ──
  document.addEventListener("DOMContentLoaded", () => {
    _inicializarTubos();
    _ajustarAlturaStrip();
    _actualizarLblSurcos();

    // El strip de surcos arranca expandido
    const strip = document.getElementById("strip-surcos");
    if (strip) {
      _surcosOk = true;
      strip.style.height = strip.scrollHeight + "px";
    }
  });

  // ── Construir los tubos después de que render_engine pueble el DOM ──
  // render_engine.js crea surco-column > pills-area > pill-status
  // Nosotros agregamos el tapón (.tubo-cap) y el tubo-glass encima
  function _inicializarTubos() {
    // Esperar a que render_engine termine (usa setTimeout(0) al final)
    setTimeout(() => {
      _agregarTapones();
      _insertarSeparadorTren();
      _actualizarLblSurcos();
    }, 200);
  }

  function _agregarTapones() {
    document.querySelectorAll(".surco-column").forEach(col => {
      // Agregar tapón si no existe
      if (!col.querySelector(".tubo-cap")) {
        const cap = document.createElement("div");
        cap.className = "tubo-cap";
        // Insertar entre surco-id y pills-area
        const pillsArea = col.querySelector(".pills-area");
        if (pillsArea) col.insertBefore(cap, pillsArea);
      }

      // Envolver pills-area en tubo-glass si no está hecho
      const pillsArea = col.querySelector(".pills-area");
      if (pillsArea && !pillsArea.closest(".tubo-glass")) {
        const glass = document.createElement("div");
        glass.className = "tubo-glass";
        col.insertBefore(glass, pillsArea);
        glass.appendChild(pillsArea);
      }

      // Agregar val-num si no existe
      if (!col.querySelector(".surco-val-num")) {
        const vn = document.createElement("div");
        vn.className = "surco-val-num";
        vn.textContent = "—";
        col.appendChild(vn);
      }
    });
  }

  function _insertarSeparadorTren() {
    const strip = document.getElementById("main-monitor");
    if (!strip) return;

    // Obtener todos los wrappers de tren
    const wrappers = strip.querySelectorAll(".tren-row-wrapper");
    if (wrappers.length < 2) return;

    // Quitar separadores anteriores
    strip.querySelectorAll(".tren-sep").forEach(s => s.remove());

    // Mover surcos de cada tren directamente al strip (flatten)
    // y agregar separador entre trenes
    const todos = [];
    wrappers.forEach((wrapper, idx) => {
      const cols = Array.from(wrapper.querySelectorAll(".surco-column"));
      cols.forEach(c => todos.push({ el: c, tren: idx + 1 }));
    });

    // Limpiar strip (mantener solo los surcos)
    strip.innerHTML = "";

    let prevTren = null;
    todos.forEach(({ el, tren }) => {
      if (prevTren !== null && tren !== prevTren) {
        const sep = document.createElement("div");
        sep.className = "tren-sep";
        strip.appendChild(sep);
      }
      strip.appendChild(el);
      prevTren = tren;
    });

    // Rearmar tapones y glass después del flatten
    _agregarTapones();
  }

  function _ajustarAlturaStrip() {
    const strip = document.getElementById("strip-surcos");
    if (!strip || !_surcosOk) return;
    // Forzar recálculo de scrollHeight
    strip.style.height = "auto";
    const h = strip.scrollHeight;
    strip.style.height = h + "px";
  }

  function _actualizarLblSurcos() {
    const total   = window.TOTAL_SURCOS || 0;
    const modoLbl = ["NORMAL", "COMPACTO", "MINI"][_modo];
    const lbl = document.getElementById("strip-surcos-lbl");
    if (lbl) lbl.textContent = `MONITOR · ${total} SURCOS · ${modoLbl}`;
  }

  // ══════════════════════════════════════════
  // API pública
  // ══════════════════════════════════════════
  window.VXLayout = {

    /** Toggle colapso del strip de surcos */
    toggleSurcos() {
      const strip = document.getElementById("strip-surcos");
      const chev  = document.getElementById("chev-surcos");
      if (!strip) return;

      if (_surcosOk && strip.style.height !== "0px") {
        // Colapsar
        strip.style.height = strip.scrollHeight + "px";
        requestAnimationFrame(() => { strip.style.height = "0px"; });
        _surcosOk = false;
        if (chev) { chev.classList.remove("up"); chev.classList.add("down"); }
      } else {
        // Expandir
        _surcosOk = true;
        strip.style.height = strip.scrollHeight + "px";
        setTimeout(() => { strip.style.height = "auto"; }, 260);
        if (chev) { chev.classList.remove("down"); chev.classList.add("up"); }
      }
    },

    /** Ciclar modos: normal → compact → mini */
    cambiarModo() {
      _modo = (_modo + 1) % MODOS.length;
      const monitor = document.getElementById("main-monitor");
      if (monitor) {
        monitor.classList.remove("modo-compact", "modo-mini");
        if (_modo === 1) monitor.classList.add("modo-compact");
        if (_modo === 2) monitor.classList.add("modo-mini");
      }
      _actualizarLblSurcos();
      setTimeout(_ajustarAlturaStrip, 50);
    },

    /** Llamado por render_engine cuando termina de construir los surcos */
    onSurcosReady() {
      _agregarTapones();
      _insertarSeparadorTren();
      _ajustarAlturaStrip();
      _actualizarLblSurcos();
    },
  };

})();
