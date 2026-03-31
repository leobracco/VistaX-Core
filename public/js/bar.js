// ============================================================
// VistaX — bar.js
// Lógica para la vista barra (695×150 — VistaXShell)
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

  function gestionarAlarma() {
    if (isMuted) return;
    if (fallas.size > 0 && !alarmPlaying) {
      alarma.play().catch(() => {});
      alarmPlaying = true;
    } else if (fallas.size === 0 && alarmPlaying) {
      alarma.pause();
      alarma.currentTime = 0;
      alarmPlaying = false;
    }
  }

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

    // Especiales
    if (espMap[ek]) {
      espMap[ek].textContent = parseFloat(data.valor).toFixed(0);
      espMap[ek].className = "vl" + (parseFloat(data.valor) > 0 ? " ok" : " warn");
      return;
    }

    const t = map[b];
    if (!t) return;

    // Ferti LEDs
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

    // Semilla — estado del tubo
    const spm = parseFloat(data.spm) || 0;
    const o = obj(t.tren);
    const f = document.getElementById("f-" + b);
    let c = "#111", p = 5;

    // Sección cortada por AOG → apagar tubo, sin alarma
    if (data.seccion_cortada) {
      c = "#0a0a0a"; p = 3;
      t.el.className = "t";
      t.el.style.opacity = "0.15";
      fallas.delete(b);
    } else {
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

  // Touch
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
