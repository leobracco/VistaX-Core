// ============================================================
// public/js/lote_manager.js
// Gestión completa del lote desde la UI de VistaX
// Se carga en index.ejs ANTES de render_engine.js
// ============================================================

(function () {
  // ── Estado local ──
  let _loteActivo = window.LOTE_ACTIVO || null;

  // ── Al cargar: sincronizar UI con estado del servidor ──
  document.addEventListener("DOMContentLoaded", () => {
    _sincronizarUI(_loteActivo);
  });

  // ── Abrir modal: muestra panel correcto según estado ──
  window.abrirModalLote = function () {
    const overlay = document.getElementById("modal-lote");
    if (!overlay) return;

    if (_loteActivo?.activo) {
      _mostrarPanelActivo(_loteActivo);
    } else {
      _mostrarPanelNuevo();
    }
    overlay.style.display = "flex";
    // Focus al primer input si es panel nuevo
    if (!_loteActivo?.activo) {
      setTimeout(() => document.getElementById("lote-inp-nombre")?.focus(), 80);
    }
  };

  window.cerrarModalLote = function () {
    const overlay = document.getElementById("modal-lote");
    if (overlay) overlay.style.display = "none";
  };

  // ── Iniciar lote ──
  window.iniciarLoteDesdeMonitor = async function () {
    const nombre   = document.getElementById("lote-inp-nombre")?.value.trim();
    const cultivo  = document.getElementById("lote-inp-cultivo")?.value;
    const variedad = document.getElementById("lote-inp-variedad")?.value.trim();
    const estab    = document.getElementById("lote-inp-estab")?.value.trim();
    const ancho    = window.APP_CONFIG?.setup?.distancia_entre_surcos || 0.191;

    // Validaciones
    if (!nombre) {
      const inp = document.getElementById("lote-inp-nombre");
      if (inp) { inp.style.borderColor = "var(--danger)"; inp.focus(); }
      return;
    }
    if (!cultivo) {
      const sel = document.getElementById("lote-inp-cultivo");
      if (sel) sel.style.borderColor = "var(--danger)";
      return;
    }

    const btnIniciar = document.querySelector("#panel-nuevo-lote .vx-btn-primary");
    if (btnIniciar) { btnIniciar.disabled = true; btnIniciar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...'; }

    try {
      const res = await fetch("/api/mapa/iniciar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ nombre, cultivo, variedad, estab, anchoPasada: ancho }),
      });

      if (res.ok) {
        const data = await res.json();
        _loteActivo = { activo: true, nombre, cultivo, variedad, estab,
                        inicio: data.lote?.inicio || new Date().toISOString() };
        cerrarModalLote();
        _sincronizarUI(_loteActivo);
        _toast(`Lote "${nombre}" iniciado ✓`);
        _limpiarFormulario();
      } else {
        const err = await res.json();
        _toast(`Error: ${err.error || "No se pudo iniciar"}`, true);
      }
    } catch (e) {
      _toast("Error de conexión", true);
    } finally {
      if (btnIniciar) { btnIniciar.disabled = false; btnIniciar.innerHTML = '<i class="fas fa-play"></i> Iniciar Lote'; }
    }
  };

  // ── Cerrar lote ──
  window.cerrarLoteDesdeMonitor = async function () {
    if (!confirm(`¿Cerrás el lote "${_loteActivo?.nombre}"?\nSe exportará el GeoJSON.`)) return;

    try {
      const res = await fetch("/api/mapa/cerrar", { method: "POST" });
      if (res.ok) {
        const nombre = _loteActivo?.nombre || "Lote";
        _loteActivo = null;
        cerrarModalLote();
        _sincronizarUI(null);
        _toast(`Lote "${nombre}" cerrado. GeoJSON exportado.`);
      } else {
        _toast("Error al cerrar el lote", true);
      }
    } catch (e) {
      _toast("Error de conexión", true);
    }
  };

  // ── Actualizar puntos GPS en tiempo real (llamado desde render_engine) ──
  window.actualizarInfoLoteModal = function (stats) {
    const el = document.getElementById("lote-act-puntos");
    if (el && stats?.puntosGrabados !== undefined) {
      el.textContent = stats.puntosGrabados;
    }
  };

  // ── Helpers internos ──

  function _mostrarPanelNuevo() {
    document.getElementById("panel-nuevo-lote").style.display  = "block";
    document.getElementById("panel-lote-activo").style.display = "none";
    document.getElementById("modal-lote-titulo").innerHTML =
      '<i class="fas fa-seedling"></i> INICIAR LOTE';
  }

  function _mostrarPanelActivo(lote) {
    document.getElementById("panel-nuevo-lote").style.display  = "none";
    document.getElementById("panel-lote-activo").style.display = "block";
    document.getElementById("modal-lote-titulo").innerHTML =
      '<i class="fas fa-circle" style="color:var(--success);font-size:10px"></i> LOTE ACTIVO';

    _setText("lote-act-nombre",   lote.nombre    || "—");
    _setText("lote-act-cultivo",  _labelCultivo(lote.cultivo));
    _setText("lote-act-variedad", lote.variedad  || "—");
    _setText("lote-act-estab",    lote.estab     || "—");
    _setText("lote-act-inicio",   lote.inicio
      ? new Date(lote.inicio).toLocaleString("es-AR", { dateStyle:"short", timeStyle:"short" })
      : "—");
  }

  function _sincronizarUI(lote) {
    const txt  = document.getElementById("txt-lote");
    const info = document.getElementById("lote-info-footer");

    if (lote?.activo) {
      if (txt)  txt.textContent = lote.nombre.toUpperCase();
      if (info) info.classList.add("activo");
    } else {
      if (txt)  txt.textContent = "SIN LOTE — INICIAR";
      if (info) info.classList.remove("activo");
    }
  }

  function _limpiarFormulario() {
    ["lote-inp-nombre","lote-inp-variedad","lote-inp-estab"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ""; el.style.borderColor = ""; }
    });
    const sel = document.getElementById("lote-inp-cultivo");
    if (sel) { sel.value = ""; sel.style.borderColor = ""; }
  }

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function _labelCultivo(val) {
    const map = { maiz:"Maíz", soja:"Soja", girasol:"Girasol",
                  sorgo:"Sorgo", trigo:"Trigo", cebada:"Cebada", otro:"Otro" };
    return map[val] || val || "—";
  }

  function _toast(msg, isError = false) {
    let t = document.getElementById("_vx_toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "_vx_toast";
      t.style.cssText = [
        "position:fixed","bottom:70px","left:50%",
        "transform:translateX(-50%) translateY(40px)",
        "background:#1e1e1e","border-radius:6px","padding:10px 20px",
        "font-size:13px","font-weight:600","z-index:9999",
        "transition:all .3s ease","opacity:0","pointer-events:none",
        "white-space:nowrap","box-shadow:0 4px 16px rgba(0,0,0,.5)"
      ].join(";");
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.borderColor = isError ? "var(--danger)" : "var(--accent)";
    t.style.border      = `1px solid ${isError ? "var(--danger)" : "var(--accent)"}`;
    t.style.color       = isError ? "var(--danger)" : "var(--accent)";
    t.style.opacity     = "1";
    t.style.transform   = "translateX(-50%) translateY(0)";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.style.opacity   = "0";
      t.style.transform = "translateX(-50%) translateY(40px)";
    }, isError ? 4000 : 2500);
  }

})();
