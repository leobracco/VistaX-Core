// ============================================================
// public/js/trigger_manager.js
//
// Gestiona los 3 triggers de inicio de monitoreo:
//   1. Manual (toca footer "SIN LOTE")  → abre modal normal
//   2. Bridge pintando (aog/field/status painting:true) → popup urgente
//   3. Caída de semilla (N bajadas activas por X segundos) → popup urgente
//
// Si ya hay un lote activo → los triggers 2 y 3 no disparan.
// Si el popup ya está visible → no vuelve a mostrarse.
//
// Config en APP_CONFIG.setup:
//   min_bajadas_trigger  (default: 3)  — bajadas con pulsos para trigger 3
//   seg_espera_trigger   (default: 2)  — segundos antes de disparar
// ============================================================

(function () {
  "use strict";

  // ── Estado del módulo ──
  let _popupVisible    = false;
  let _pospuesto       = false;          // "Posponer" bloquea por 3 min
  let _pospuestoTimer  = null;
  let _bajasConPulsos  = {};             // { bajada: lastPulsoTs }
  let _triggerTimer    = null;           // timer para trigger 3

  // Config con defaults
  function _cfg() {
    const s = window.APP_CONFIG?.setup || {};
    return {
      minBajadas: parseInt(s.min_bajadas_trigger) || 3,
      segEspera:  parseInt(s.seg_espera_trigger)  || 2,
    };
  }

  // ── ¿Hay lote activo? Delega a LoteManager si existe ──
  function _hayLote() {
    if (window.LoteManager?.hayLoteActivo) return window.LoteManager.hayLoteActivo();
    // Fallback: mirar LOTE_ACTIVO del template
    return !!(window.LOTE_ACTIVO?.activo);
  }

  // ── Mostrar popup urgente ──
  function _mostrarPopup(origenMsg) {
    if (_popupVisible || _pospuesto || _hayLote()) return;

    _popupVisible = true;
    const overlay = document.getElementById("trigger-overlay");
    if (!overlay) return;

    // Log del origen para debug
    console.log(`[TriggerManager] Popup disparado: ${origenMsg}`);

    // Actualizar texto del header según origen
    const header = overlay.querySelector(".trigger-popup-header span");
    if (header) {
      if (origenMsg === "bridge") {
        header.textContent = "BRIDGE DETECTA SIEMBRA — INICIÁ EL LOTE";
      } else if (origenMsg === "semilla") {
        header.textContent = "SEMILLA DETECTADA — INICIÁ EL LOTE";
      } else {
        header.textContent = "SIEMBRA DETECTADA — INICIÁ EL LOTE";
      }
    }

    overlay.style.display = "flex";

    // Focus al nombre después de animar
    setTimeout(() => {
      const inp = document.getElementById("trigger-inp-nombre");
      if (inp) inp.focus();
    }, 220);
  }

  function _ocultarPopup() {
    _popupVisible = false;
    const overlay = document.getElementById("trigger-overlay");
    if (overlay) overlay.style.display = "none";
  }

  function _limpiarFormulario() {
    ["trigger-inp-nombre", "trigger-inp-variedad", "trigger-inp-estab"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ""; el.style.borderColor = ""; }
    });
    const sel = document.getElementById("trigger-inp-cultivo");
    if (sel) { sel.value = ""; sel.style.borderColor = ""; }
  }

  // ── API Pública ──

  /**
   * Confirmar desde el popup urgente → inicia el lote y cierra.
   */
  window.TriggerManager = {

    confirmar: async function () {
      const nombre   = document.getElementById("trigger-inp-nombre")?.value.trim();
      const cultivo  = document.getElementById("trigger-inp-cultivo")?.value;
      const variedad = document.getElementById("trigger-inp-variedad")?.value.trim();
      const estab    = document.getElementById("trigger-inp-estab")?.value.trim();
      const ancho    = window.APP_CONFIG?.setup?.distancia_entre_surcos || 0.191;

      // Validar campos obligatorios
      if (!nombre) {
        const inp = document.getElementById("trigger-inp-nombre");
        if (inp) { inp.style.borderColor = "var(--danger)"; inp.focus(); }
        return;
      }
      if (!cultivo) {
        const sel = document.getElementById("trigger-inp-cultivo");
        if (sel) { sel.style.borderColor = "var(--danger)"; sel.focus(); }
        return;
      }

      const btn = document.querySelector(".tp-btn-primary");
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...'; }

      try {
        const res = await fetch("/api/mapa/iniciar", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ nombre, cultivo, variedad, estab, anchoPasada: ancho }),
        });

        if (res.ok) {
          const data = await res.json();
          _ocultarPopup();
          _limpiarFormulario();

          // Sincronizar con LoteManager si existe
          if (window.LoteManager?.setLoteActivo) {
            window.LoteManager.setLoteActivo({
              activo: true, nombre, cultivo, variedad, estab,
              inicio: data.lote?.inicio || new Date().toISOString(),
            });
          }

          console.log(`[TriggerManager] Lote iniciado: "${nombre}"`);
        } else {
          const err = await res.json().catch(() => ({}));
          alert(`Error al iniciar lote: ${err.error || "Error desconocido"}`);
        }
      } catch (e) {
        alert("Error de conexión con el servidor");
        console.error("[TriggerManager]", e);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> Iniciar Lote'; }
      }
    },

    /**
     * Posponer: oculta el popup por 3 minutos sin iniciar lote.
     */
    posponer: function () {
      _ocultarPopup();
      _pospuesto = true;
      console.log("[TriggerManager] Pospuesto por 3 minutos");
      clearTimeout(_pospuestoTimer);
      _pospuestoTimer = setTimeout(() => {
        _pospuesto = false;
        console.log("[TriggerManager] Pausa expirada — triggers activos");
      }, 3 * 60 * 1000);
    },

    hayLoteActivo: function () { return _hayLote(); },
  };

  // ══════════════════════════════════════════
  // TRIGGER 2 — Bridge indica que está pintando
  // Se engancha en el socket DESPUÉS de que
  // render_engine.js inicialice el socket.
  // ══════════════════════════════════════════
  function _hookSocketBridge() {
    if (!window.socket) {
      setTimeout(_hookSocketBridge, 300);
      return;
    }

    window.socket.on("aog_field_status", (data) => {
      if (!data?.painting) return;
      if (_hayLote() || _popupVisible || _pospuesto) return;
      console.log(`[TriggerManager] Trigger 2: bridge pintando campo="${data.fieldName}"`);
      _mostrarPopup("bridge");
    });

    // También escuchar el tópico crudo que re-emite mqtt_handler
    window.socket.on("field_status", (data) => {
      if (!data?.painting) return;
      if (_hayLote() || _popupVisible || _pospuesto) return;
      _mostrarPopup("bridge");
    });

    console.log("[TriggerManager] Trigger 2 (bridge) activo");
  }

  // ══════════════════════════════════════════
  // TRIGGER 3 — Caída de semilla
  // Se engancha en sensor_update del socket.
  // Cuenta bajadas con pulsos > 0 en los
  // últimos N segundos y dispara si alcanza
  // el mínimo configurado.
  // ══════════════════════════════════════════
  function _hookSensorUpdate() {
    if (!window.socket) {
      setTimeout(_hookSensorUpdate, 300);
      return;
    }

    window.socket.on("sensor_update", (data) => {
      if (_hayLote() || _pospuesto) return;

      const ahora = Date.now();
      const cfg   = _cfg();

      // Registrar bajadas con pulsos recientes
      if (parseInt(data.nuevas_semillas) > 0) {
        _bajasConPulsos[data.bajada] = ahora;
      }

      // Limpiar bajadas que llevan más de 5s sin pulsos
      for (const b in _bajasConPulsos) {
        if (ahora - _bajasConPulsos[b] > 5000) {
          delete _bajasConPulsos[b];
        }
      }

      const activasAhora = Object.keys(_bajasConPulsos).length;

      if (activasAhora >= cfg.minBajadas) {
        // Ya supera el mínimo — esperar N segundos continuo antes de disparar
        if (!_triggerTimer) {
          _triggerTimer = setTimeout(() => {
            _triggerTimer = null;
            if (!_hayLote() && !_popupVisible && !_pospuesto) {
              const activas = Object.keys(_bajasConPulsos).length;
              if (activas >= _cfg().minBajadas) {
                console.log(`[TriggerManager] Trigger 3: ${activas} bajadas activas`);
                _mostrarPopup("semilla");
              }
            }
          }, cfg.segEspera * 1000);
        }
      } else {
        // Bajó del mínimo — cancelar timer
        if (_triggerTimer) {
          clearTimeout(_triggerTimer);
          _triggerTimer = null;
        }
      }
    });

    console.log("[TriggerManager] Trigger 3 (semilla) activo");
  }

  // ══════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════
  document.addEventListener("DOMContentLoaded", () => {
    _hookSocketBridge();
    _hookSensorUpdate();
    console.log("[TriggerManager] Listo. Trigger 1 (manual) → footer lote-info");
  });

})();
