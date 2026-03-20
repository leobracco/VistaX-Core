// ============================================================
// VistaX — render_engine.js
// Motor de render de pastillas + lógica de alertas + modo compacto
// ============================================================

const socket = io();

// ============================================================
// ESTADO GLOBAL
// ============================================================
let fallasActivas   = new Set();
let surcosConFalla  = new Set();
let datosSurcos     = {};         // { bajada: { total_semillas, spm } }
let modoCompacto    = 'normal';   // 'normal' | 'compact' | 'mini'
let isMuted         = false;
let playingAlarm    = false;

const TIPOS_ESPECIALES = {
  rotacion_eje:      { icono: "fas fa-cogs",        unidad: "RPM"    },
  turbina:           { icono: "fas fa-fan",          unidad: "RPM"    },
  bajada_herramienta:{ icono: "fas fa-arrow-down",   unidad: "ESTADO" },
  bateria:           { icono: "fas fa-car-battery",  unidad: "V"      },
  tolva_vacia:       { icono: "fas fa-archive",      unidad: "ESTADO" },
};

// ============================================================
// AUDIO
// ============================================================
const audioAlarma = document.createElement("audio");
audioAlarma.id   = "audio-alarma";
audioAlarma.src  = "/sounds/alarma1.mp3";
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
// MODO COMPACTO — auto-selección según cantidad de surcos
// ============================================================
function detectarModo() {
  const total = window.TOTAL_SURCOS || 0;
  if (total > 96)      return 'mini';
  if (total > 48)      return 'compact';
  return 'normal';
}

window.toggleModoCompacto = function () {
  const modos = ['normal', 'compact', 'mini'];
  const idx   = modos.indexOf(modoCompacto);
  modoCompacto = modos[(idx + 1) % modos.length];
  aplicarModo(modoCompacto);

  const btn  = document.getElementById('btn-modo');
  const icon = btn && btn.querySelector('i');
  if (icon) {
    icon.className = modoCompacto === 'mini'    ? 'fas fa-th' :
                     modoCompacto === 'compact' ? 'fas fa-compress-alt' :
                                                  'fas fa-expand-alt';
  }
};

function aplicarModo(modo) {
  const grid = document.getElementById('main-monitor');
  if (!grid) return;
  grid.classList.remove('modo-compact', 'modo-mini');
  if (modo === 'compact') grid.classList.add('modo-compact');
  if (modo === 'mini')    grid.classList.add('modo-mini');

  // En modo mini, alternar visibilidad de números pares
  document.querySelectorAll('.surco-id').forEach((el, i) => {
    const num = parseInt(el.textContent);
    el.classList.toggle('par', num % 2 === 0);
  });
}

