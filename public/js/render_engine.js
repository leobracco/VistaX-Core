// ============================================================
// VistaX — render_engine.js  v5.1
// FIX: IDs incluyen tren → surco-col-T{tren}-{bajada}
// ============================================================

const socket = io();
window.socket = socket;

let fallasActivas = new Set();
let surcosConFalla = new Set();
let datosSurcos = {};
let modoCompacto = "normal";
let isMuted = false;
let playingAlarm = false;
let trenesDeshabilitados = new Set();
let sensoresOmitidos = new Set();
let loteTimerInterval = null;
let loteInicioTs = null;

try {
  const saved = localStorage.getItem("vx_sensores_omitidos");
  if (saved) sensoresOmitidos = new Set(JSON.parse(saved));
  const savedTrenes = localStorage.getItem("vx_trenes_deshabilitados");
  if (savedTrenes) trenesDeshabilitados = new Set(JSON.parse(savedTrenes));
} catch (e) {}

function _guardarOmisiones() {
  try {
    localStorage.setItem(
      "vx_sensores_omitidos",
      JSON.stringify([...sensoresOmitidos]),
    );
    localStorage.setItem(
      "vx_trenes_deshabilitados",
      JSON.stringify([...trenesDeshabilitados]),
    );
  } catch (e) {}
}

const TIPOS_ESPECIALES = {
  rotacion_eje: { icono: "fas fa-cogs", unidad: "RPM" },
  turbina: { icono: "fas fa-fan", unidad: "RPM" },
  bajada_herramienta: { icono: "fas fa-arrow-down", unidad: "ESTADO" },
  bateria: { icono: "fas fa-car-battery", unidad: "V" },
  tolva_vacia: { icono: "fas fa-archive", unidad: "ESTADO" },
};

function _sensorKey(bajada, tren) {
  return `T${tren || 1}-${bajada}`;
}

function _buscarTren(bajada, tipo) {
  const cfg = APP_CONFIG?.mapeo_sensores?.find(
    (s) => s.bajada === parseInt(bajada) && s.tipo === tipo,
  );
  return cfg?.tren || 1;
}

const audioAlarma = document.createElement("audio");
audioAlarma.id = "audio-alarma";
audioAlarma.src = "/sounds/alarma1.mp3";
audioAlarma.loop = true;
document.body.appendChild(audioAlarma);

window.toggleMute = function () {
  isMuted = !isMuted;
  const icon = document.querySelector(
    ".actions .btn-tool i.fa-volume-up, .actions .btn-tool i.fa-volume-mute",
  );
  if (icon) {
    icon.className = isMuted ? "fas fa-volume-mute" : "fas fa-volume-up";
    icon.style.color = isMuted ? "var(--danger)" : "";
  }
  isMuted ? audioAlarma.pause() : gestionarSonidoAlarma();
};

function gestionarSonidoAlarma() {
  if (isMuted) return;
  if (fallasActivas.size > 0) {
    if (!playingAlarm) {
      audioAlarma.play().catch(() => {});
      playingAlarm = true;
    }
  } else {
    audioAlarma.pause();
    audioAlarma.currentTime = 0;
    playingAlarm = false;
  }
}

function _sensorActivo(bajada, tren) {
  const key = _sensorKey(bajada, tren);
  const cfg = APP_CONFIG?.mapeo_sensores?.find(
    (s) =>
      s.bajada === parseInt(bajada) && (s.tren || 1) === parseInt(tren || 1),
  );
  if (cfg && cfg.is_active === false) return false;
  if (sensoresOmitidos.has(key)) return false;
  if (trenesDeshabilitados.has(parseInt(tren || 1))) return false;
  return true;
}

function _contarSensoresOnline() {
  if (!APP_CONFIG?.mapeo_sensores) return { total: 0, activos: 0 };
  const tiposSiembra = ["semilla", "ferti_linea", "ferti_costado"];
  const todos = APP_CONFIG.mapeo_sensores.filter((s) =>
    tiposSiembra.includes(s.tipo),
  );
  let total = 0,
    activos = 0;
  todos.forEach((s) => {
    if (s.is_active === false) return;
    total++;
    if (_sensorActivo(s.bajada, s.tren || 1)) activos++;
  });
  return { total, activos };
}

