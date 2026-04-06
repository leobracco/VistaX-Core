// ============================================================
// VistaX — render_engine.js  v5.1
// FIX: IDs incluyen tren → surco-col-T{tren}-{bajada}
// ============================================================

const socket = io();
window.socket = socket;

let fallasActivas = new Set();
let surcosConFalla = new Set();
let datosSurcos = {};
let modoCompacto = 'normal';
let isMuted = false;
let playingAlarm = false;
let trenesDeshabilitados = new Set();
let sensoresOmitidos = new Set();
let loteTimerInterval = null;
let loteInicioTs = null;

// ═══ ESTADO LOCAL DE SECCIONES (AOG) ═══
// Guardamos el último sections_update recibido para poder
// filtrar sensor_update en el frontend sin esperar al servidor.
let _seccionesLocalesT1 = [];
let _seccionesLocalesT2 = [];

/**
 * Verifica si un surco específico está cortado según el estado
 * local de secciones. Usa el mismo orden por índice que el servidor.
 */
function _surcoEstaCortado(bajada, numTren) {
  const secciones = numTren === 1 ? _seccionesLocalesT1 : _seccionesLocalesT2;
  if (!secciones.length) return false;

  const surcosTren = (APP_CONFIG?.mapeo_sensores || [])
    .filter(s => s.is_active !== false && (s.tren || 1) === numTren && s.tipo === 'semilla')
    .sort((a, b) => a.bajada - b.bajada);

  const idx = surcosTren.findIndex(s => s.bajada === parseInt(bajada));
  if (idx < 0 || idx >= secciones.length) return false;
  return secciones[idx] === 0;
}

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

// ═══ FUNCIÓN CENTRALIZADA DE OMISIÓN ═══
// Llamada desde BroadcastChannel, socket, context menu, etc.
function _aplicarOmision(bajada, tren, omitir) {
  bajada = parseInt(bajada);
  tren = parseInt(tren || 1);
  const key = _sensorKey(bajada, tren);

  if (omitir) sensoresOmitidos.add(key);
  else sensoresOmitidos.delete(key);
  _guardarOmisiones();

  // Visual: columna
  const col = document.getElementById(`surco-col-${key}`);
  if (col) col.classList.toggle('sensor-omitido', omitir);

  if (omitir) {
    // Limpiar TODAS las fallas y forzar pills a tapado
    APP_CONFIG.mapeo_sensores?.forEach(s => {
      if (s.bajada === bajada && (s.tren || 1) === tren) {
        const sid = `s-${s.tipo}-${s.bajada}`;
        fallasActivas.delete(sid);
        const pill = document.getElementById(sid);
        if (pill) {
          pill.classList.remove("status-ok", "status-alerta", "status-desvio");
          pill.classList.add("status-tapado");
          pill.style.height = '3%';
        }
      }
    });
    surcosConFalla.delete(key);
    if (col) col.classList.remove("falla", "desvio");
    const valEl = document.getElementById(`val-${key}`);
    if (valEl) { valEl.textContent = '—'; valEl.style.color = '#333'; }
  }

  _actualizarKPIOnline();
  _actualizarTicker();
  const kpiFallas = document.getElementById("kpi-fallas");
  if (kpiFallas) kpiFallas.innerText = fallasActivas.size;
  gestionarSonidoAlarma();
  console.log(`[Omisión] Surco ${bajada} Tren ${tren} → ${omitir ? 'OMITIDO' : 'REACTIVADO'} | fallas: ${fallasActivas.size}`);
}

// ═══ BroadcastChannel — comunicación directa entre ventanas ═══
try {
  const _bcOmision = new BroadcastChannel('vistax_omision');
  _bcOmision.onmessage = (ev) => {
    const { bajada, tren, omitido } = ev.data;
    _aplicarOmision(bajada, tren, omitido);
  };
} catch(e) { console.warn('[Omisión] BroadcastChannel no soportado'); }

const TIPOS_ESPECIALES = {
  rotacion_eje: { icono: "fas fa-cogs", unidad: "RPM" },
  turbina: { icono: "fas fa-fan", unidad: "RPM" },
  bajada_herramienta: { icono: "fas fa-arrow-down", unidad: "ESTADO" },
  bateria: { icono: "fas fa-car-battery", unidad: "V" },
  tolva_vacia: { icono: "fas fa-archive", unidad: "ESTADO" },
};

function _sensorKey(bajada, tren) { return `T${tren || 1}-${bajada}`; }

function _buscarTren(bajada, tipo) {
  const cfg = APP_CONFIG?.mapeo_sensores?.find(s => s.bajada === parseInt(bajada) && s.tipo === tipo);
  return cfg?.tren || 1;
}

const audioAlarma = document.createElement("audio");
audioAlarma.id = "audio-alarma"; audioAlarma.src = "/sounds/alarma1.mp3"; audioAlarma.loop = true;
document.body.appendChild(audioAlarma);

