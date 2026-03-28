// ============================================================
// VistaX — render_engine.js  v4
//
// CAMBIOS:
//   1. Toggle lote: botón dual verde/rojo con timer transcurrido
//   2. Trenes unificados: NO se dividen visualmente, cada tren
//      tiene switch Habilitado/Deshabilitado inline
//   3. Sensores omitibles: click derecho o long-press en surco
//      → "Omitir sensor" (modo mantenimiento)
//   4. Alarmas: sensores omitidos NO disparan buzzer ni alerta
//   5. KPI: "36 / 43 Online" dinámico en header
// ============================================================

const socket = io();
window.socket = socket;

// ============================================================
// ESTADO GLOBAL
// ============================================================
let fallasActivas   = new Set();
let surcosConFalla  = new Set();
let datosSurcos     = {};
let modoCompacto    = 'normal';
let isMuted         = false;
let playingAlarm    = false;

// ═══ NUEVO: Estado de trenes y sensores omitidos ═══
let trenesDeshabilitados = new Set();     // trenes apagados por el usuario
let sensoresOmitidos     = new Set();     // bajadas marcadas como "omitir"
let loteTimerInterval    = null;
let loteInicioTs         = null;

// Cargar omisiones desde localStorage
try {
  const saved = localStorage.getItem('vx_sensores_omitidos');
  if (saved) sensoresOmitidos = new Set(JSON.parse(saved));
  const savedTrenes = localStorage.getItem('vx_trenes_deshabilitados');
  if (savedTrenes) trenesDeshabilitados = new Set(JSON.parse(savedTrenes));
} catch(e) {}

function _guardarOmisiones() {
  try {
    localStorage.setItem('vx_sensores_omitidos', JSON.stringify([...sensoresOmitidos]));
    localStorage.setItem('vx_trenes_deshabilitados', JSON.stringify([...trenesDeshabilitados]));
  } catch(e) {}
}

const TIPOS_ESPECIALES = {
  rotacion_eje:       { icono: "fas fa-cogs",        unidad: "RPM"    },
  turbina:            { icono: "fas fa-fan",          unidad: "RPM"    },
  bajada_herramienta: { icono: "fas fa-arrow-down",   unidad: "ESTADO" },
  bateria:            { icono: "fas fa-car-battery",  unidad: "V"      },
  tolva_vacia:        { icono: "fas fa-archive",      unidad: "ESTADO" },
};

// ============================================================
// AUDIO
// ============================================================
const audioAlarma = document.createElement("audio");
audioAlarma.id = "audio-alarma";
audioAlarma.src = "/sounds/alarma1.mp3";
audioAlarma.loop = true;
document.body.appendChild(audioAlarma);

