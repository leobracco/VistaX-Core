// ============================================================
// VistaX — bar.js
// Lógica para la vista barra (695×150 — VistaXShell / CefSharp)
// Depende de: Socket.IO, window.APP_CONFIG
// ============================================================

(function () {
  "use strict";

  const socket = io();
  window.socket = socket;

  const sensores = (APP_CONFIG.mapeo_sensores || []).filter(s => s.is_active !== false);
  const setup = APP_CONFIG.setup || {};
  const ESP = ["turbina", "rotacion_eje", "tolva_vacia", "bajada_herramienta", "bateria"];

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
  // AUTO-RELOAD al cambiar perfil o guardar config
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
  // AGRUPAR SENSORES POR SURCO (bajada)
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

  const lista = Object.values(surcos).sort((a, b) => a.bajada - b.bajada);
  const trenes = [...new Set(lista.map(s => s.tren))].sort((a, b) => a - b);
  const trenDel = trenes[0] || 1;

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
    const c = s.tren === trenDel ? elTop : elBot;
    const d = document.createElement("div");
    d.className = "t";
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
  // ALARMA SONORA
  // ═══════════════════════════════════════════
  const alarma = new Audio("/sounds/alarma1.mp3");
  alarma.loop = true;
  let isMuted = false;
  let alarmPlaying = false;
  let _audioDesbloqueado = false;

  function _desbloquearAudio() {
    if (_audioDesbloqueado) return;
    alarma.play().then(() => {
      alarma.pause();
      alarma.currentTime = 0;
      _audioDesbloqueado = true;
      gestionarAlarma();
    }).catch(() => {});
  }
  document.addEventListener("click",     _desbloquearAudio, { once: false });
  document.addEventListener("touchstart", _desbloquearAudio, { once: false });
  document.addEventListener("keydown",   _desbloquearAudio, { once: false });

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
      t.el.style.opacity = "";
      if (f) { f.style.height = "10%"; f.style.background = "#5c3a00"; }
    } else {
      sensoresOmitidos.delete(key);
      t.el.className = "t";
      t.el.style.opacity = "";
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
  // RECEPCIÓN DE DATOS EN TIEMPO REAL
  // ═══════════════════════════════════════════
  socket.on("sensor_update", data => {
    const b = parseInt(data.bajada);
    const ek = data.tipo + "-" + data.bajada;

    if (espMap[ek]) {
      espMap[ek].textContent = parseFloat(data.valor).toFixed(0);
      espMap[ek].className = "vl" + (parseFloat(data.valor) > 0 ? " ok" : " warn");
      return;
    }

    const t = map[b];
    if (!t) return;

    if (data.tipo === "ferti_linea") {
      const e = document.getElementById("ll-" + b);
      if (e) e.className = "l" + (parseFloat(data.valor) > 0 ? " lg" : "");
      return;
    }
    if (data.tipo === "ferti_costado") {
      const e = document.getElementById("lc-" + b);
      if (e) e.className = "l" + (parseFloat(data.valor) > 0 ? " lb" : "");
      return;
    }

    const spm = parseFloat(data.spm) || 0;
    const o = obj(t.tren);
    const f = document.getElementById("f-" + b);
    let c = "#111", p = 5;

    // Sensor omitido
    if (sensoresOmitidos.has(_keyBar(b, t.tren))) {
      t.el.className = "t omitido";
      t.el.style.opacity = "";
      fallas.delete(b);
      if (f) { f.style.height = "10%"; f.style.background = "#5c3a00"; }
      document.getElementById("pv-fallas").textContent = fallas.size;
      gestionarAlarma();
      return;
    }

    // Sección cortada
    if (data.seccion_cortada) {
      c = "#2d2d2d"; p = 8;
      t.el.className = "t cortado";
      t.el.style.opacity = "";
      fallas.delete(b);
    } else {
      t.el.className = "t";
      t.el.style.opacity = "";
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
        t.el.className = "t";
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