// ============================================================
// INICIALIZACIÓN DE LA INTERFAZ
// ============================================================
function inicializarUI() {
  if (!APP_CONFIG || !APP_CONFIG.mapeo_sensores) {
    console.log("[VistaX] Esperando configuración...");
    return;
  }

  const txtMaquina = document.getElementById("txt-maquina");
  if (txtMaquina) txtMaquina.innerText = APP_CONFIG.nombre || "DESCONOCIDA";

  // Prellenar objetivo si viene del config
  const inputObjetivo = document.getElementById("input-objetivo");
  if (inputObjetivo && APP_CONFIG.setup?.densidad_objetivo) {
    inputObjetivo.value = APP_CONFIG.setup.densidad_objetivo;
  }

  // Mostrar botón de modo si hay suficientes surcos para que tenga sentido
  const btnModo = document.getElementById('btn-modo');
  if (btnModo && (window.TOTAL_SURCOS || 0) > 20) {
    btnModo.style.display = 'flex';
  }

  // Auto-selección de modo según cantidad de surcos
  modoCompacto = detectarModo();

  const sensoresOrdenados = [...APP_CONFIG.mapeo_sensores].sort((a, b) => a.bajada - b.bajada);

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
    } else {
      const monitorGrid = document.getElementById("main-monitor");
      if (!monitorGrid) return;

      const numTren = sensor.tren || 1;
      const rowId   = `tren-row-${numTren}`;
      let rowContainer = document.getElementById(rowId);

      if (!rowContainer) {
        const wrapper  = document.createElement("div");
        wrapper.className = "tren-row-wrapper";
        wrapper.style.order = numTren;
        wrapper.innerHTML = `
          <div class="tren-title" onclick="toggleTren('${rowId}')">
            <span>TREN ${numTren === 1 ? '1 — DELANTERO' : '2 — TRASERO'}</span>
            <i class="fas fa-chevron-up" style="font-size:9px"></i>
          </div>
          <div class="tren-row" id="${rowId}"></div>`;
        monitorGrid.appendChild(wrapper);
        rowContainer = document.getElementById(rowId);
      }

      let surcoCol = document.getElementById(colId);
      if (!surcoCol) {
        surcoCol           = document.createElement("div");
        surcoCol.id        = colId;
        surcoCol.className = "surco-column";
        surcoCol.onclick   = () => abrirDetalleSurco(sensor.bajada, sensor.tipo);

        // En modo mini, ocultar números pares
        const numPar = sensor.bajada % 2 === 0;
        surcoCol.innerHTML = `
          <div class="surco-id${numPar ? ' par' : ''}">${sensor.bajada}</div>
          <div class="pills-area"></div>`;
        rowContainer.appendChild(surcoCol);
      }

      const pillsArea = surcoCol.querySelector(".pills-area");
      if (pillsArea && !document.getElementById(surcoId)) {
        const pill       = document.createElement("div");
        pill.id          = surcoId;
        // Clase base para colorimetría por tipo
        const tipoClass  = sensor.tipo === 'ferti_linea'    ? 'pill-ferti-linea' :
                           sensor.tipo === 'ferti_costado'  ? 'pill-ferti-costado' : '';
        pill.className   = `pill-status status-tapado ${tipoClass}`.trim();
        pill.title       = sensor.nombre || `${sensor.tipo} #${sensor.bajada}`;
        pillsArea.appendChild(pill);
      }
    }
  });

  // Aplicar modo después de construir el DOM
  aplicarModo(modoCompacto);
}

window.toggleTren = function (rowId) {
  const row  = document.getElementById(rowId);
  const icon = row?.previousElementSibling?.querySelector("i");
  if (!row) return;
  const oculto = row.style.display === "none";
  row.style.display  = oculto ? "flex" : "none";
  if (icon) icon.className = oculto ? "fas fa-chevron-up" : "fas fa-chevron-down";
  if (icon) icon.style.fontSize = "9px";
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
  datosSurcos[data.bajada].spm            = data.spm || 0;

  const surcoId = `s-${data.tipo}-${data.bajada}`;
  const el      = document.getElementById(surcoId);
  if (el) {
    actualizarPastillaEstado(el, data);
    if (TIPOS_ESPECIALES[data.tipo]) {
      const valText = el.querySelector(".val-text");
      if (valText) valText.innerText = data.valor;
    }
  }

  // Actualizar modal de detalle si está abierto en este surco
  const modalDetalle = document.getElementById("surco-modal-detalle");
  if (modalDetalle?.style.display === "flex" && modalDetalle.dataset.surco == data.bajada) {
    const elSpm   = document.getElementById("detalle-spm");
    const elTotal = document.getElementById("detalle-total");
    if (elSpm)   elSpm.innerText   = data.spm;
    if (elTotal) elTotal.innerText = datosSurcos[data.bajada].total_semillas.toLocaleString("es-AR");
  }
});