window.toggleMute = function () {
  isMuted = !isMuted;
  const icon = document.querySelector(".actions .btn-tool i.fa-volume-up, .actions .btn-tool i.fa-volume-mute");
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

// ============================================================
// HELPERS: ¿Este sensor está activo?
// ============================================================
function _sensorActivo(bajada, tren) {
  if (sensoresOmitidos.has(parseInt(bajada))) return false;
  if (trenesDeshabilitados.has(parseInt(tren || 1))) return false;
  return true;
}

function _contarSensoresOnline() {
  if (!APP_CONFIG?.mapeo_sensores) return { total: 0, activos: 0 };
  const tiposSiembra = ['semilla', 'ferti_linea', 'ferti_costado'];
  const todos = APP_CONFIG.mapeo_sensores.filter(s => tiposSiembra.includes(s.tipo));
  let activos = 0;
  todos.forEach(s => {
    if (_sensorActivo(s.bajada, s.tren)) activos++;
  });
  return { total: todos.length, activos };
}

function _actualizarKPIOnline() {
  const { total, activos } = _contarSensoresOnline();
  const el = document.getElementById('kpi-online');
  if (el) el.textContent = `${activos} / ${total}`;
  window.TOTAL_SURCOS = activos;
}

// ============================================================
// MODO COMPACTO
// ============================================================
function detectarModo() {
  const total = window.TOTAL_SURCOS || 0;
  if (total > 96) return 'mini';
  if (total > 48) return 'compact';
  return 'normal';
}

window.toggleModoCompacto = function () {
  const modos = ['normal', 'compact', 'mini'];
  const idx   = modos.indexOf(modoCompacto);
  modoCompacto = modos[(idx + 1) % modos.length];
  aplicarModo(modoCompacto);
};

function aplicarModo(modo) {
  const grid = document.getElementById('main-monitor');
  if (!grid) return;
  grid.classList.remove('modo-compact', 'modo-mini');
  if (modo === 'compact') grid.classList.add('modo-compact');
  if (modo === 'mini')    grid.classList.add('modo-mini');
  document.querySelectorAll('.surco-id').forEach(el => {
    el.classList.toggle('par', parseInt(el.textContent) % 2 === 0);
  });
}

// ============================================================
// 1. TOGGLE DE LOTE (Abrir/Cerrar con timer)
// ============================================================
function _inicializarToggleLote() {
  const btn = document.getElementById('btn-toggle-lote');
  if (!btn) return;

  // Si ya hay lote activo al cargar
  if (window.LOTE_ACTIVO?.activo || window.LOTE_ACTIVO?.id) {
    _setLoteVisualActivo(true);
    loteInicioTs = window.LOTE_ACTIVO.inicio
      ? new Date(window.LOTE_ACTIVO.inicio).getTime()
      : Date.now();
    _iniciarTimer();
  }

  btn.onclick = () => {
    if (window.LoteManager?.hayLoteActivo()) {
      // Cerrar lote
      if (typeof window.cerrarLoteDesdeMonitor === 'function') {
        window.cerrarLoteDesdeMonitor();
      }
    } else {
      // Abrir modal para iniciar
      if (typeof window.abrirModalLote === 'function') {
        window.abrirModalLote();
      }
    }
  };
}

function _setLoteVisualActivo(activo) {
  const btn    = document.getElementById('btn-toggle-lote');
  const icon   = document.getElementById('lote-toggle-icon');
  const label  = document.getElementById('lote-toggle-label');
  const timer  = document.getElementById('lote-toggle-timer');

  if (!btn) return;

  if (activo) {
    btn.classList.add('lote-activo');
    btn.classList.remove('lote-inactivo');
    btn.title = 'Click para CERRAR lote';
    if (icon)  icon.className = 'fas fa-stop';
    if (label) label.textContent = 'GRABANDO';
    if (timer) timer.style.display = 'inline';
  } else {
    btn.classList.remove('lote-activo');
    btn.classList.add('lote-inactivo');
    btn.title = 'Click para INICIAR lote';
    if (icon)  icon.className = 'fas fa-play';
    if (label) label.textContent = 'SIN LOTE';
    if (timer) { timer.style.display = 'none'; timer.textContent = '00:00'; }
    _detenerTimer();
  }
}

function _iniciarTimer() {
  _detenerTimer();
  if (!loteInicioTs) loteInicioTs = Date.now();
  loteTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - loteInicioTs) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const timerEl = document.getElementById('lote-toggle-timer');
    if (timerEl) {
      timerEl.textContent = h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
  }, 1000);
}

function _detenerTimer() {
  if (loteTimerInterval) { clearInterval(loteTimerInterval); loteTimerInterval = null; }
  loteInicioTs = null;
}

// Escuchar lote_update para sincronizar toggle
socket.on('lote_update', (data) => {
  if (data.activo) {
    _setLoteVisualActivo(true);
    loteInicioTs = data.inicio ? new Date(data.inicio).getTime() : Date.now();
    _iniciarTimer();
  } else {
    _setLoteVisualActivo(false);
  }
});

// ============================================================
// 2. GESTIÓN DE TRENES — switch habilitar/deshabilitar
// ============================================================
function _crearSwitchTren(numTren) {
  const id = `tren-switch-${numTren}`;
  const checked = !trenesDeshabilitados.has(numTren);
  return `
    <label class="tren-switch" title="${checked ? 'Deshabilitar' : 'Habilitar'} tren ${numTren}">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}
             onchange="toggleTrenHabilitado(${numTren}, this.checked)">
      <span class="tren-switch-slider"></span>
    </label>`;
}