function _actualizarKPIOnline() {
  const { total, activos } = _contarSensoresOnline();
  const el = document.getElementById("kpi-online");
  if (el) el.textContent = `${activos} / ${total}`;
  window.TOTAL_SURCOS = activos;
}

function _objetivoTren(numTren) {
  const porTren = APP_CONFIG?.setup?.objetivos_tren;
  if (porTren && porTren[numTren] !== undefined)
    return parseFloat(porTren[numTren]);
  return parseFloat(APP_CONFIG?.setup?.densidad_objetivo) || 16;
}

function _toleranciaDesvio() {
  return parseFloat(APP_CONFIG?.setup?.tolerancia_desvio) || 20;
}

function detectarModo() {
  const t = window.TOTAL_SURCOS || 0;
  return t > 96 ? "mini" : t > 48 ? "compact" : "normal";
}

window.toggleModoCompacto = function () {
  const modos = ["normal", "compact", "mini"];
  modoCompacto = modos[(modos.indexOf(modoCompacto) + 1) % modos.length];
  aplicarModo(modoCompacto);
};

function aplicarModo(modo) {
  const grid = document.getElementById("main-monitor");
  if (!grid) return;
  grid.classList.remove("modo-compact", "modo-mini");
  if (modo === "compact") grid.classList.add("modo-compact");
  if (modo === "mini") grid.classList.add("modo-mini");
}

// TOGGLE LOTE
function _inicializarToggleLote() {
  const btn = document.getElementById("btn-toggle-lote");
  if (!btn) return;
  if (window.LOTE_ACTIVO?.activo || window.LOTE_ACTIVO?.id) {
    _setLoteVisualActivo(true);
    loteInicioTs = window.LOTE_ACTIVO.inicio
      ? new Date(window.LOTE_ACTIVO.inicio).getTime()
      : Date.now();
    _iniciarTimer();
  }
  btn.onclick = () => {
    if (window.LoteManager?.hayLoteActivo()) {
      if (typeof window.cerrarLoteDesdeMonitor === "function")
        window.cerrarLoteDesdeMonitor();
    } else {
      if (typeof window.abrirModalLote === "function") window.abrirModalLote();
    }
  };
}

function _setLoteVisualActivo(activo) {
  const btn = document.getElementById("btn-toggle-lote"),
    icon = document.getElementById("lote-toggle-icon"),
    label = document.getElementById("lote-toggle-label"),
    timer = document.getElementById("lote-toggle-timer");
  if (!btn) return;
  if (activo) {
    btn.classList.add("lote-activo");
    btn.classList.remove("lote-inactivo");
    btn.title = "Click para CERRAR lote";
    if (icon) icon.className = "fas fa-stop";
    if (label) label.textContent = "GRABANDO";
    if (timer) timer.style.display = "inline";
  } else {
    btn.classList.remove("lote-activo");
    btn.classList.add("lote-inactivo");
    btn.title = "Click para INICIAR lote";
    if (icon) icon.className = "fas fa-play";
    if (label) label.textContent = "SIN LOTE";
    if (timer) {
      timer.style.display = "none";
      timer.textContent = "00:00";
    }
    _detenerTimer();
  }
}

