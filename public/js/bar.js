// ============================================================
// VistaX — bar.js  (v3.2)
//
// Cambios sobre v3.1:
//   - Overlay inicial "Tocá para activar" que desbloquea el audio
//     al primer gesto del usuario (click/touch/keydown)
//   - Listener unificado que:
//     1. Desbloquea audio con play/pause silencioso
//     2. Oculta el overlay con animación
//     3. Re-evalúa si hay que disparar alarma pendiente
//
// Cambios heredados de v3.1:
//   - Estado "sin-dato" (azul apagado) a los 10s sin pulsos
//   - Pulso visual verde siempre que cae semilla
//     (brillante con monitoreo, atenuado en stand-by)
//   - Listener de monitoreo_estado para toggle de badge
// ============================================================

(function () {
  "use strict";

  const socket = io();
  window.socket = socket;

  const sensores = (APP_CONFIG.mapeo_sensores || []).filter(s => s.is_active !== false);
  const setup = APP_CONFIG.setup || {};
  const ESP = ["turbina", "rotacion_eje", "tolva_vacia", "bajada_herramienta", "bateria"];

  // ── Config de timings ──
  const SIN_DATO_MS      = 10000;
  const PULSE_VISUAL_MS  = 500;
  const CHECK_SIN_DATO_MS = 1000;

  // ── Estado global ──
  let monitoreoActivo = false;
  const ultimoPulsoVisual = {};

  // ═══════════════════════════════════════════
  // OVERLAY INICIAL — Activación de audio
  // ═══════════════════════════════════════════
  const overlay = document.getElementById("audio-unlock-overlay");
  let _audioDesbloqueado = false;

  const alarma = new Audio("/sounds/alarma1.mp3");
  alarma.loop = true;
  let isMuted = false;
  let alarmPlaying = false;

  function _desbloquearAudioYCerrarOverlay() {
    if (_audioDesbloqueado) return;

    // Silent play/pause para desbloquear el audio context
    alarma.play().then(() => {
      alarma.pause();
      alarma.currentTime = 0;
      _audioDesbloqueado = true;
      console.log("[Bar] Audio desbloqueado");

      // Si ya había fallas pendientes, disparar alarma
      gestionarAlarma();
    }).catch((err) => {
      // Igual lo marcamos como desbloqueado para no quedar trabados
      // con el overlay si por algún motivo no se puede reproducir.
      console.warn("[Bar] No se pudo desbloquear audio:", err.message);
      _audioDesbloqueado = true;
    });

    // Cerrar overlay con animación (independiente del resultado del audio)
    if (overlay) {
      overlay.classList.add("dismissed");
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 500);
    }
  }

  // Listeners sobre el overlay (tiene que ser primero que document
  // para que capture el evento antes que todo)
  if (overlay) {
    overlay.addEventListener("click", _desbloquearAudioYCerrarOverlay);
    overlay.addEventListener("touchstart", _desbloquearAudioYCerrarOverlay, { passive: true });
  }
  // Fallback: también escuchar teclas al nivel de document
  document.addEventListener("keydown", _desbloquearAudioYCerrarOverlay);

  // ═══════════════════════════════════════════
  // CONEXIÓN
  // ═══════════════════════════════════════════
  socket.on("connect", () => {
    document.getElementById("tb-st").textContent = "· Conectado";
    document.getElementById("tb-st").style.color = "#333";
  });
  socket.on("disconnect", () => {
    document.getElementById("tb-st").textContent = "· Desconectado";
    document.getElementById("tb-st").style.color = "#ff1744";
  });

  // ═══════════════════════════════════════════
  // ESTADO DE MONITOREO (badge en header)
  // ═══════════════════════════════════════════
  socket.on("monitoreo_estado", (data) => {
    monitoreoActivo = !!data.activo;

    const badge = document.getElementById("mon-badge");
    const text  = document.getElementById("mon-text");
    if (!badge || !text) return;

    if (data.activo) {
      badge.className = "mon-badge activo";
      text.textContent = "MONITOREANDO";
      badge.title = `Monitoreo activo — ${data.razon || ""}`;
    } else {
      badge.className = "mon-badge standby";
      text.textContent = "STAND-BY";
      badge.title = `En espera — ${data.razon || "sin actividad"}`;
    }

    document.body.classList.toggle("monitoreando", !!data.activo);
  });

  // ═══════════════════════════════════════════
  // AUTO-RELOAD al cambiar perfil
  // ═══════════════════════════════════════════
  socket.on("profile_changed", () => {
    console.log("[Bar] Perfil cambiado — recargando...");
    setTimeout(() => location.reload(), 500);
  });

  // ═══════════════════════════════════════════
  // SENSORES ESPECIALES (RPM, ejes, tolvas)
  // ═══════════════════════════════════════════
  const espMap = {};
  sensores.forEach(s => {
    if (!ESP.includes(s.tipo)) return;
    let id = null;
    if (s.tipo === "turbina") id = "rpm";
    else if (s.tipo === "rotacion_eje") id = s.bajada <= 1 ? "eje1" : "eje2";
    else if (s.tipo === "tolva_vacia") id = s.bajada <= 1 ? "tolva1" : "tolva2";
    if (id) {
      document.getElementById("ei-" + id).style.display = "flex";
      espMap[s.tipo + "-" + s.bajada] = document.getElementById("ev-" + id);
    }
  });

  // ═══════════════════════════════════════════
  // AGRUPAR SENSORES POR SURCO
  // ═══════════════════════════════════════════
  const surcos = {};
  sensores.forEach(s => {
    if (ESP.includes(s.tipo)) return;
    const b = s.bajada;
    if (!surcos[b]) surcos[b] = { bajada: b, tren: s.tren || 1, fl: false, fc: false };
    if (s.tipo === "ferti_linea") surcos[b].fl = true;
    if (s.tipo === "ferti_costado") surcos[b].fc = true;
    surcos[b].tren = s.tren || surcos[b].tren;
  });

  const lista = Object.values(surcos).sort((a, b) => parseInt(a.bajada) - parseInt(b.bajada));
  const trenes = [...new Set(lista.map(s => String(s.tren)))].sort();
  const trenDel = trenes[0] || "1";

  function obj(t) {
    const p = setup.objetivos_tren;
    if (p && p[t] !== undefined) return parseFloat(p[t]);
    return parseFloat(setup.densidad_objetivo) || 16;
  }
  const tol = parseFloat(setup.tolerancia_desvio) || 20;

  // ═══════════════════════════════════════════
  // CONSTRUIR TUBOS EN EL DOM
  // ═══════════════════════════════════════════
  const elTop = document.getElementById("tren-top");
  const elBot = document.getElementById("tren-bot");
  const map = {};
  const fallas = new Set();
  const sensoresOmitidos = new Set();

  function _keyBar(b, tren) { return 'T' + (tren || 1) + '-' + b; }

  try {
    const saved = JSON.parse(localStorage.getItem('vx_sensores_omitidos') || '[]');
    saved.forEach(k => sensoresOmitidos.add(k));
  } catch(e) {}

  lista.forEach(s => {
    const c = String(s.tren) === String(trenDel) ? elTop : elBot;
    const d = document.createElement("div");
    d.className = "t sin-dato";
    d.innerHTML =
      '<div class="n">' + s.bajada + '</div>' +
      '<div class="b">' +
        '<div class="ld">' +
          (s.fl ? '<div class="l" id="ll-' + s.bajada + '"></div>' : '<div class="l"></div>') +
          (s.fc ? '<div class="l" id="lc-' + s.bajada + '"></div>' : '<div class="l"></div>') +
        '</div>' +
        '<div class="fl" id="f-' + s.bajada + '" style="height:5%;background:#111"></div>' +
      '</div>';
    d.onclick = () =>
      window.open(
        "/detalle-surco?bajada=" + s.bajada + "&tren=" + s.tren + "&tipo=semilla",
        "s_" + s.bajada,
        "width=350,height=500"
      );
    c.appendChild(d);
    map[s.bajada] = { el: d, tren: s.tren };
  });

  if (!elBot.children.length) elBot.style.display = "none";
  if (!elTop.children.length) elTop.style.display = "none";

  // ═══════════════════════════════════════════
  // GESTIÓN DE ALARMA
  // ═══════════════════════════════════════════
  function gestionarAlarma() {
    if (isMuted) return;
    if (fallas.size > 0 && !_audioDesbloqueado) return;
    if (fallas.size > 0 && !alarmPlaying) {
      alarma.play().catch(() => {});
      alarmPlaying = true;
    } else if (fallas.size === 0 && alarmPlaying) {
      alarma.pause();
      alarma.currentTime = 0;
      alarmPlaying = false;
    }
  }

  // ═══════════════════════════════════════════
  // OMISIÓN DESDE VENTANA DETALLE SURCO
  // ═══════════════════════════════════════════
  function _aplicarOmisionBar(bajada, omitidoNuevo) {
    const b = parseInt(bajada);
    const t = map[b];
    if (!t) return;
    const key = _keyBar(b, t.tren);
    const f = document.getElementById("f-" + b);
    if (omitidoNuevo) {
      sensoresOmitidos.add(key);
      fallas.delete(b);
      t.el.className = "t omitido";
      if (f) { f.style.height = "10%"; f.style.background = "#5c3a00"; }
    } else {
      sensoresOmitidos.delete(key);
      t.el.className = "t";
      if (f) { f.style.height = "5%"; f.style.background = "#111"; }
    }
    const pvFallas = document.getElementById("pv-fallas");
    if (pvFallas) pvFallas.textContent = fallas.size;
    gestionarAlarma();
  }

  socket.on("sensor_omision_update", data => {
    _aplicarOmisionBar(data.bajada, data.omitido);
  });

  try {
    const _bcBar = new BroadcastChannel('vistax_omision');
    _bcBar.onmessage = (ev) => {
      _aplicarOmisionBar(ev.data.bajada, ev.data.omitido);
    };
  } catch(e) {}

  window.toggleMuteBar = function () {
    isMuted = !isMuted;
    if (isMuted) {
      alarma.pause();
      alarma.currentTime = 0;
      alarmPlaying = false;
    } else {
      gestionarAlarma();
    }
    const btn = document.getElementById("tb-mute-icon");
    if (btn) btn.className = isMuted ? "fas fa-volume-mute" : "fas fa-volume-up";
  };

  // ═══════════════════════════════════════════
  // PULSO VISUAL (siempre que cae semilla)
  // ═══════════════════════════════════════════
  function _flashPulso(elem, bajada) {
    if (!elem) return;

    // Quitar sin-dato ANTES del flash para que no compita con !important
    elem.classList.remove("sin-dato", "pulse-mon", "pulse-standby");
    void elem.offsetWidth; // forzar reflow

    if (monitoreoActivo) {
      elem.classList.add("pulse-mon");
    } else {
      elem.classList.add("pulse-standby");
    }

    ultimoPulsoVisual[bajada] = Date.now();

    setTimeout(() => {
      elem.classList.remove("pulse-mon", "pulse-standby");
    }, PULSE_VISUAL_MS);
  }

  // ═══════════════════════════════════════════
  // EVALUACIÓN DE ESTADO SIN-DATO (cada 1s)
  // ═══════════════════════════════════════════
  setInterval(() => {
    const ahora = Date.now();
    for (const b in map) {
      const t = map[b];
      const key = _keyBar(b, t.tren);

      if (sensoresOmitidos.has(key)) continue;
      if (t.el.classList.contains("f")) continue;
      if (t.el.classList.contains("cortado")) continue;
      if (t.el.classList.contains("pulse-mon") || t.el.classList.contains("pulse-standby")) continue;

      const ultimo = ultimoPulsoVisual[b] || 0;
      const sinDato = (ahora - ultimo) > SIN_DATO_MS;

      if (sinDato) {
        if (!t.el.classList.contains("sin-dato")) {
          t.el.classList.add("sin-dato");
          const f = document.getElementById("f-" + b);
          if (f) { f.style.height = "5%"; f.style.background = "#111"; }
        }
      } else {
        t.el.classList.remove("sin-dato");
      }
    }
  }, CHECK_SIN_DATO_MS);

  // ═══════════════════════════════════════════
  // RECEPCIÓN DE DATOS EN TIEMPO REAL
  // ═══════════════════════════════════════════
  socket.on("sensor_update", data => {
    const b = parseInt(data.bajada);
    const ek = data.tipo + "-" + data.bajada;
    const rawPulsos = parseInt(data.nuevas_semillas) || 0;

    // ── Sensores especiales ──
    if (espMap[ek]) {
      espMap[ek].textContent = parseFloat(data.valor).toFixed(0);
      espMap[ek].className = "vl" + (parseFloat(data.valor) > 0 ? " ok" : " warn");
      return;
    }

    const t = map[b];
    if (!t) return;

    // ── LEDs de ferti ──
    if (data.tipo === "ferti_linea") {
      const e = document.getElementById("ll-" + b);
      if (e) e.className = "l" + (parseFloat(data.valor) > 0 ? " lg" : "");
      if (rawPulsos > 0) _flashPulso(t.el, b);
      return;
    }
    if (data.tipo === "ferti_costado") {
      const e = document.getElementById("lc-" + b);
      if (e) e.className = "l" + (parseFloat(data.valor) > 0 ? " lb" : "");
      if (rawPulsos > 0) _flashPulso(t.el, b);
      return;
    }

    // ── Semilla: flash SIEMPRE que caen pulsos ──
   ultimoPulsoVisual[b] = Date.now();
    t.el.classList.remove("sin-dato");

    if (rawPulsos > 0) {
      _flashPulso(t.el, b);
    }

    const spm = parseFloat(data.spm) || 0;
    const o = obj(t.tren);
    const f = document.getElementById("f-" + b);
    let c = "#111", p = 5;

    if (sensoresOmitidos.has(_keyBar(b, t.tren))) {
      t.el.className = "t omitido";
      fallas.delete(b);
      if (f) { f.style.height = "10%"; f.style.background = "#5c3a00"; }
      document.getElementById("pv-fallas").textContent = fallas.size;
      gestionarAlarma();
      return;
    }

    if (data.seccion_cortada) {
      c = "#2d2d2d"; p = 8;
      const claseBase = (ultimoPulsoVisual[b] && (Date.now() - ultimoPulsoVisual[b]) < SIN_DATO_MS)
        ? "t cortado"
        : "t cortado sin-dato";
      t.el.className = claseBase;
      fallas.delete(b);
    } else {
      if (data.alerta) {
        c = "#ff1744"; p = 15;
        t.el.className = "t f";
        fallas.add(b);
      } else if (spm > 0) {
        const dv = Math.abs((spm - o) / o) * 100;
        p = Math.max(10, Math.min(95, (spm / o) * 75));
        if (o > 0 && dv > tol) {
          c = "#ffb300";
          t.el.className = "t d";
        } else {
          c = "#00e676";
          t.el.className = "t";
        }
        fallas.delete(b);
      } else {
        t.el.classList.remove("f", "d", "cortado", "omitido");
        fallas.delete(b);
      }
    }

    if (f) { f.style.height = p + "%"; f.style.background = c; }
    document.getElementById("pv-fallas").textContent = fallas.size;
    gestionarAlarma();
  });

  socket.on("global_update", s => {
    if (s.velocidad !== undefined)
      document.getElementById("pv-vel").textContent = parseFloat(s.velocidad).toFixed(1);
    if (s.promedio !== undefined)
      document.getElementById("pv-spm").textContent = parseFloat(s.promedio).toFixed(1);
  });

})();

// ═══════════════════════════════════════════
// DRAG VIA POSTMESSAGE — WebView2 Shell
// ═══════════════════════════════════════════
(function () {
  const dragZone = document.querySelector(".drag");
  if (!dragZone) return;

  dragZone.addEventListener("mousedown", function () {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage("dragstart");
    }
  });
  document.addEventListener("mouseup", function () {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage("dragend");
    }
  });

  dragZone.addEventListener("touchstart", function () {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage("dragstart");
    }
  }, { passive: true });
  document.addEventListener("touchend", function () {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage("dragend");
    }
  });
})();