window.toggleTrenHabilitado = function(numTren, habilitado) {
  if (habilitado) {
    trenesDeshabilitados.delete(numTren);
  } else {
    trenesDeshabilitados.add(numTren);
  }
  _guardarOmisiones();

  // Actualizar visual de todos los surcos de este tren
  if (APP_CONFIG?.mapeo_sensores) {
    APP_CONFIG.mapeo_sensores.forEach(s => {
      if ((s.tren || 1) === numTren) {
        const col = document.getElementById(`surco-col-${s.bajada}`);
        if (col) {
          col.classList.toggle('sensor-omitido', !habilitado);
          if (!habilitado) {
            // Limpiar alarma de este surco
            const surcoId = `s-${s.tipo}-${s.bajada}`;
            fallasActivas.delete(surcoId);
            surcosConFalla.delete(s.bajada);
          }
        }
      }
    });
  }

  _actualizarKPIOnline();
  _actualizarTicker();
  gestionarSonidoAlarma();
};

// ============================================================
// 3. OMISIÓN SELECTIVA DE SENSORES (Modo Mantenimiento)
// ============================================================
window.toggleOmitirSensor = function(bajada) {
  bajada = parseInt(bajada);
  if (sensoresOmitidos.has(bajada)) {
    sensoresOmitidos.delete(bajada);
  } else {
    sensoresOmitidos.add(bajada);
  }
  _guardarOmisiones();

  const col = document.getElementById(`surco-col-${bajada}`);
  if (col) col.classList.toggle('sensor-omitido', sensoresOmitidos.has(bajada));

  // Limpiar alarma si se omite
  if (sensoresOmitidos.has(bajada)) {
    APP_CONFIG.mapeo_sensores?.forEach(s => {
      if (s.bajada === bajada) {
        fallasActivas.delete(`s-${s.tipo}-${s.bajada}`);
        surcosConFalla.delete(bajada);
      }
    });
    gestionarSonidoAlarma();
  }

  _actualizarKPIOnline();
  _actualizarTicker();
};

// Context menu para omitir
function _hookContextMenu(surcoCol, bajada) {
  surcoCol.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const omitido = sensoresOmitidos.has(parseInt(bajada));
    if (confirm(omitido
      ? `¿Reactivar sensor bajada ${bajada}?`
      : `¿Omitir sensor bajada ${bajada}? (modo mantenimiento)`)) {
      toggleOmitirSensor(bajada);
    }
  });

  // Long press para mobile
  let pressTimer;
  surcoCol.addEventListener('touchstart', (e) => {
    pressTimer = setTimeout(() => {
      e.preventDefault();
      const omitido = sensoresOmitidos.has(parseInt(bajada));
      if (confirm(omitido
        ? `¿Reactivar sensor bajada ${bajada}?`
        : `¿Omitir sensor bajada ${bajada}?`)) {
        toggleOmitirSensor(bajada);
      }
    }, 700);
  }, { passive: false });
  surcoCol.addEventListener('touchend', () => clearTimeout(pressTimer));
  surcoCol.addEventListener('touchmove', () => clearTimeout(pressTimer));
}

