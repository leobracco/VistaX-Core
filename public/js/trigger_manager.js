// ============================================================
// public/js/trigger_manager.js  (v3)
//
// 4 TRIGGERS DE INICIO DE MONITOREO:
//
//   T1 — Manual:              El operario toca "SIN LOTE" en el footer
//   T2 — Señal externa (AOG): Bridge publica painting:true
//   T3 — Sensor de paso:      N bajadas con semilla detectada por X seg
//   T4 — Sensor de implemento: bajada_herramienta con valor > 0
//                               (pin digital del cilindro hidráulico)
//
// PRIORIDAD: Si ya hay lote activo → NINGUNO dispara.
//            Si el popup ya está visible → no se duplica.
//            "Posponer" bloquea por 3 minutos.
//
// CONFIG en APP_CONFIG.setup:
//   min_bajadas_trigger   (default: 3)
//   seg_espera_trigger    (default: 2)
//   trigger_implemento    (default: true) — habilita T4
// ============================================================

(function () {
  "use strict";

  let _popupVisible    = false;
  let _pospuesto       = false;
  let _pospuestoTimer  = null;
  let _bajasConPulsos  = {};
  let _triggerTimer    = null;
  let _loteConfirmado  = false;

  function _cfg() {
    const s = window.APP_CONFIG?.setup || {};
    return {
      minBajadas:       parseInt(s.min_bajadas_trigger)    || 3,
      segEspera:        parseInt(s.seg_espera_trigger)     || 2,
      triggerImplemento: s.trigger_implemento !== false,  // default true
    };
  }

  function _hayLote() {
    if (_loteConfirmado) return true;
    if (window.LoteManager?.hayLoteActivo) return window.LoteManager.hayLoteActivo();
    return !!(window.LOTE_ACTIVO?.activo);
  }

  // ═══════════════════════════════════════════
  // POPUP
  // ═══════════════════════════════════════════
  function _mostrarPopup(origenMsg) {
    if (_popupVisible || _pospuesto || _hayLote()) return;

    _popupVisible = true;
    const overlay = document.getElementById("trigger-overlay");
    if (!overlay) return;

    console.log(`[TriggerManager] Popup disparado: ${origenMsg}`);

    // Texto del header según origen
    const header = overlay.querySelector("#trigger-header-txt") ||
                   overlay.querySelector(".trigger-popup-header span:last-child");
    if (header) {
      const msgs = {
        bridge:     "BRIDGE DETECTA SIEMBRA \u2014 INICI\u00C1 EL LOTE",
        semilla:    "SEMILLA DETECTADA \u2014 INICI\u00C1 EL LOTE",
        implemento: "HERRAMIENTA BAJA \u2014 INICI\u00C1 EL LOTE",
      };
      header.textContent = msgs[origenMsg] || "SIEMBRA DETECTADA \u2014 INICI\u00C1 EL LOTE";
    }

    overlay.style.display = "flex";
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

  function _resetTriggers() {
    _bajasConPulsos = {};
    if (_triggerTimer) { clearTimeout(_triggerTimer); _triggerTimer = null; }
  }

  // ═══════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════
  window.TriggerManager = {

    confirmar: async function () {
      const nombre   = document.getElementById("trigger-inp-nombre")?.value.trim();
      const cultivo  = document.getElementById("trigger-inp-cultivo")?.value;
      const variedad = document.getElementById("trigger-inp-variedad")?.value.trim();
      const estab    = document.getElementById("trigger-inp-estab")?.value.trim();
      const ancho    = window.APP_CONFIG?.setup?.distancia_entre_surcos || 0.191;

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

          // Flag LOCAL inmediato
          _loteConfirmado = true;
          _ocultarPopup();
          _limpiarFormulario();
          _resetTriggers();

          // Sincronizar LoteManager
          if (window.LoteManager?.setLoteActivo) {
            window.LoteManager.setLoteActivo({
              activo: true, nombre, cultivo, variedad, estab,
              id: data.lote?.id,
              inicio: data.lote?.inicio || new Date().toISOString(),
            });
          } else {
            window.LOTE_ACTIVO = { activo: true, nombre, cultivo, id: data.lote?.id };
          }

          console.log(`[TriggerManager] Lote iniciado: "${nombre}"`);
        } else {
          const err = await res.json().catch(() => ({}));
          alert(`Error: ${err.error || "Error desconocido"}`);
        }
      } catch (e) {
        alert("Error de conexi\u00F3n con el servidor");
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> Iniciar Lote'; }
      }
    },

    posponer() {
      _ocultarPopup();
      _pospuesto = true;
      _resetTriggers();
      clearTimeout(_pospuestoTimer);
      _pospuestoTimer = setTimeout(() => { _pospuesto = false; }, 3 * 60 * 1000);
      console.log("[TriggerManager] Pospuesto 3 min");
    },

    hayLoteActivo() { return _hayLote(); },
  };

  // ═══════════════════════════════════════════
  // SOCKET — Sincronizar con lote_update
  // ═══════════════════════════════════════════
  function _hookLoteUpdate() {
    if (!window.socket) { setTimeout(_hookLoteUpdate, 300); return; }

    window.socket.on("lote_update", (data) => {
      if (data.activo) {
        _loteConfirmado = true;
        _resetTriggers();
        _ocultarPopup();
      } else {
        _loteConfirmado = false;
      }
    });
  }

  // ═══════════════════════════════════════════
  // TRIGGER 2 — Señal externa: AOG pintando
  // ═══════════════════════════════════════════
  function _hookBridge() {
    if (!window.socket) { setTimeout(_hookBridge, 300); return; }

    window.socket.on("field_status", (data) => {
      if (!data?.painting) return;
      if (_hayLote() || _popupVisible || _pospuesto) return;
      console.log(`[TriggerManager] T2: bridge pintando campo="${data.fieldName}"`);
      _mostrarPopup("bridge");
    });

    // Alias por si llega como aog_field_status
    window.socket.on("aog_field_status", (data) => {
      if (!data?.painting) return;
      if (_hayLote() || _popupVisible || _pospuesto) return;
      _mostrarPopup("bridge");
    });

    console.log("[TriggerManager] T2 (AOG pintando) activo");
  }

  // ═══════════════════════════════════════════
  // TRIGGER 3 — Sensor de paso: caída de semilla
  // N bajadas con pulsos > 0 durante X segundos
  // ═══════════════════════════════════════════
  function _hookSemilla() {
    if (!window.socket) { setTimeout(_hookSemilla, 300); return; }

    window.socket.on("sensor_update", (data) => {
      if (_hayLote() || _pospuesto) return;

      // Solo contar sensores de siembra (no turbina, batería, etc.)
      const tipoSiembra = data.tipo === "semilla" || data.tipo === "ferti_linea" || data.tipo === "ferti_costado";
      if (!tipoSiembra) return;

      const ahora = Date.now();
      const cfg   = _cfg();

      if (parseInt(data.nuevas_semillas) > 0) {
        _bajasConPulsos[data.bajada] = ahora;
      }

      // Limpiar bajadas inactivas >5s
      for (const b in _bajasConPulsos) {
        if (ahora - _bajasConPulsos[b] > 5000) delete _bajasConPulsos[b];
      }

      const activas = Object.keys(_bajasConPulsos).length;

      if (activas >= cfg.minBajadas) {
        if (!_triggerTimer) {
          _triggerTimer = setTimeout(() => {
            _triggerTimer = null;
            if (_hayLote() || _popupVisible || _pospuesto) return;
            if (Object.keys(_bajasConPulsos).length >= _cfg().minBajadas) {
              console.log(`[TriggerManager] T3: ${activas} bajadas activas`);
              _mostrarPopup("semilla");
            }
          }, cfg.segEspera * 1000);
        }
      } else {
        if (_triggerTimer) { clearTimeout(_triggerTimer); _triggerTimer = null; }
      }
    });

    console.log("[TriggerManager] T3 (sensor de paso) activo");
  }

  // ═══════════════════════════════════════════
  // TRIGGER 4 — Sensor de implemento (NUEVO)
  // bajada_herramienta con valor > 0 = implemento abajo
  //
  // El ESP32 envía un sensor tipo "bajada_herramienta"
  // que lee el pin del cilindro hidráulico. Valor > 0
  // significa que la herramienta está en posición de trabajo.
  // ═══════════════════════════════════════════
  let _implementoTimer = null;
  let _implementoAbajo = false;

  function _hookImplemento() {
    if (!window.socket) { setTimeout(_hookImplemento, 300); return; }

    window.socket.on("sensor_update", (data) => {
      if (!_cfg().triggerImplemento) return;
      if (data.tipo !== "bajada_herramienta") return;
      if (_hayLote() || _pospuesto) return;

      const abajo = parseFloat(data.valor) > 0;

      if (abajo && !_implementoAbajo) {
        // La herramienta acaba de bajar → esperar 3s antes de triggear
        _implementoAbajo = true;
        if (_implementoTimer) clearTimeout(_implementoTimer);
        _implementoTimer = setTimeout(() => {
          _implementoTimer = null;
          if (_hayLote() || _popupVisible || _pospuesto) return;
          if (_implementoAbajo) {
            console.log("[TriggerManager] T4: herramienta abajo detectada");
            _mostrarPopup("implemento");
          }
        }, 3000);
      } else if (!abajo) {
        // La herramienta subió → cancelar timer
        _implementoAbajo = false;
        if (_implementoTimer) { clearTimeout(_implementoTimer); _implementoTimer = null; }
      }
    });

    console.log("[TriggerManager] T4 (sensor implemento) activo");
  }

  // ═══════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════
  document.addEventListener("DOMContentLoaded", () => {
    if (_hayLote()) _loteConfirmado = true;

    _hookLoteUpdate();
    _hookBridge();
    _hookSemilla();
    _hookImplemento();

    console.log("[TriggerManager] 4 triggers activos:", _hayLote() ? "lote ya activo" : "esperando evento");
  });

})();