function _iniciarTimer() {
  _detenerTimer();
  if (!loteInicioTs) loteInicioTs = Date.now();
  loteTimerInterval = setInterval(() => {
    const e = Math.floor((Date.now() - loteInicioTs) / 1000),
      h = Math.floor(e / 3600),
      m = Math.floor((e % 3600) / 60),
      s = e % 60;
    const t = document.getElementById("lote-toggle-timer");
    if (t)
      t.textContent =
        h > 0
          ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, 1000);
}
function _detenerTimer() {
  if (loteTimerInterval) {
    clearInterval(loteTimerInterval);
    loteTimerInterval = null;
  }
  loteInicioTs = null;
}

socket.on("lote_update", (data) => {
  if (data.activo) {
    _setLoteVisualActivo(true);
    loteInicioTs = data.inicio ? new Date(data.inicio).getTime() : Date.now();
    _iniciarTimer();
  } else {
    _setLoteVisualActivo(false);
  }
});

// TRENES
function _crearSwitchTren(numTren) {
  const checked = !trenesDeshabilitados.has(numTren);
  return `<label class="tren-switch" title="${checked ? "Deshabilitar" : "Habilitar"} tren ${numTren}"><input type="checkbox" id="tren-switch-${numTren}" ${checked ? "checked" : ""} onchange="toggleTrenHabilitado(${numTren}, this.checked)"><span class="tren-switch-slider"></span></label>`;
}

window.toggleTrenHabilitado = function (numTren, hab) {
  hab
    ? trenesDeshabilitados.delete(numTren)
    : trenesDeshabilitados.add(numTren);
  _guardarOmisiones();
  if (APP_CONFIG?.mapeo_sensores) {
    APP_CONFIG.mapeo_sensores.forEach((s) => {
      if ((s.tren || 1) === numTren) {
        const key = _sensorKey(s.bajada, numTren);
        const col = document.getElementById(`surco-col-${key}`);
        if (col) {
          col.classList.toggle("sensor-omitido", !hab);
          if (!hab) {
            fallasActivas.delete(`s-${s.tipo}-${s.bajada}`);
            surcosConFalla.delete(key);
          }
        }
      }
    });
  }
  _actualizarKPIOnline();
  _actualizarTicker();
  gestionarSonidoAlarma();
};

// OMISIÓN
window.toggleOmitirSensor = function (bajada, tren) {
  tren = parseInt(tren || 1);
  bajada = parseInt(bajada);
  const key = _sensorKey(bajada, tren);
  sensoresOmitidos.has(key)
    ? sensoresOmitidos.delete(key)
    : sensoresOmitidos.add(key);
  _guardarOmisiones();
  const col = document.getElementById(`surco-col-${key}`);
  if (col) col.classList.toggle("sensor-omitido", sensoresOmitidos.has(key));
  if (sensoresOmitidos.has(key)) {
    APP_CONFIG.mapeo_sensores?.forEach((s) => {
      if (s.bajada === bajada && (s.tren || 1) === tren) {
        fallasActivas.delete(`s-${s.tipo}-${s.bajada}`);
        surcosConFalla.delete(key);
      }
    });
    gestionarSonidoAlarma();
  }
  _actualizarKPIOnline();
  _actualizarTicker();
};

function _hookContextMenu(surcoCol, bajada, tren) {
  surcoCol.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const key = _sensorKey(bajada, tren);
    if (
      confirm(
        sensoresOmitidos.has(key)
          ? `¿Reactivar bajada ${bajada}?`
          : `¿Omitir bajada ${bajada}?`,
      )
    )
      toggleOmitirSensor(bajada, tren);
  });
  let pt;
  surcoCol.addEventListener(
    "touchstart",
    (e) => {
      pt = setTimeout(() => {
        e.preventDefault();
        const key = _sensorKey(bajada, tren);
        if (
          confirm(
            sensoresOmitidos.has(key)
              ? `¿Reactivar bajada ${bajada}?`
              : `¿Omitir bajada ${bajada}?`,
          )
        )
          toggleOmitirSensor(bajada, tren);
      }, 700);
    },
    { passive: false },
  );
  surcoCol.addEventListener("touchend", () => clearTimeout(pt));
  surcoCol.addEventListener("touchmove", () => clearTimeout(pt));
}