// ============================================================
// INICIALIZACIÓN DE LA INTERFAZ
// ============================================================
function inicializarUI() {
  if (!APP_CONFIG || !APP_CONFIG.mapeo_sensores) return;

  const txtMaquina = document.getElementById("txt-maquina");
  if (txtMaquina) txtMaquina.innerText = APP_CONFIG.nombre || "DESCONOCIDA";

  const inputObjetivo = document.getElementById("input-objetivo");
  if (inputObjetivo && APP_CONFIG.setup?.densidad_objetivo) {
    inputObjetivo.value = APP_CONFIG.setup.densidad_objetivo;
  }

  modoCompacto = detectarModo();

  const sensoresOrdenados = [...APP_CONFIG.mapeo_sensores].sort((a, b) => a.bajada - b.bajada);
  const monitorGrid = document.getElementById("main-monitor");

  sensoresOrdenados.forEach((sensor) => {
    const surcoId  = `s-${sensor.tipo}-${sensor.bajada}`;
    const colId    = `surco-col-${sensor.bajada}`;
    const isEspecial = TIPOS_ESPECIALES.hasOwnProperty(sensor.tipo);

    if (isEspecial) {
      const container = document.getElementById("tren-especiales");
      if (container && !document.getElementById(surcoId)) {
        const card = document.createElement("div");
        card.id        = surcoId;
        card.className = "sensor-especial";
        card.innerHTML = `
          <i class="${TIPOS_ESPECIALES[sensor.tipo].icono}"></i>
          <div class="info">
            <span>${sensor.nombre || sensor.tipo.replace(/_/g, ' ')}</span>
            <strong class="val-text">—</strong>
          </div>`;
        container.appendChild(card);
      }
    } else if (monitorGrid) {
      const numTren = sensor.tren || 1;
      const rowId   = `tren-row-${numTren}`;
      let rowContainer = document.getElementById(rowId);

      // ═══ TRENES SIN DIVISIÓN: un solo bloque, sin separar arriba/abajo ═══
      if (!rowContainer) {
        const wrapper = document.createElement("div");
        wrapper.className = "tren-row-wrapper";

        // ═══ NUEVO: título con switch inline ═══
        wrapper.innerHTML = `
          <div class="tren-title">
            <span>TREN ${numTren} ${numTren === 1 ? '(DELANTERO)' : '(TRASERO)'} </span>
            <div class="tren-title-actions">
              ${_crearSwitchTren(numTren)}
            </div>
          </div>
          <div class="tren-row" id="${rowId}"></div>`;
        monitorGrid.appendChild(wrapper);
        rowContainer = document.getElementById(rowId);
      }

      let surcoCol = document.getElementById(colId);
      if (!surcoCol) {
        surcoCol = document.createElement("div");
        surcoCol.id = colId;
        surcoCol.className = "surco-column";
        surcoCol.onclick = () => abrirDetalleSurco(sensor.bajada, sensor.tipo);

        // Marcar como omitido si ya estaba
        if (!_sensorActivo(sensor.bajada, numTren)) {
          surcoCol.classList.add('sensor-omitido');
        }

        const numPar = sensor.bajada % 2 === 0;
        surcoCol.innerHTML = `
          <div class="surco-id${numPar ? ' par' : ''}">${sensor.bajada}</div>
          <div class="pills-area"></div>
          <div class="surco-val-num" id="val-${sensor.bajada}">—</div>`;
        rowContainer.appendChild(surcoCol);

        // Hook context menu para omitir
        _hookContextMenu(surcoCol, sensor.bajada);
      }

      const pillsArea = surcoCol.querySelector(".pills-area");
      if (pillsArea && !document.getElementById(surcoId)) {
        const pill = document.createElement("div");
        pill.id = surcoId;
        const tipoClass = sensor.tipo === 'ferti_linea'   ? 'pill-ferti-linea' :
                          sensor.tipo === 'ferti_costado' ? 'pill-ferti-costado' : '';
        pill.className = `pill-status status-tapado ${tipoClass}`.trim();
        pill.title = sensor.nombre || `${sensor.tipo} #${sensor.bajada}`;
        pillsArea.appendChild(pill);
      }
    }
  });

  aplicarModo(modoCompacto);
  _actualizarKPIOnline();
  _inicializarToggleLote();

  const btnModo = document.getElementById('btn-modo');
  if (btnModo && (_contarSensoresOnline().total) > 20) btnModo.style.display = 'flex';
}

window.toggleTren = function (rowId) {
  const row  = document.getElementById(rowId);
  const icon = row?.previousElementSibling?.querySelector("i.fa-chevron-up, i.fa-chevron-down");
  if (!row) return;
  const oculto = row.style.display === "none";
  row.style.display = oculto ? "flex" : "none";
  if (icon) icon.className = oculto ? "fas fa-chevron-up" : "fas fa-chevron-down";
};