// ============================================================
// ACTUALIZACIÓN GLOBAL (GPS / velocidad)
// ============================================================
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
// DETALLE DE SURCO — modal oscuro, touch-friendly
// ============================================================
window.abrirDetalleSurco = function (numero, tipo) {
  const data = datosSurcos[numero] || { total_semillas: 0, spm: 0 };

  let overlay = document.getElementById("surco-modal-detalle");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "surco-modal-detalle";
    overlay.style.cssText = [
      "position:fixed","inset:0","background:rgba(0,0,0,.75)",
      "display:flex","align-items:center","justify-content:center","z-index:9999"
    ].join(";");
    overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = "none"; };
    document.body.appendChild(overlay);
  }

  overlay.dataset.surco = numero;

  const objetivo = APP_CONFIG?.setup?.densidad_objetivo || 16;
  const spm      = parseFloat(data.spm) || 0;
  const pct      = objetivo > 0 ? Math.min((spm / objetivo) * 100, 200) : 0;
  const color    = spm === 0        ? '#ff1744' :
                   pct < 70         ? '#ffb300' :
                   pct > 130        ? '#00e5ff' : '#00e676';

  overlay.innerHTML = `
    <div style="
      background:#141414;border:1px solid #2a2a2a;border-radius:10px;
      min-width:260px;max-width:300px;overflow:hidden;
      box-shadow:0 20px 60px rgba(0,0,0,.8);
    ">
      <div style="background:#1e1e1e;padding:14px 18px;border-bottom:1px solid #222;
                  display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:10px;color:#555;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">
            ${tipo.replace(/_/g,' ')}
          </div>
          <div style="font-size:18px;font-weight:900;color:white;">SURCO ${numero}</div>
        </div>
        <button onclick="document.getElementById('surco-modal-detalle').style.display='none'"
                style="background:transparent;border:none;color:#555;font-size:24px;cursor:pointer;line-height:1;">
          &times;
        </button>
      </div>

      <div style="padding:18px;">
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:11px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:6px;">
            Densidad Actual
          </div>
          <div id="detalle-spm" style="font-size:48px;font-weight:900;color:${color};line-height:1;">
            ${spm}
          </div>
          <div style="font-size:13px;color:#444;">semillas / metro</div>
        </div>

        <div style="background:#0a0a0a;border-radius:4px;overflow:hidden;height:6px;margin-bottom:16px;">
          <div style="height:100%;width:${Math.min(pct,100)}%;background:${color};
                      transition:width .3s;border-radius:4px;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#333;margin-bottom:16px;">
          <span>0</span><span>Objetivo: ${objetivo}</span><span>${objetivo * 2}</span>
        </div>

        <div style="background:#0a0a0a;border:1px solid #1e1e1e;border-radius:6px;
                    padding:12px;text-align:center;">
          <div style="font-size:9px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:4px;">
            Total acumulado en lote
          </div>
          <div id="detalle-total" style="font-size:22px;font-weight:700;color:#ccc;">
            ${data.total_semillas.toLocaleString("es-AR")}
          </div>
        </div>
      </div>
    </div>
  `;

  overlay.style.display = "flex";
};

// ============================================================
// LÓGICA DE ALERTAS Y COLORES DE PASTILLA
// ============================================================
function actualizarPastillaEstado(el, data) {
  const surcoCol = document.getElementById(`surco-col-${data.bajada}`);
  const surcoId  = el.id;

  // Preservar clases de tipo (ferti)
  const tipoClass = el.classList.contains('pill-ferti-linea')   ? 'pill-ferti-linea' :
                    el.classList.contains('pill-ferti-costado') ? 'pill-ferti-costado' : '';

  el.classList.remove("status-ok", "status-alerta", "status-tapado");

  if (data.alerta) {
    el.classList.add("status-alerta");
    fallasActivas.add(surcoId);
    surcosConFalla.add(data.bajada);
    if (surcoCol) surcoCol.classList.add("falla");
  } else if (parseFloat(data.valor) > 0) {
    el.classList.add("status-ok");
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(data.bajada);
    if (surcoCol) surcoCol.classList.remove("falla");
  } else {
    el.classList.add("status-tapado");
    fallasActivas.delete(surcoId);
    surcosConFalla.delete(data.bajada);
    if (surcoCol) surcoCol.classList.remove("falla");
  }

  // Ticker de alertas
  const ticker = document.getElementById("alert-ticker");
  if (ticker) {
    if (surcosConFalla.size > 0) {
      const lista = [...surcosConFalla].sort((a, b) => a - b).join(", ");
      ticker.innerText = `FALLA EN SURCO ${lista}`;
      ticker.classList.add("active-alert");
    } else {
      ticker.innerText = "SISTEMA VISTAX OPERATIVO";
      ticker.classList.remove("active-alert");
    }
  }

  const kpiFallas = document.getElementById("kpi-fallas");
  if (kpiFallas) kpiFallas.innerText = fallasActivas.size;

  gestionarSonidoAlarma();
}

