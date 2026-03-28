// ============================================================
// public/js/lote_manager.js  (v3)
//
// Gestiona el estado del lote activo en el navegador.
// Escucha "lote_update" del socket → sincroniza UI sin importar
// el origen del evento (CoreX, AOG, UI manual, MQTT).
//
// ESTE es el archivo que faltaba y causaba que la UI
// se quedara en estado "grabando" después de cerrar.
// ============================================================

(function () {
  "use strict";

  if (!window.LOTE_ACTIVO) window.LOTE_ACTIVO = null;

  // ═══════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════
  window.LoteManager = {
    hayLoteActivo() {
      return !!(window.LOTE_ACTIVO && window.LOTE_ACTIVO.activo);
    },

    setLoteActivo(datos) {
      window.LOTE_ACTIVO = datos;
      _actualizarUI();
    },

    limpiarLote() {
      window.LOTE_ACTIVO = null;
      _actualizarUI();
    },

    getLoteActivo() {
      return window.LOTE_ACTIVO;
    },
  };

  // ═══════════════════════════════════════════
  // FUNCIONES GLOBALES (onclick del HTML)
  // ═══════════════════════════════════════════
  window.abrirModalLote = function () {
    const modal = document.getElementById("modal-lote");
    if (!modal) return;

    const panelNuevo  = document.getElementById("panel-nuevo-lote");
    const panelActivo = document.getElementById("panel-lote-activo");
    const titulo      = document.getElementById("modal-lote-titulo");

    if (LoteManager.hayLoteActivo()) {
      if (panelNuevo)  panelNuevo.style.display  = "none";
      if (panelActivo) panelActivo.style.display = "block";
      if (titulo) titulo.innerHTML = '<i class="fas fa-seedling"></i> LOTE EN CURSO';

      const l = window.LOTE_ACTIVO;
      _setText("lote-act-nombre",   l.nombre   || "—");
      _setText("lote-act-cultivo",  l.cultivo  || "—");
      _setText("lote-act-variedad", l.variedad || "—");
      _setText("lote-act-estab",    l.estab    || "—");
      _setText("lote-act-inicio",   l.inicio ? new Date(l.inicio).toLocaleString("es-AR") : "—");
      _setText("lote-act-puntos",   l.puntosGrabados || "—");
    } else {
      if (panelNuevo)  panelNuevo.style.display  = "block";
      if (panelActivo) panelActivo.style.display = "none";
      if (titulo) titulo.innerHTML = '<i class="fas fa-seedling"></i> INICIAR LOTE';
    }

    modal.style.display = "flex";
  };

  window.cerrarModalLote = function () {
    const modal = document.getElementById("modal-lote");
    if (modal) modal.style.display = "none";
  };

  window.iniciarLoteDesdeMonitor = async function () {
    const nombre   = document.getElementById("lote-inp-nombre")?.value.trim();
    const cultivo  = document.getElementById("lote-inp-cultivo")?.value;
    const variedad = document.getElementById("lote-inp-variedad")?.value.trim();
    const estab    = document.getElementById("lote-inp-estab")?.value.trim();
    const ancho    = window.APP_CONFIG?.setup?.distancia_entre_surcos || 0.191;

    if (!nombre) {
      const inp = document.getElementById("lote-inp-nombre");
      if (inp) { inp.style.borderColor = "var(--danger)"; inp.focus(); }
      return;
    }
    if (!cultivo) {
      const sel = document.getElementById("lote-inp-cultivo");
      if (sel) { sel.style.borderColor = "var(--danger)"; sel.focus(); }
      return;
    }

    try {
      const res = await fetch("/api/mapa/iniciar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ nombre, cultivo, variedad, estab, anchoPasada: ancho }),
      });

      if (res.ok) {
        const data = await res.json();
        cerrarModalLote();
        // El socket lote_update va a llegar y actualizar la UI automáticamente
        // pero por si hay latencia, actualizamos de inmediato también:
        LoteManager.setLoteActivo({
          activo: true, id: data.lote?.id,
          nombre, cultivo, variedad, estab,
          inicio: data.lote?.inicio || new Date().toISOString(),
        });
        _limpiarFormulario();
        console.log(`[LoteManager] Lote iniciado: "${nombre}"`);
      } else {
        const err = await res.json().catch(() => ({}));
        alert("Error: " + (err.error || "No se pudo iniciar"));
      }
    } catch (e) {
      alert("Error de conexión");
    }
  };

  window.cerrarLoteDesdeMonitor = async function () {
    const nombre = window.LOTE_ACTIVO?.nombre || "Lote activo";
    if (!confirm(`¿Cerrar "${nombre}"? Se exportará el GeoJSON.`)) return;

    try {
      const res = await fetch("/api/mapa/cerrar", { method: "POST" });
      if (res.ok) {
        cerrarModalLote();
        // El socket lote_update va a llegar, pero limpiamos inmediatamente:
        LoteManager.limpiarLote();
        console.log("[LoteManager] Lote cerrado");
      } else {
        alert("Error al cerrar el lote");
      }
    } catch (e) {
      alert("Error de conexión");
    }
  };

  // ═══════════════════════════════════════════
  // SOCKET — Escuchar cambios de lote
  // ═══════════════════════════════════════════
  function _hookSocket() {
    if (!window.socket) {
      setTimeout(_hookSocket, 300);
      return;
    }

    // ═══ EVENTO CLAVE: lote_update ═══
    // Llega cuando el lote se inicia o cierra desde CUALQUIER origen:
    //   - CoreX (vía MQTT vistax/control/lote)
    //   - AOG (vía aog/field/status painting:false)
    //   - UI REST (POST /api/mapa/cerrar)
    //   - Auto-cierre por timeout (30s sin pintar)
    window.socket.on("lote_update", (data) => {
      console.log("[LoteManager] lote_update:", data);

      if (data.activo) {
        LoteManager.setLoteActivo({
          activo: true,
          id:      data.id,
          nombre:  data.nombre,
          cultivo: data.cultivo,
          inicio:  data.inicio || new Date().toISOString(),
        });
      } else {
        // ═══ FIX: LIMPIAR UI INMEDIATAMENTE ═══
        LoteManager.limpiarLote();
        // Cerrar el modal de lote si está abierto
        cerrarModalLote();
      }
    });

    window.socket.on("map_stats", (stats) => {
      if (window.LOTE_ACTIVO && stats) {
        window.LOTE_ACTIVO.puntosGrabados = stats.puntosGrabados || 0;
      }
    });

    console.log("[LoteManager] Socket hooks activos");
  }

  // ═══════════════════════════════════════════
  // UI — Actualizar footer y header
  // ═══════════════════════════════════════════
  function _actualizarUI() {
    const hayLote = LoteManager.hayLoteActivo();
    const l       = window.LOTE_ACTIVO;

    // Footer texto
    const txtLote = document.getElementById("txt-lote");
    if (txtLote) {
      txtLote.textContent = hayLote
        ? (l.nombre || "LOTE ACTIVO").toUpperCase()
        : "SIN LOTE \u2014 INICIAR";
    }

    // Footer estilo
    const footerEl = document.getElementById("lote-info-footer");
    if (footerEl) {
      if (hayLote) {
        footerEl.classList.add("activo");
      } else {
        footerEl.classList.remove("activo");
      }
    }

    // Header badge
    const badge = document.querySelector(".lote-activo-badge");
    if (badge) {
      badge.style.display = hayLote ? "flex" : "none";
      const nombreBadge = badge.querySelector(".lote-nombre-badge");
      if (nombreBadge && hayLote) nombreBadge.textContent = l.nombre;
    }

    // Header rec-dot
    const recDot = document.querySelector(".rec-dot");
    if (recDot) recDot.style.display = hayLote ? "inline-block" : "none";
  }

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function _limpiarFormulario() {
    ["lote-inp-nombre", "lote-inp-variedad", "lote-inp-estab"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ""; el.style.borderColor = ""; }
    });
    const sel = document.getElementById("lote-inp-cultivo");
    if (sel) { sel.value = ""; sel.style.borderColor = ""; }
  }

  // ═══════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════
  document.addEventListener("DOMContentLoaded", () => {
    if (window.LOTE_ACTIVO && window.LOTE_ACTIVO.id) {
      window.LOTE_ACTIVO.activo = true;
    }
    _actualizarUI();
    _hookSocket();
  });

})();