// ============================================================
// INICIALIZACIÓN UI
// ============================================================
function inicializarUI() {
  if (!APP_CONFIG || !APP_CONFIG.mapeo_sensores) return;

  const txtMaquina = document.getElementById("txt-maquina");
  if (txtMaquina) txtMaquina.innerText = APP_CONFIG.nombre || "DESCONOCIDA";

  const inputObjetivo = document.getElementById("input-objetivo");
  if (inputObjetivo && APP_CONFIG.setup?.densidad_objetivo)
    inputObjetivo.value = APP_CONFIG.setup.densidad_objetivo;

  modoCompacto = detectarModo();

  const sensoresActivos = APP_CONFIG.mapeo_sensores.filter(
    (s) => s.is_active !== false,
  );
  const sensoresOrdenados = [...sensoresActivos].sort(
    (a, b) => a.bajada - b.bajada,
  );
  const monitorGrid = document.getElementById("main-monitor");

  // N TRENES — orden ascendente
  const trenesUsados = [
    ...new Set(
      sensoresOrdenados
        .filter((s) => !TIPOS_ESPECIALES.hasOwnProperty(s.tipo))
        .map((s) => s.tren || 1),
    ),
  ].sort((a, b) => a - b);

  trenesUsados.forEach((numTren) => {
    const rowId = `tren-row-${numTren}`;
    if (document.getElementById(rowId)) return;
    const wrapper = document.createElement("div");
    wrapper.className = "tren-row-wrapper";
    let etiqueta;
    if (trenesUsados.length === 1) etiqueta = "TREN";
    else if (trenesUsados.length === 2)
      etiqueta =
        numTren === Math.min(...trenesUsados)
          ? "TREN (DELANTERO)"
          : "TREN (TRASERO)";
    else etiqueta = `TREN ${numTren}`;
    const objTren = _objetivoTren(numTren);
    wrapper.innerHTML = `<div class="tren-title"><span>${etiqueta} <span class="tren-obj-badge">obj: ${objTren} s/m</span></span><div class="tren-title-actions">${_crearSwitchTren(numTren)}</div></div><div class="tren-row" id="${rowId}"></div>`;
    monitorGrid.appendChild(wrapper);
  });

  // CREAR SURCOS — colId incluye TREN
  sensoresOrdenados.forEach((sensor) => {
    const numTren = sensor.tren || 1;
    const key = _sensorKey(sensor.bajada, numTren);
    const surcoId = `s-${sensor.tipo}-${sensor.bajada}`;
    const colId = `surco-col-${key}`;
    const isEspecial = TIPOS_ESPECIALES.hasOwnProperty(sensor.tipo);

    if (isEspecial) {
      const container = document.getElementById("tren-especiales");
      if (container && !document.getElementById(surcoId)) {
        const card = document.createElement("div");
        card.id = surcoId;
        card.className = "sensor-especial";
        card.innerHTML = `<i class="${TIPOS_ESPECIALES[sensor.tipo].icono}"></i><div class="info"><span>${sensor.nombre || sensor.tipo.replace(/_/g, " ")}</span><strong class="val-text">—</strong></div>`;
        container.appendChild(card);
      }
    } else if (monitorGrid) {
      const rowId = `tren-row-${numTren}`;
      const rowContainer = document.getElementById(rowId);
      if (!rowContainer) return;

      let surcoCol = document.getElementById(colId);
      if (!surcoCol) {
        surcoCol = document.createElement("div");
        surcoCol.id = colId;
        surcoCol.className = "surco-column";
        surcoCol.onclick = () =>
          abrirDetalleSurco(sensor.bajada, sensor.tipo, numTren);
        if (!_sensorActivo(sensor.bajada, numTren))
          surcoCol.classList.add("sensor-omitido");
        const numPar = sensor.bajada % 2 === 0;
        surcoCol.innerHTML = `<div class="surco-id${numPar ? " par" : ""}">${sensor.bajada}</div><div class="pills-area"><div class="led-ferti led-ferti-linea" id="led-fl-${key}" title="Ferti Línea"></div><div class="led-ferti led-ferti-costado" id="led-fc-${key}" title="Ferti Costado"></div></div><div class="surco-val-num" id="val-${key}">—</div>`;
        rowContainer.appendChild(surcoCol);
        _hookContextMenu(surcoCol, sensor.bajada, numTren);
      }

      const pillsArea = surcoCol.querySelector(".pills-area");
      if (pillsArea && !document.getElementById(surcoId)) {
        const pill = document.createElement("div");
        pill.id = surcoId;
        const tipoClass =
          sensor.tipo === "ferti_linea"
            ? "pill-ferti-linea"
            : sensor.tipo === "ferti_costado"
              ? "pill-ferti-costado"
              : "";
        pill.className = `pill-status status-tapado ${tipoClass}`.trim();
        pill.title = sensor.nombre || `${sensor.tipo} #${sensor.bajada}`;
        pillsArea.appendChild(pill);
      }
    }
  });

  aplicarModo(modoCompacto);
  _actualizarKPIOnline();
  _inicializarToggleLote();
  const btnModo = document.getElementById("btn-modo");
  if (btnModo && _contarSensoresOnline().total > 20)
    btnModo.style.display = "flex";
}