inicializarUI();

// ============================================================
// RECEPCIÓN DE DATOS EN TIEMPO REAL
// ============================================================
socket.on("sensor_update", (data) => {
  if (!datosSurcos[data.bajada]) {
    datosSurcos[data.bajada] = { total_semillas: 0, spm: 0 };
  }
  datosSurcos[data.bajada].total_semillas += data.nuevas_semillas || 0;
  datosSurcos[data.bajada].spm = data.spm || 0;

  const surcoId = `s-${data.tipo}-${data.bajada}`;
  const el      = document.getElementById(surcoId);
  if (el) {
    actualizarPastillaEstado(el, data);
    if (TIPOS_ESPECIALES[data.tipo]) {
      const valText = el.querySelector(".val-text");
      if (valText) valText.innerText = data.valor;
    }
  }

  // Modal detalle en vivo
  const modalDetalle = document.getElementById("surco-modal-detalle");
  if (modalDetalle?.style.display === "flex" && modalDetalle.dataset.surco == data.bajada) {
    const elSpm   = document.getElementById("detalle-spm");
    const elTotal = document.getElementById("detalle-total");
    if (elSpm)   elSpm.innerText   = data.spm;
    if (elTotal) elTotal.innerText = datosSurcos[data.bajada].total_semillas.toLocaleString("es-AR");
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

// ============================================================
// 4. ALARMAS — Respeta omisiones y trenes deshabilitados
// ============================================================
function actualizarPastillaEstado(el, data) {
  const surcoCol = document.getElementById(`surco-col-${data.bajada}`);
  const surcoId  = el.id;
  const bajada   = parseInt(data.bajada);

  // Buscar el tren de este sensor
  const sensorCfg = APP_CONFIG?.mapeo_sensores?.find(s => s.bajada === bajada);
  const tren      = sensorCfg?.tren || 1;

  // ═══ CHECK OMISIÓN: si está omitido o tren deshabilitado → NO alertar ═══
  const activo = _sensorActivo(bajada, tren);

  el.classList.remove("status-ok", "status-alerta", "status-tapado");

  if (!activo) {
    // Sensor omitido: forzar visual tapado, sin alarma
    el.classList.add("status-tapado");
    el.style.height = '3%';
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(bajada);
    if (surcoCol) surcoCol.classList.remove("falla");
    return;
  }

  if (data.alerta) {
    el.classList.add("status-alerta");
    fallasActivas.add(surcoId);
    surcosConFalla.add(bajada);
    if (surcoCol) surcoCol.classList.add("falla");
  } else if (parseFloat(data.valor) > 0) {
    el.classList.add("status-ok");
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(bajada);
    if (surcoCol) surcoCol.classList.remove("falla");
  } else {
    el.classList.add("status-tapado");
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(bajada);
    if (surcoCol) surcoCol.classList.remove("falla");
  }

  // Altura proporcional al spm
  const objetivo  = APP_CONFIG?.setup?.densidad_objetivo || 16;
  const spmVal    = parseFloat(data.spm) || 0;
  const pctAltura = data.alerta ? 15
                  : spmVal === 0 ? 6
                  : Math.max(10, Math.min(95, (spmVal / objetivo) * 75));
  el.style.height = pctAltura + '%';

  // Valor debajo del tubo
  const valEl = document.getElementById('val-' + data.bajada);
  if (valEl) {
    valEl.textContent = spmVal > 0 ? spmVal : (data.alerta ? '!' : '—');
    valEl.style.color = data.alerta ? 'var(--danger)' : spmVal > 0 ? '#666' : '#333';
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
    const lista = [...surcosConFalla].sort((a, b) => a - b).join(", ");
    ticker.innerText = `FALLA EN SURCO ${lista}`;
    ticker.classList.add("active-alert");
  } else {
    ticker.innerText = "SISTEMA VISTAX OPERATIVO";
    ticker.classList.remove("active-alert");
  }
}

// ============================================================
// DETALLE DE SURCO
// ============================================================
window.abrirDetalleSurco = function (numero, tipo) {
  const data = datosSurcos[numero] || { total_semillas: 0, spm: 0 };
  const omitido = sensoresOmitidos.has(parseInt(numero));

  let overlay = document.getElementById("surco-modal-detalle");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "surco-modal-detalle";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:9999";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = "none"; };
    document.body.appendChild(overlay);
  }

  overlay.dataset.surco = numero;
  const objetivo = APP_CONFIG?.setup?.densidad_objetivo || 16;
  const spm      = parseFloat(data.spm) || 0;
  const pct      = objetivo > 0 ? Math.min((spm / objetivo) * 100, 200) : 0;
  const color    = spm === 0 ? '#ff1744' : pct < 70 ? '#ffb300' : pct > 130 ? '#00e5ff' : '#00e676';

  overlay.innerHTML = `
    <div style="background:#141414;border:1px solid #2a2a2a;border-radius:10px;min-width:260px;max-width:320px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.8);">
      <div style="background:#1e1e1e;padding:14px 18px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:10px;color:#555;font-weight:700;text-transform:uppercase">${tipo.replace(/_/g,' ')}</div>
          <div style="font-size:18px;font-weight:900;color:white;">SURCO ${numero}</div>
        </div>
        <button onclick="document.getElementById('surco-modal-detalle').style.display='none'" style="background:transparent;border:none;color:#555;font-size:24px;cursor:pointer">&times;</button>
      </div>
      <div style="padding:18px;">
        ${omitido ? '<div style="background:#2b2200;border:1px solid #5c4a00;border-radius:6px;padding:8px;text-align:center;color:#ffb300;font-weight:700;font-size:11px;margin-bottom:12px"><i class="fas fa-wrench"></i> SENSOR OMITIDO (MANTENIMIENTO)</div>' : ''}
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:11px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:6px">Densidad actual</div>
          <div id="detalle-spm" style="font-size:48px;font-weight:900;color:${color};line-height:1">${spm}</div>
          <div style="font-size:13px;color:#444;">semillas / metro</div>
        </div>
        <div style="background:#0a0a0a;border-radius:4px;overflow:hidden;height:6px;margin-bottom:16px">
          <div style="height:100%;width:${Math.min(pct,100)}%;background:${color};transition:width .3s;border-radius:4px"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#333;margin-bottom:16px">
          <span>0</span><span>Objetivo: ${objetivo}</span><span>${objetivo * 2}</span>
        </div>
        <div style="background:#0a0a0a;border:1px solid #1e1e1e;border-radius:6px;padding:12px;text-align:center;">
          <div style="font-size:9px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:4px">Total acumulado</div>
          <div id="detalle-total" style="font-size:22px;font-weight:700;color:#ccc">${data.total_semillas.toLocaleString("es-AR")}</div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button onclick="toggleOmitirSensor(${numero});document.getElementById('surco-modal-detalle').style.display='none'"
            style="flex:1;padding:9px;background:${omitido ? '#0d2b1a' : '#2b2200'};border:1px solid ${omitido ? '#1a5c35' : '#5c4a00'};color:${omitido ? '#00e676' : '#ffb300'};border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit">
            <i class="fas fa-${omitido ? 'check' : 'wrench'}"></i> ${omitido ? 'REACTIVAR' : 'OMITIR SENSOR'}
          </button>
        </div>
      </div>
    </div>`;
  overlay.style.display = "flex";
};

// ============================================================
// OBJETIVO RÁPIDO
// ============================================================
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
      setTimeout(() => { inp.style.backgroundColor = "#111"; inp.style.color = "var(--accent)"; }, 400);
    }
  } catch (e) { console.error("Error guardando objetivo", e); }
};

// ============================================================
// AUTO-REGISTRO NODOS
// ============================================================
socket.on("new_node_detected", (nodoData) => {
  if (typeof window.prepararNuevoNodo === "function") {
    window.prepararNuevoNodo(nodoData);
  }
});