// ============================================================
// KPI OBJETIVO — guardado silencioso
// ============================================================
window.guardarObjetivoRapido = async function (val) {
  if (!APP_CONFIG) return;
  if (!APP_CONFIG.setup) APP_CONFIG.setup = {};
  APP_CONFIG.setup.densidad_objetivo = parseFloat(val);

  try {
    await fetch("/api/config/maquinas/guardar", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(APP_CONFIG),
    });
    const inp = document.getElementById("input-objetivo");
    if (inp) {
      inp.style.backgroundColor = "var(--accent)";
      inp.style.color            = "#000";
      setTimeout(() => { inp.style.backgroundColor = "#111"; inp.style.color = "var(--accent)"; }, 400);
    }
  } catch (e) { console.error("Error guardando objetivo", e); }
};

// ============================================================
// GESTIÓN DE LOTE DESDE EL MONITOR PRINCIPAL
// ============================================================
window.abrirModalLote = function () {
  document.getElementById("modal-lote").style.display = "flex";
};

window.cerrarModalLote = function () {
  document.getElementById("modal-lote").style.display = "none";
};

window.iniciarLoteDesdeMonitor = async function () {
  const nombre  = document.getElementById("lote-inp-nombre")?.value.trim();
  const cultivo = document.getElementById("lote-inp-cultivo")?.value;
  const ancho   = APP_CONFIG?.setup?.distancia_entre_surcos || 0.191;

  if (!nombre) {
    const inp = document.getElementById("lote-inp-nombre");
    if (inp) inp.style.borderColor = "var(--danger)";
    return;
  }

  const res = await fetch("/api/mapa/iniciar", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ nombre, cultivo, anchoPasada: ancho }),
  });

  if (res.ok) {
    cerrarModalLote();
    // Actualizar footer sin reload
    const txt = document.getElementById("txt-lote");
    if (txt) txt.innerText = nombre.toUpperCase();
    const info = document.getElementById("lote-info-footer");
    if (info) info.classList.add("activo");
    _mostrarToastMonitor(`Lote "${nombre}" iniciado`);
  }
};

window.cerrarLoteDesdeMonitor = async function () {
  if (!confirm("¿Cerrás el lote activo?")) return;
  const res = await fetch("/api/mapa/cerrar", { method: "POST" });
  if (res.ok) {
    cerrarModalLote();
    const txt = document.getElementById("txt-lote");
    if (txt) txt.innerText = "SIN LOTE — INICIAR";
    const info = document.getElementById("lote-info-footer");
    if (info) info.classList.remove("activo");
    _mostrarToastMonitor("Lote cerrado. GeoJSON exportado.");
  }
};

function _mostrarToastMonitor(msg) {
  let t = document.getElementById("_vistax_toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "_vistax_toast";
    t.style.cssText = [
      "position:fixed","bottom:70px","left:50%","transform:translateX(-50%) translateY(40px)",
      "background:#1e1e1e","border:1px solid var(--accent)","border-radius:6px",
      "padding:10px 18px","font-size:12px","color:var(--accent)","z-index:9998",
      "opacity:0","transition:all .3s","pointer-events:none","white-space:nowrap"
    ].join(";");
    document.body.appendChild(t);
  }
  t.innerText = msg;
  t.style.opacity   = "1";
  t.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(t._tid);
  t._tid = setTimeout(() => {
    t.style.opacity   = "0";
    t.style.transform = "translateX(-50%) translateY(40px)";
  }, 3000);
}

// ============================================================
// AUTO-REGISTRO DE NODOS NUEVOS
// ============================================================
socket.on("new_node_detected", (nodoData) => {
  if (typeof window.prepararNuevoNodo === "function") {
    window.prepararNuevoNodo(nodoData);
  }
});