window.toggleTren = function (rowId) {
  const row = document.getElementById(rowId);
  if (row) row.style.display = row.style.display === "none" ? "flex" : "none";
};

inicializarUI();

// ============================================================
// RECEPCIÓN DE DATOS EN TIEMPO REAL
// ============================================================
socket.on("sensor_update", (data) => {
  const tren = data.tren || _buscarTren(data.bajada, data.tipo);
  const key = _sensorKey(data.bajada, tren);

  // DEBUG: Log para sensores especiales
  if (TIPOS_ESPECIALES[data.tipo]) {
    console.log(
      `🔧 [ESPECIAL] ${data.tipo} bajada:${data.bajada} valor:${data.valor} spm:${data.spm}`,
    );
  }

  if (!datosSurcos[key])
    datosSurcos[key] = {
      total_semillas: 0,
      spm: 0,
      ferti_linea: false,
      ferti_costado: false,
    };
  datosSurcos[key].total_semillas += data.nuevas_semillas || 0;
  datosSurcos[key].spm = data.spm || 0;

  if (data.tipo === "ferti_linea") {
    datosSurcos[key].ferti_linea = parseFloat(data.valor) > 0;
    const led = document.getElementById(`led-fl-${key}`);
    if (led) led.classList.toggle("led-on", datosSurcos[key].ferti_linea);
  }
  if (data.tipo === "ferti_costado") {
    datosSurcos[key].ferti_costado = parseFloat(data.valor) > 0;
    const led = document.getElementById(`led-fc-${key}`);
    if (led) led.classList.toggle("led-on", datosSurcos[key].ferti_costado);
  }

  const surcoId = `s-${data.tipo}-${data.bajada}`;
  const el = document.getElementById(surcoId);
  if (el) {
    if (TIPOS_ESPECIALES[data.tipo]) {
      // Sensores especiales: actualizar val-text directamente, sin pipeline de alarmas
      const vt = el.querySelector(".val-text");
      if (vt) vt.innerText = parseFloat(data.valor) > 0 ? data.valor : "—";
      // Visual: si valor > 0, poner color accent; sino gris
      if (vt)
        vt.style.color = parseFloat(data.valor) > 0 ? "var(--accent)" : "#555";
    } else {
      // Sensores normales (semilla, ferti): pipeline completo de alarmas/desvío
      actualizarPastillaEstado(el, data, tren, key);
    }
  }

  const md = document.getElementById("surco-modal-detalle");
  if (md?.style.display === "flex" && md.dataset.key === key) {
    const es = document.getElementById("detalle-spm"),
      et = document.getElementById("detalle-total");
    if (es) es.innerText = data.spm;
    if (et)
      et.innerText = datosSurcos[key].total_semillas.toLocaleString("es-AR");
  }
});

socket.on("global_update", (stats) => {
  if (stats.velocidad !== undefined) {
    const el = document.getElementById("txt-vel");
    if (el) el.innerText = parseFloat(stats.velocidad).toFixed(1);
  }
  if (stats.promedio !== undefined) {
    const el = document.getElementById("txt-dosis");
    if (el) el.innerText = parseFloat(stats.promedio).toFixed(1);
  }
});