window.toggleMute = function () {
  isMuted = !isMuted;
  const icon = document.querySelector(".actions .btn-tool i.fa-volume-up, .actions .btn-tool i.fa-volume-mute");
  if (icon) { icon.className = isMuted ? "fas fa-volume-mute" : "fas fa-volume-up"; icon.style.color = isMuted ? "var(--danger)" : ""; }
  isMuted ? audioAlarma.pause() : gestionarSonidoAlarma();
};

function gestionarSonidoAlarma() {
  if (isMuted) return;
  if (fallasActivas.size > 0) {
    if (!playingAlarm) {
      console.debug(`[DEBUG Audio] ▶ Alarma INICIADA | fallas activas (${fallasActivas.size}): [${[...fallasActivas].join(', ')}]`);
      audioAlarma.play().catch(e => console.warn('[DEBUG Audio] play() bloqueado por el navegador:', e));
      playingAlarm = true;
    }
  } else {
    if (playingAlarm) console.debug('[DEBUG Audio] ■ Alarma DETENIDA | fallasActivas vacío');
    audioAlarma.pause();
    audioAlarma.currentTime = 0;
    playingAlarm = false;
  }
}

function _sensorActivo(bajada, tren) {
  const key = _sensorKey(bajada, tren);
  const cfg = APP_CONFIG?.mapeo_sensores?.find(s => s.bajada === parseInt(bajada) && (s.tren || 1) === parseInt(tren || 1));
  if (cfg && cfg.is_active === false) return false;
  if (sensoresOmitidos.has(key)) return false;
  if (trenesDeshabilitados.has(parseInt(tren || 1))) return false;
  return true;
}

function _contarSensoresOnline() {
  if (!APP_CONFIG?.mapeo_sensores) return { total: 0, activos: 0 };
  const tiposSiembra = ['semilla', 'ferti_linea', 'ferti_costado'];
  const todos = APP_CONFIG.mapeo_sensores.filter(s => tiposSiembra.includes(s.tipo));
  let total = 0, activos = 0;
  todos.forEach(s => { if (s.is_active === false) return; total++; if (_sensorActivo(s.bajada, s.tren || 1)) activos++; });
  return { total, activos };
}

function _actualizarKPIOnline() {
  const { total, activos } = _contarSensoresOnline();
  const el = document.getElementById('kpi-online');
  if (el) el.textContent = `${activos} / ${total}`;
  window.TOTAL_SURCOS = activos;
}

function _objetivoTren(numTren) {
  const porTren = APP_CONFIG?.setup?.objetivos_tren;
  if (porTren && porTren[numTren] !== undefined) return parseFloat(porTren[numTren]);
  return parseFloat(APP_CONFIG?.setup?.densidad_objetivo) || 16;
}

function _toleranciaDesvio() { return parseFloat(APP_CONFIG?.setup?.tolerancia_desvio) || 20; }

function detectarModo() { const t = window.TOTAL_SURCOS || 0; return t > 96 ? 'mini' : t > 48 ? 'compact' : 'normal'; }

window.toggleModoCompacto = function () {
  const modos = ['normal', 'compact', 'mini'];
  modoCompacto = modos[(modos.indexOf(modoCompacto) + 1) % modos.length];
  aplicarModo(modoCompacto);
};

function aplicarModo(modo) {
  const grid = document.getElementById('main-monitor');
  if (!grid) return;
  grid.classList.remove('modo-compact', 'modo-mini');
  if (modo === 'compact') grid.classList.add('modo-compact');
  if (modo === 'mini') grid.classList.add('modo-mini');
}

// TOGGLE LOTE
function _inicializarToggleLote() {
  const btn = document.getElementById('btn-toggle-lote');
  if (!btn) return;
  if (window.LOTE_ACTIVO?.activo || window.LOTE_ACTIVO?.id) {
    _setLoteVisualActivo(true);
    loteInicioTs = window.LOTE_ACTIVO.inicio ? new Date(window.LOTE_ACTIVO.inicio).getTime() : Date.now();
    _iniciarTimer();
  }
  btn.onclick = () => {
    if (window.LoteManager?.hayLoteActivo()) { if (typeof window.cerrarLoteDesdeMonitor === 'function') window.cerrarLoteDesdeMonitor(); }
    else { if (typeof window.abrirModalLote === 'function') window.abrirModalLote(); }
  };
}

function _setLoteVisualActivo(activo) {
  const btn = document.getElementById('btn-toggle-lote'), icon = document.getElementById('lote-toggle-icon'), label = document.getElementById('lote-toggle-label'), timer = document.getElementById('lote-toggle-timer');
  if (!btn) return;
  if (activo) { btn.classList.add('lote-activo'); btn.classList.remove('lote-inactivo'); btn.title = 'Click para CERRAR lote'; if (icon) icon.className = 'fas fa-stop'; if (label) label.textContent = 'GRABANDO'; if (timer) timer.style.display = 'inline'; }
  else { btn.classList.remove('lote-activo'); btn.classList.add('lote-inactivo'); btn.title = 'Click para INICIAR lote'; if (icon) icon.className = 'fas fa-play'; if (label) label.textContent = 'SIN LOTE'; if (timer) { timer.style.display = 'none'; timer.textContent = '00:00'; } _detenerTimer(); }
}

function _iniciarTimer() { _detenerTimer(); if (!loteInicioTs) loteInicioTs = Date.now(); loteTimerInterval = setInterval(() => { const e = Math.floor((Date.now() - loteInicioTs) / 1000), h = Math.floor(e / 3600), m = Math.floor((e % 3600) / 60), s = e % 60; const t = document.getElementById('lote-toggle-timer'); if (t) t.textContent = h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }, 1000); }
function _detenerTimer() { if (loteTimerInterval) { clearInterval(loteTimerInterval); loteTimerInterval = null; } loteInicioTs = null; }

socket.on('lote_update', (data) => { if (data.activo) { _setLoteVisualActivo(true); loteInicioTs = data.inicio ? new Date(data.inicio).getTime() : Date.now(); _iniciarTimer(); } else { _setLoteVisualActivo(false); } });

// TRENES
function _crearSwitchTren(numTren) {
  const checked = !trenesDeshabilitados.has(numTren);
  return `<label class="tren-switch" title="${checked ? 'Deshabilitar' : 'Habilitar'} tren ${numTren}"><input type="checkbox" id="tren-switch-${numTren}" ${checked ? 'checked' : ''} onchange="toggleTrenHabilitado(${numTren}, this.checked)"><span class="tren-switch-slider"></span></label>`;
}

window.toggleTrenHabilitado = function(numTren, hab) {
  hab ? trenesDeshabilitados.delete(numTren) : trenesDeshabilitados.add(numTren);
  _guardarOmisiones();
  if (APP_CONFIG?.mapeo_sensores) {
    APP_CONFIG.mapeo_sensores.forEach(s => {
      if ((s.tren || 1) === numTren) {
        const key = _sensorKey(s.bajada, numTren);
        const col = document.getElementById(`surco-col-${key}`);
        if (col) { col.classList.toggle('sensor-omitido', !hab); if (!hab) { fallasActivas.delete(`s-${s.tipo}-${s.bajada}`); surcosConFalla.delete(key); } }
      }
    });
  }
  _actualizarKPIOnline(); _actualizarTicker(); gestionarSonidoAlarma();
};

// OMISIÓN
window.toggleOmitirSensor = function(bajada, tren) {
  tren = parseInt(tren || 1); bajada = parseInt(bajada);
  const key = _sensorKey(bajada, tren);
  const nuevoEstado = !sensoresOmitidos.has(key);
  _aplicarOmision(bajada, tren, nuevoEstado);
};

function _hookContextMenu(surcoCol, bajada, tren) {
  surcoCol.addEventListener('contextmenu', (e) => { e.preventDefault(); const key = _sensorKey(bajada, tren); if (confirm(sensoresOmitidos.has(key) ? `¿Reactivar bajada ${bajada}?` : `¿Omitir bajada ${bajada}?`)) toggleOmitirSensor(bajada, tren); });
  let pt; surcoCol.addEventListener('touchstart', (e) => { pt = setTimeout(() => { e.preventDefault(); const key = _sensorKey(bajada, tren); if (confirm(sensoresOmitidos.has(key) ? `¿Reactivar bajada ${bajada}?` : `¿Omitir bajada ${bajada}?`)) toggleOmitirSensor(bajada, tren); }, 700); }, { passive: false }); surcoCol.addEventListener('touchend', () => clearTimeout(pt)); surcoCol.addEventListener('touchmove', () => clearTimeout(pt));
}