// ALARMAS + DESVÍO
function actualizarPastillaEstado(el, data, tren, key) {
  const surcoCol = document.getElementById(`surco-col-${key}`);
  const surcoId = el.id;
  const bajada = parseInt(data.bajada);
  const activo = _sensorActivo(bajada, tren);

  el.classList.remove(
    "status-ok",
    "status-alerta",
    "status-tapado",
    "status-desvio",
  );

  if (!activo) {
    el.classList.add("status-tapado");
    el.style.height = "3%";
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(key);
    if (surcoCol) surcoCol.classList.remove("falla", "desvio");
    return;
  }

  const spmVal = parseFloat(data.spm) || 0;
  const objetivo = _objetivoTren(tren);
  const tolerancia = _toleranciaDesvio();

  if (data.alerta) {
    el.classList.add("status-alerta");
    fallasActivas.add(surcoId);
    surcosConFalla.add(key);
    if (surcoCol) {
      surcoCol.classList.add("falla");
      surcoCol.classList.remove("desvio");
    }
  } else if (spmVal > 0) {
    const pctDesvio = Math.abs((spmVal - objetivo) / objetivo) * 100;
    if (objetivo > 0 && pctDesvio > tolerancia) {
      el.classList.add("status-desvio");
      if (surcoCol) {
        surcoCol.classList.add("desvio");
        surcoCol.classList.remove("falla");
      }
      fallasActivas.delete(surcoId);
      surcosConFalla.delete(key);
    } else {
      el.classList.add("status-ok");
      fallasActivas.delete(surcoId);
      surcosConFalla.delete(key);
      if (surcoCol) surcoCol.classList.remove("falla", "desvio");
    }
  } else {
    el.classList.add("status-tapado");
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(key);
    if (surcoCol) surcoCol.classList.remove("falla", "desvio");
  }

  const pctAltura = data.alerta
    ? 15
    : spmVal === 0
      ? 6
      : Math.max(10, Math.min(95, (spmVal / objetivo) * 75));
  el.style.height = pctAltura + "%";

  const valEl = document.getElementById(`val-${key}`);
  if (valEl && data.tipo === "semilla") {
    valEl.textContent = spmVal > 0 ? spmVal : data.alerta ? "!" : "—";
    valEl.style.color = data.alerta
      ? "var(--danger)"
      : el.classList.contains("status-desvio")
        ? "#ffb300"
        : spmVal > 0
          ? "#666"
          : "#333";
  }

  _actualizarTicker();
  const kpiFallas = document.getElementById("kpi-fallas");
  if (kpiFallas) kpiFallas.innerText = fallasActivas.size;
  gestionarSonidoAlarma();
}

function _actualizarTicker() {
  const ticker = document.getElementById("alert-ticker");
  if (!ticker) return;
  if (surcosConFalla.size > 0) {
    const lista = [...surcosConFalla]
      .map((k) => k.split("-")[1])
      .sort((a, b) => parseInt(a) - parseInt(b))
      .join(", ");
    ticker.innerText = `FALLA EN SURCO ${lista}`;
    ticker.classList.add("active-alert");
  } else {
    ticker.innerText = "SISTEMA VISTAX OPERATIVO";
    ticker.classList.remove("active-alert");
  }
}

// DETALLE SURCO
window.abrirDetalleSurco = function (numero, tipo, tren) {
  tren = tren || _buscarTren(numero, tipo);
  const url = `/detalle-surco?bajada=${numero}&tren=${tren}&tipo=${tipo}`;

  // Si estamos en el Shell → abre ventana WPF nueva (350x500)
  // Si estamos en navegador → window.open normal
  window.open(url, `surco_${numero}_${tren}`, "width=280,height=400");
};

window.guardarObjetivoRapido = async function (val) {
  if (!APP_CONFIG) return;
  if (!APP_CONFIG.setup) APP_CONFIG.setup = {};
  APP_CONFIG.setup.densidad_objetivo = parseFloat(val);
  try {
    await fetch("/api/config/maquinas/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(APP_CONFIG),
    });
    const inp = document.getElementById("input-objetivo");
    if (inp) {
      inp.style.backgroundColor = "var(--accent)";
      inp.style.color = "#000";
      setTimeout(() => {
        inp.style.backgroundColor = "#111";
        inp.style.color = "var(--accent)";
      }, 400);
    }
  } catch (e) {
    console.error("Error guardando objetivo", e);
  }
};

socket.on("new_node_detected", (nodoData) => {
  if (typeof window.prepararNuevoNodo === "function")
    window.prepararNuevoNodo(nodoData);
});