// ============================================================
// INICIALIZACIÓN UI
// ============================================================
function inicializarUI() {
  if (!APP_CONFIG || !APP_CONFIG.mapeo_sensores) return;

  const txtMaquina = document.getElementById("txt-maquina");
  if (txtMaquina) txtMaquina.innerText = APP_CONFIG.nombre || "DESCONOCIDA";

  const inputObjetivo = document.getElementById("input-objetivo");
  if (inputObjetivo && APP_CONFIG.setup?.densidad_objetivo) inputObjetivo.value = APP_CONFIG.setup.densidad_objetivo;

  modoCompacto = detectarModo();

  const sensoresActivos = APP_CONFIG.mapeo_sensores.filter(s => s.is_active !== false);
  const sensoresOrdenados = [...sensoresActivos].sort((a, b) => a.bajada - b.bajada);
  const monitorGrid = document.getElementById("main-monitor");

  // N TRENES — orden ascendente
  const trenesUsados = [...new Set(sensoresOrdenados.filter(s => !TIPOS_ESPECIALES.hasOwnProperty(s.tipo)).map(s => s.tren || 1))].sort((a, b) => a - b);

  trenesUsados.forEach(numTren => {
    const rowId = `tren-row-${numTren}`;
    if (document.getElementById(rowId)) return;
    const wrapper = document.createElement("div");
    wrapper.className = "tren-row-wrapper";
    let etiqueta;
    if (trenesUsados.length === 1) etiqueta = 'TREN';
    else if (trenesUsados.length === 2) etiqueta = numTren === Math.min(...trenesUsados) ? 'TREN (DELANTERO)' : 'TREN (TRASERO)';
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
        card.id = surcoId; card.className = "sensor-especial";
        card.innerHTML = `<i class="${TIPOS_ESPECIALES[sensor.tipo].icono}"></i><div class="info"><span>${sensor.nombre || sensor.tipo.replace(/_/g, ' ')}</span><strong class="val-text">—</strong></div>`;
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
        surcoCol.onclick = () => abrirDetalleSurco(sensor.bajada, sensor.tipo, numTren);
        if (!_sensorActivo(sensor.bajada, numTren)) surcoCol.classList.add('sensor-omitido');
        const numPar = sensor.bajada % 2 === 0;
        surcoCol.innerHTML = `<div class="surco-id${numPar ? ' par' : ''}">${sensor.bajada}</div><div class="pills-area"><div class="led-ferti led-ferti-linea" id="led-fl-${key}" title="Ferti Línea"></div><div class="led-ferti led-ferti-costado" id="led-fc-${key}" title="Ferti Costado"></div></div><div class="surco-val-num" id="val-${key}">—</div>`;
        rowContainer.appendChild(surcoCol);
        _hookContextMenu(surcoCol, sensor.bajada, numTren);
      }

      const pillsArea = surcoCol.querySelector(".pills-area");
      if (pillsArea && !document.getElementById(surcoId)) {
        const pill = document.createElement("div");
        pill.id = surcoId;
        const tipoClass = sensor.tipo === 'ferti_linea' ? 'pill-ferti-linea' : sensor.tipo === 'ferti_costado' ? 'pill-ferti-costado' : '';
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

window.toggleTren = function (rowId) { const row = document.getElementById(rowId); if (row) row.style.display = row.style.display === "none" ? "flex" : "none"; };

inicializarUI();

// ============================================================
// RECEPCIÓN DE DATOS EN TIEMPO REAL
// ============================================================
socket.on("sensor_update", (data) => {
  const tren = data.tren || _buscarTren(data.bajada, data.tipo);
  const key = _sensorKey(data.bajada, tren);

  // DEBUG: Log para sensores especiales
  if (TIPOS_ESPECIALES[data.tipo]) {
    console.log(`🔧 [ESPECIAL] ${data.tipo} bajada:${data.bajada} valor:${data.valor} spm:${data.spm}`);
  }

  if (!datosSurcos[key]) datosSurcos[key] = { total_semillas: 0, spm: 0, ferti_linea: false, ferti_costado: false };
  datosSurcos[key].total_semillas += data.nuevas_semillas || 0;
  datosSurcos[key].spm = data.spm || 0;

  if (data.tipo === 'ferti_linea') { datosSurcos[key].ferti_linea = parseFloat(data.valor) > 0; const led = document.getElementById(`led-fl-${key}`); if (led) led.classList.toggle('led-on', datosSurcos[key].ferti_linea); }
  if (data.tipo === 'ferti_costado') { datosSurcos[key].ferti_costado = parseFloat(data.valor) > 0; const led = document.getElementById(`led-fc-${key}`); if (led) led.classList.toggle('led-on', datosSurcos[key].ferti_costado); }

  const surcoId = `s-${data.tipo}-${data.bajada}`;
  const el = document.getElementById(surcoId);
  if (el) {
    if (TIPOS_ESPECIALES[data.tipo]) {
      // Sensores especiales: actualizar val-text directamente, sin pipeline de alarmas
      const vt = el.querySelector(".val-text");
      if (vt) vt.innerText = parseFloat(data.valor) > 0 ? data.valor : '—';
      // Visual: si valor > 0, poner color accent; sino gris
      if (vt) vt.style.color = parseFloat(data.valor) > 0 ? 'var(--accent)' : '#555';
    } else {
      // Sensores normales (semilla, ferti): pipeline completo de alarmas/desvío
      actualizarPastillaEstado(el, data, tren, key);
    }
  }

  const md = document.getElementById("surco-modal-detalle");
  if (md?.style.display === "flex" && md.dataset.key === key) {
    const es = document.getElementById("detalle-spm"), et = document.getElementById("detalle-total");
    if (es) es.innerText = data.spm;
    if (et) et.innerText = datosSurcos[key].total_semillas.toLocaleString("es-AR");
  }
});

socket.on("global_update", (stats) => {
  if (stats.velocidad !== undefined) { const el = document.getElementById("txt-vel"); if (el) el.innerText = parseFloat(stats.velocidad).toFixed(1); }
  if (stats.promedio !== undefined) { const el = document.getElementById("txt-dosis"); if (el) el.innerText = parseFloat(stats.promedio).toFixed(1); }
});

// ALARMAS + DESVÍO
function actualizarPastillaEstado(el, data, tren, key) {
  const surcoCol = document.getElementById(`surco-col-${key}`);
  const surcoId = el.id;
  const bajada = parseInt(data.bajada);
  const activo = _sensorActivo(bajada, tren);

  el.classList.remove("status-ok", "status-alerta", "status-tapado", "status-desvio");

  if (!activo) {
    el.classList.add("status-tapado");
    el.style.height = '3%';
    // Limpiar TODAS las fallas de este surco (semilla, ferti_linea, ferti_costado)
    APP_CONFIG.mapeo_sensores?.forEach(s => {
      if (s.bajada === bajada && (s.tren || 1) === parseInt(tren)) {
        fallasActivas.delete(`s-${s.tipo}-${s.bajada}`);
      }
    });
    surcosConFalla.delete(key);
    if (surcoCol) surcoCol.classList.remove("falla", "desvio", "cortado");
    const valEl = document.getElementById(`val-${key}`);
    if (valEl) { valEl.textContent = '—'; valEl.style.color = '#333'; }
    _actualizarTicker();
    const kpiFallas = document.getElementById("kpi-fallas");
    if (kpiFallas) kpiFallas.innerText = fallasActivas.size;
    gestionarSonidoAlarma();
    return;
  }

  // Sección cortada por AOG → no monitorear, visual apagado
  // Verificamos TAMBIÉN el estado local de secciones para cubrir el lag
  // entre cuando el servidor aplica el corte y cuando llega sections_update
  const cortadoLocalmente = _surcoEstaCortado(bajada, tren);
  if (data.seccion_cortada || cortadoLocalmente) {
    el.classList.add("status-tapado");
    el.style.height = '3%';
    // Limpiar TODOS los tipos de sensor de este bajada/tren para que
    // el sonido se detenga inmediatamente, sin esperar el update de ferti
    APP_CONFIG.mapeo_sensores?.forEach(s => {
      if (s.bajada === bajada && (s.tren || 1) === parseInt(tren)) {
        const sid = `s-${s.tipo}-${s.bajada}`;
        if (fallasActivas.has(sid)) {
          console.debug(`[DEBUG Cortado] Limpiando falla ${sid} por sección cortada`);
          fallasActivas.delete(sid);
        }
      }
    });
    surcosConFalla.delete(key);
    if (surcoCol) { surcoCol.classList.add("cortado"); surcoCol.classList.remove("falla", "desvio"); }
    const valEl = document.getElementById(`val-${key}`);
    if (valEl) { valEl.textContent = '—'; valEl.style.color = '#222'; }
    _actualizarTicker();
    const kpiFallas = document.getElementById("kpi-fallas");
    if (kpiFallas) kpiFallas.innerText = fallasActivas.size;
    gestionarSonidoAlarma();
    return;
  }
  // Si ya no está cortado, quitar clase
  if (surcoCol) surcoCol.classList.remove("cortado");

  const spmVal = parseFloat(data.spm) || 0;
  const objetivo = _objetivoTren(tren);
  const tolerancia = _toleranciaDesvio();

  if (data.alerta) {
    el.classList.add("status-alerta"); fallasActivas.add(surcoId); surcosConFalla.add(key);
    if (surcoCol) { surcoCol.classList.add("falla"); surcoCol.classList.remove("desvio"); }
  } else if (spmVal > 0) {
    const pctDesvio = Math.abs((spmVal - objetivo) / objetivo) * 100;
    if (objetivo > 0 && pctDesvio > tolerancia) {
      el.classList.add("status-desvio"); if (surcoCol) { surcoCol.classList.add("desvio"); surcoCol.classList.remove("falla"); }
      fallasActivas.delete(surcoId); surcosConFalla.delete(key);
    } else {
      el.classList.add("status-ok"); fallasActivas.delete(surcoId); surcosConFalla.delete(key);
      if (surcoCol) surcoCol.classList.remove("falla", "desvio");
    }
  } else { el.classList.add("status-tapado"); fallasActivas.delete(surcoId); surcosConFalla.delete(key); if (surcoCol) surcoCol.classList.remove("falla", "desvio"); }

  const pctAltura = data.alerta ? 15 : spmVal === 0 ? 6 : Math.max(10, Math.min(95, (spmVal / objetivo) * 75));
  el.style.height = pctAltura + '%';

  const valEl = document.getElementById(`val-${key}`);
  if (valEl && data.tipo === 'semilla') {
    valEl.textContent = spmVal > 0 ? spmVal : (data.alerta ? '!' : '—');
    valEl.style.color = data.alerta ? 'var(--danger)' : el.classList.contains('status-desvio') ? '#ffb300' : spmVal > 0 ? '#666' : '#333';
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
    const lista = [...surcosConFalla].map(k => k.split('-')[1]).sort((a, b) => parseInt(a) - parseInt(b)).join(", ");
    ticker.innerText = `FALLA EN SURCO ${lista}`;
    ticker.classList.add("active-alert");
  } else { ticker.innerText = "SISTEMA VISTAX OPERATIVO"; ticker.classList.remove("active-alert"); }
}

// DETALLE SURCO
window.abrirDetalleSurco = function (numero, tipo, tren) {
  tren = tren || _buscarTren(numero, tipo);
  const key = _sensorKey(numero, tren);
  const data = datosSurcos[key] || { total_semillas: 0, spm: 0, ferti_linea: false, ferti_costado: false };
  const omitido = sensoresOmitidos.has(key);
  const objetivo = _objetivoTren(tren);
  const sensorCfg = APP_CONFIG?.mapeo_sensores?.find(s => s.bajada === parseInt(numero) && (s.tren || 1) === tren);

  let overlay = document.getElementById("surco-modal-detalle");
  if (!overlay) { overlay = document.createElement("div"); overlay.id = "surco-modal-detalle"; overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:9999"; overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = "none"; }; document.body.appendChild(overlay); }

  overlay.dataset.key = key;
  const spm = parseFloat(data.spm) || 0;
  const pct = objetivo > 0 ? Math.min((spm / objetivo) * 100, 200) : 0;
  const desvio = objetivo > 0 ? Math.abs((spm - objetivo) / objetivo * 100).toFixed(0) : 0;
  const color = spm === 0 ? '#ff1744' : pct < 70 ? '#ffb300' : pct > 130 ? '#00e5ff' : '#00e676';
  const fl = data.ferti_linea, fc = data.ferti_costado;

  overlay.innerHTML = `<div style="background:#141414;border:1px solid #2a2a2a;border-radius:10px;min-width:280px;max-width:340px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.8);"><div style="background:#1e1e1e;padding:14px 18px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:10px;color:#555;font-weight:700;text-transform:uppercase">${sensorCfg?.nombre || tipo.replace(/_/g,' ')} · Tren ${tren}</div><div style="font-size:18px;font-weight:900;color:white;">SURCO ${numero}</div></div><button onclick="document.getElementById('surco-modal-detalle').style.display='none'" style="background:transparent;border:none;color:#555;font-size:24px;cursor:pointer">&times;</button></div><div style="padding:18px;">${omitido ? '<div style="background:#2b2200;border:1px solid #5c4a00;border-radius:6px;padding:8px;text-align:center;color:#ffb300;font-weight:700;font-size:11px;margin-bottom:12px"><i class="fas fa-wrench"></i> SENSOR OMITIDO</div>' : ''}<div style="text-align:center;margin-bottom:12px;"><div style="font-size:11px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:6px">Densidad individual</div><div id="detalle-spm" style="font-size:48px;font-weight:900;color:${color};line-height:1">${spm}</div><div style="font-size:13px;color:#444;">semillas / metro</div></div><div style="background:#0a0a0a;border-radius:4px;overflow:hidden;height:6px;margin-bottom:8px"><div style="height:100%;width:${Math.min(pct,100)}%;background:${color};transition:width .3s;border-radius:4px"></div></div><div style="display:flex;justify-content:space-between;font-size:9px;color:#333;margin-bottom:8px"><span>0</span><span>Obj. Tren ${tren}: ${objetivo}</span><span>${objetivo * 2}</span></div><div style="text-align:center;font-size:11px;color:${parseFloat(desvio) > _toleranciaDesvio() ? '#ffb300' : '#444'};margin-bottom:12px">Desvío: ${desvio}%</div><div style="display:flex;gap:12px;justify-content:center;margin:10px 0 6px"><div style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:${fl ? '#00e676' : '#222'};border:1px solid ${fl ? '#00e676' : '#333'};display:inline-block"></span><span style="font-size:9px;color:#555;font-weight:700">FERTI L</span></div><div style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:${fc ? '#42a5f5' : '#222'};border:1px solid ${fc ? '#42a5f5' : '#333'};display:inline-block"></span><span style="font-size:9px;color:#555;font-weight:700">FERTI C</span></div></div><div style="background:#0a0a0a;border:1px solid #1e1e1e;border-radius:6px;padding:12px;text-align:center;"><div style="font-size:9px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:4px">Total acumulado</div><div id="detalle-total" style="font-size:22px;font-weight:700;color:#ccc">${data.total_semillas.toLocaleString("es-AR")}</div></div><div style="margin-top:12px;display:flex;gap:8px"><button onclick="toggleOmitirSensor(${numero},${tren});document.getElementById('surco-modal-detalle').style.display='none'" style="flex:1;padding:9px;background:${omitido ? '#0d2b1a' : '#2b2200'};border:1px solid ${omitido ? '#1a5c35' : '#5c4a00'};color:${omitido ? '#00e676' : '#ffb300'};border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit"><i class="fas fa-${omitido ? 'check' : 'wrench'}"></i> ${omitido ? 'REACTIVAR' : 'OMITIR SENSOR'}</button></div></div></div>`;
  overlay.style.display = "flex";
};

window.guardarObjetivoRapido = async function (val) {
  if (!APP_CONFIG) return; if (!APP_CONFIG.setup) APP_CONFIG.setup = {};
  APP_CONFIG.setup.densidad_objetivo = parseFloat(val);
  try { await fetch("/api/config/maquinas/guardar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(APP_CONFIG) }); const inp = document.getElementById("input-objetivo"); if (inp) { inp.style.backgroundColor = "var(--accent)"; inp.style.color = "#000"; setTimeout(() => { inp.style.backgroundColor = "#111"; inp.style.color = "var(--accent)"; }, 400); } } catch (e) { console.error("Error guardando objetivo", e); }
};

socket.on("new_node_detected", (nodoData) => { if (typeof window.prepararNuevoNodo === "function") window.prepararNuevoNodo(nodoData); });

// ═══ OMISIÓN REMOTA — fallback via socket (si BroadcastChannel no funciona) ═══
socket.on("sensor_omision_update", (data) => {
  _aplicarOmision(data.bajada, data.tren, data.omitido);
});
// Agregar al final de render_engine.js, junto a los otros socket.on()

socket.on("sections_update", (data) => {
  const seccionesT1 = data.t1 || [];
  const seccionesT2 = data.t2 || [];

  // Guardar estado local para que sensor_update pueda filtrar sin esperar al servidor
  _seccionesLocalesT1 = seccionesT1;
  _seccionesLocalesT2 = seccionesT2;
  console.log(`[Secciones] T1:[${seccionesT1.join(',')}] T2:[${seccionesT2.join(',')}]`);

  if (!APP_CONFIG?.mapeo_sensores) return;

  [1, 2].forEach(numTren => {
    const secciones = numTren === 1 ? seccionesT1 : seccionesT2;

    // Obtener surcos de este tren ordenados por bajada (mismo orden que el servidor)
    const surcosTren = APP_CONFIG.mapeo_sensores
      .filter(s => s.is_active !== false && (s.tren || 1) === numTren && s.tipo === "semilla")
      .sort((a, b) => a.bajada - b.bajada);

    surcosTren.forEach((sensor, idx) => {
      const cortado = secciones.length > 0 && secciones[idx] === 0;
      const key     = `T${numTren}-${sensor.bajada}`;
      const surcoId = `s-semilla-${sensor.bajada}`;
      const col     = document.getElementById(`surco-col-${key}`);
      const pill    = document.getElementById(surcoId);

      if (!col) return;

      if (cortado) {
        // Apagar visualmente el surco
        col.classList.add("cortado");
        col.classList.remove("falla", "desvio");
        if (pill) {
          pill.classList.remove("status-ok", "status-alerta", "status-desvio");
          pill.classList.add("status-tapado");
          pill.style.height = "3%";
        }
        // Limpiar del sistema de alarmas
        fallasActivas.delete(surcoId);
        surcosConFalla.delete(key);
      } else {
        // Reactivar el surco — el siguiente sensor_update lo va a pintar
        col.classList.remove("cortado");
      }
    });
  });

  // Actualizar ticker y alarma después de procesar todos los surcos
  _actualizarTicker();
  gestionarSonidoAlarma();
});

// ============================================================
// CENTRADO DE SENSORES POR TREN (layout desde snapshot)
// Solo re-aplica si los valores cambiaron (evita querySelectorAll en cada frame)
// ============================================================
var _lastLayoutHash = '';
function _aplicarLayoutTrenes(trenes, containerWidthPx) {
  if (!trenes || !trenes.length) return;

  // Hash rápido para detectar cambios de layout
  var hash = '';
  for (var i = 0; i < trenes.length; i++) {
    hash += trenes[i].tren + ',' + trenes[i].offsetXPx + ',' + trenes[i].spacingPx + ',' + trenes[i].sensorWidthPx + ';';
  }
  if (hash === _lastLayoutHash) return;
  _lastLayoutHash = hash;

  trenes.forEach(function(tl) {
    var row = document.getElementById('tren-row-' + tl.tren);
    if (!row) return;

    row.style.justifyContent = 'flex-start';
    row.style.paddingLeft = tl.offsetXPx + 'px';
    row.style.paddingRight = tl.offsetXPx + 'px';
    row.style.maxWidth = (containerWidthPx || 1200) + 'px';
    row.style.overflow = 'hidden';

    var cols = row.querySelectorAll('.surco-column');
    var w = tl.sensorWidthPx + 'px';
    for (var i = 0; i < cols.length; i++) {
      cols[i].style.width = w;
      cols[i].style.minWidth = w;
      cols[i].style.maxWidth = w;
    }
    row.style.gap = tl.spacingPx + 'px';
  });
}

// ============================================================
// window.updateData() — API para CefSharp (AgOpenGPS embebido)
// Recibe un snapshot JSON completo desde C# y actualiza toda la UI
// Optimizado: reutiliza objeto _surcoData para evitar GC pressure
// ============================================================
var _surcoData = { bajada:0, tipo:'', spm:0, valor:0, alerta:false, seccion_cortada:false, nuevas_semillas:0 };
// Cache de elementos DOM para KPIs (evita getElementById en cada frame)
var _kpiCache = null;
function _getKpiCache() {
  if (!_kpiCache) _kpiCache = {
    vel: document.getElementById('txt-vel'),
    dosis: document.getElementById('txt-dosis'),
    fallas: document.getElementById('kpi-fallas'),
    online: document.getElementById('kpi-online')
  };
  return _kpiCache;
}

window.updateData = function(jsonStr) {
  var snap;
  try {
    snap = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch(e) {
    console.error('[VistaX] updateData parse error:', e);
    return;
  }

  // KPIs globales (cached DOM refs)
  var kpi = _getKpiCache();
  if (kpi.vel && snap.Velocidad !== undefined) kpi.vel.innerText = parseFloat(snap.Velocidad).toFixed(1);
  if (kpi.dosis && snap.SpmPromedio !== undefined) kpi.dosis.innerText = parseFloat(snap.SpmPromedio).toFixed(1);
  if (kpi.fallas && snap.FallasActivas !== undefined) kpi.fallas.innerText = snap.FallasActivas;
  if (kpi.online && snap.SurcosActivos !== undefined) kpi.online.innerText = snap.SurcosActivos;

  // Centrado de trenes (layout calculado en C#)
  if (snap.Trenes) {
    _aplicarLayoutTrenes(snap.Trenes, snap.ContainerWidthPx);

    // Actualizar surcos — reutilizamos _surcoData para reducir allocations
    for (var ti = 0; ti < snap.Trenes.length; ti++) {
      var tl = snap.Trenes[ti];
      if (!tl.Surcos) continue;
      for (var si = 0; si < tl.Surcos.length; si++) {
        var surco = tl.Surcos[si];
        var tren = surco.Tren || tl.tren;
        var tipo = surco.Tipo || 'semilla';
        var el = document.getElementById('s-' + tipo + '-' + surco.Bajada);
        if (el) {
          _surcoData.bajada = surco.Bajada;
          _surcoData.tipo = tipo;
          _surcoData.spm = surco.Spm;
          _surcoData.valor = surco.Valor;
          _surcoData.alerta = surco.Alerta;
          _surcoData.seccion_cortada = surco.SeccionCortada;
          _surcoData.nuevas_semillas = surco.NuevasSemillas;
          actualizarPastillaEstado(el, _surcoData, tren, _sensorKey(surco.Bajada, tren));
        }
      }
    }
  } else if (snap.Surcos) {
    for (var si2 = 0; si2 < snap.Surcos.length; si2++) {
      var surco2 = snap.Surcos[si2];
      var tren2 = surco2.Tren || 1;
      var tipo2 = surco2.Tipo || 'semilla';
      var el2 = document.getElementById('s-' + tipo2 + '-' + surco2.Bajada);
      if (el2) {
        _surcoData.bajada = surco2.Bajada;
        _surcoData.tipo = tipo2;
        _surcoData.spm = surco2.Spm;
        _surcoData.valor = surco2.Valor;
        _surcoData.alerta = surco2.Alerta;
        _surcoData.seccion_cortada = surco2.SeccionCortada;
        _surcoData.nuevas_semillas = surco2.NuevasSemillas;
        actualizarPastillaEstado(el2, _surcoData, tren2, _sensorKey(surco2.Bajada, tren2));
      }
    }
  }

  // Estado de monitoreo
  if (typeof window._actualizarEstadoMonitoreo === 'function') {
    window._actualizarEstadoMonitoreo(!!snap.MonitoreoActivo);
  }

  // Botón manual: cambiar label según método y estado
  if (snap.MetodoInicio === 3 && !snap.MonitoreoActivo) {
    var lblManual = document.getElementById('lote-toggle-label');
    if (lblManual && !window.LOTE_ACTIVO?.activo) lblManual.textContent = '▶ INICIAR';
  }

  // Alarma global
  if (snap.AlarmMessage) _actualizarTicker();
  gestionarSonidoAlarma();
};