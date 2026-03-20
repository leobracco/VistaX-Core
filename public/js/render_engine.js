const socket = io();
let fallasActivas = new Set();
let surcosConFalla = new Set();

// UNIFICAMOS LOS DICCIONARIOS EN UNO SOLO PARA EVITAR CONFLICTOS
const TIPOS_ESPECIALES = {
  rotacion_eje: { icono: "fas fa-cogs", unidad: "RPM" },
  turbina: { icono: "fas fa-fan", unidad: "RPM" },
  bajada_herramienta: { icono: "fas fa-arrow-down", unidad: "ESTADO" },
  bateria: { icono: "fas fa-car-battery", unidad: "V" },
  tolva_vacia: { icono: "fas fa-archive", unidad: "ESTADO" },
};
// --- SISTEMA DE AUDIO Y ALARMAS ---
let isMuted = false;
let playingAlarm = false;

// Creamos el elemento de audio dinámicamente
const audioAlarma = document.createElement("audio");
audioAlarma.id = "audio-alarma";
audioAlarma.src = "/sounds/alarma1.mp3"; // Asegurate de poner un mp3 en public/sounds/
audioAlarma.loop = true;
document.body.appendChild(audioAlarma);

// Función atada al botón del footer: onclick="toggleMute()"
window.toggleMute = function () {
  isMuted = !isMuted;
  const btnTool = document.querySelector(
    ".actions .btn-tool i.fa-volume-up, .actions .btn-tool i.fa-volume-mute",
  );

  if (btnTool) {
    btnTool.className = isMuted ? "fas fa-volume-mute" : "fas fa-volume-up";
    btnTool.style.color = isMuted ? "var(--danger)" : "white";
  }

  if (isMuted) {
    audioAlarma.pause();
    playingAlarm = false;
  } else {
    gestionarSonidoAlarma();
  }
};

// Se llama cada vez que se actualiza un estado
function gestionarSonidoAlarma() {
  if (isMuted) return;

  if (fallasActivas.size > 0) {
    if (!playingAlarm) {
      // El catch evita errores si el navegador bloquea el autoplay
      audioAlarma
        .play()
        .catch((e) => console.log("Audio bloqueado por el navegador"));
      playingAlarm = true;
    }
  } else {
    audioAlarma.pause();
    audioAlarma.currentTime = 0; // Reinicia el sonido
    playingAlarm = false;
  }
}
// ==========================================
// INICIALIZACIÓN DE LA INTERFAZ
// ==========================================
function inicializarUI() {
  if (!APP_CONFIG || !APP_CONFIG.mapeo_sensores) {
    console.log("Esperando configuración...");
    return;
  }

  const txtMaquina = document.getElementById("txt-maquina");
  if (txtMaquina) txtMaquina.innerText = APP_CONFIG.nombre || "DESCONOCIDA";

  const sensoresOrdenados = APP_CONFIG.mapeo_sensores.sort(
    (a, b) => a.bajada - b.bajada,
  );

  sensoresOrdenados.forEach((sensor) => {
    let surcoId = `s-${sensor.tipo}-${sensor.bajada}`;
    let colId = `surco-col-${sensor.bajada}`;
    let isEspecial = TIPOS_ESPECIALES.hasOwnProperty(sensor.tipo);

    if (isEspecial) {
      // DIBUJAR TARJETA EN EL FOOTER
      const container = document.getElementById("tren-especiales");
      if (container && !document.getElementById(surcoId)) {
        let card = document.createElement("div");
        card.id = surcoId;
        card.className = "sensor-especial";
        card.innerHTML = `<i class="${TIPOS_ESPECIALES[sensor.tipo].icono}"></i>
                          <div class="info">
                            <span>${sensor.nombre || sensor.tipo.replace("_", " ")}</span>
                            <strong class="val-text">0.0</strong>
                          </div>`;
        container.appendChild(card);
      }
    } else {
      // DIBUJAR PASTILLA EN EL ÁREA CENTRAL
      const monitorGrid = document.getElementById("main-monitor");
      if (monitorGrid) {
        let numTren = sensor.tren || 1;
        let rowId = `tren-row-${numTren}`;
        let rowContainer = document.getElementById(rowId);

        // Crear el Tren si no existe
        if (!rowContainer) {
          let wrapper = document.createElement("div");
          wrapper.className = "tren-row-wrapper";
          wrapper.style.order = numTren;
          wrapper.innerHTML = `
            <div class="tren-title" onclick="toggleTren('${rowId}')" style="cursor: pointer; display: flex; justify-content: space-between; padding-right: 10px;">
                <span>TREN ${numTren === 1 ? "1 (DEL.)" : "2 (TRAS.)"}</span>
                <i class="fas fa-chevron-up"></i>
            </div>
            <div class="tren-row" id="${rowId}"></div>`;
          monitorGrid.appendChild(wrapper);
          rowContainer = document.getElementById(rowId);
        }

        // Crear la Columna del Surco si no existe
        let surcoCol = document.getElementById(colId);
        if (!surcoCol) {
          surcoCol = document.createElement("div");
          surcoCol.id = colId;
          surcoCol.className = "surco-column";
          surcoCol.onclick = () =>
            abrirDetalleSurco(sensor.bajada, sensor.tipo);
          surcoCol.innerHTML = `<div class="surco-id">${sensor.bajada}</div><div class="pills-area"></div>`;
          rowContainer.appendChild(surcoCol);
        }

        // Agregar la Pastilla al Surco
        const pillsArea = surcoCol.querySelector(".pills-area");
        if (pillsArea && !document.getElementById(surcoId)) {
          let surco = document.createElement("div");
          surco.id = surcoId;
          surco.className = `pill-status status-tapado`; // Inicia apagado
          pillsArea.appendChild(surco);
        }
      }
    }
  });
}
window.toggleTren = function (rowId) {
  const row = document.getElementById(rowId);
  const icon = row.previousElementSibling.querySelector("i");
  if (row.style.display === "none") {
    row.style.display = "flex";
    icon.className = "fas fa-chevron-up";
  } else {
    row.style.display = "none";
    icon.className = "fas fa-chevron-down";
  }
};
inicializarUI();

// ==========================================
// RECEPCIÓN DE DATOS EN TIEMPO REAL
// ==========================================
// Variable en memoria para llevar la cuenta de cada surco individual
let datosSurcos = {};

// ==========================================
// CAPTURA DE LOS DATOS PARA EL SURCO
// ==========================================
socket.on("sensor_update", (data) => {
  // 1. Guardamos los datos estadísticos en la memoria
  if (!datosSurcos[data.bajada]) {
    datosSurcos[data.bajada] = { total_semillas: 0, spm: 0 };
  }
  datosSurcos[data.bajada].total_semillas += data.nuevas_semillas || 0;
  datosSurcos[data.bajada].spm = data.spm || 0;

  // 2. Encendemos la pastilla de la sembradora (Verde/Rojo)
  const surcoId = `s-${data.tipo}-${data.bajada}`;
  const elemento = document.getElementById(surcoId);

  if (elemento) {
    actualizarPastillaEstado(elemento, data);
    if (TIPOS_ESPECIALES[data.tipo]) {
      const valText = elemento.querySelector(".val-text");
      if (valText) valText.innerText = data.valor;
    }
  }

  // 3. ¡LA MAGIA EN VIVO! Si la ventanita de detalles está abierta, actualizamos los números al instante
  const modalAbierto = document.getElementById("surco-modal-detalle");
  if (modalAbierto && modalAbierto.style.display === "flex") {
    // Verificamos si la ventana que está abierta es la de este surco exacto
    if (modalAbierto.dataset.surco == data.bajada) {
      document.getElementById("detalle-spm").innerText = data.spm;
      document.getElementById("detalle-total").innerText =
        datosSurcos[data.bajada].total_semillas.toLocaleString();
    }
  }
});

// ==========================================
// FUNCIÓN AL TOCAR LA PASTILLA DEL SURCO
// ==========================================
// ==========================================
// FUNCIÓN AL TOCAR LA PASTILLA DEL SURCO
// ==========================================
// ==========================================
// FUNCIÓN AL TOCAR LA PASTILLA DEL SURCO
// ==========================================
window.abrirDetalleSurco = function (numero, tipo) {
  // Obtenemos los datos del surco o ponemos 0 si aún no arrancó
  const data = datosSurcos[numero] || { total_semillas: 0, spm: 0 };

  // Creamos la ventanita flotante si no existe
  let overlay = document.getElementById("surco-modal-detalle");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "surco-modal-detalle";
    overlay.style.cssText =
      "position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 9999;";
    document.body.appendChild(overlay);
  }

  // Le pegamos una etiqueta invisible a la ventana para saber a qué surco pertenece
  overlay.dataset.surco = numero;

  // Llenamos la ventana con los datos actualizados (¡AQUÍ ESTÁN LOS IDs QUE FALTABAN!)
  overlay.innerHTML = `
    <div style="background: white; padding: 25px; border-radius: 12px; min-width: 280px; text-align: center; border: 3px solid #0d6efd; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
        <h2 style="margin-top:0; color: #0d6efd; font-weight: bold;">🌱 Surco ${numero}</h2>
        <p style="color: #666; font-size: 0.9rem; text-transform: uppercase;">${tipo.replace("_", " ")}</p>
        <hr>
        <div style="margin: 20px 0;">
            <p style="font-size: 1.1rem; margin-bottom: 5px;">Densidad Actual:</p>
            <p style="font-size: 2rem; font-weight: bold; color: #28a745; margin: 0;">
                <span id="detalle-spm">${data.spm}</span> <span style="font-size: 1rem; color: #333;">s/m</span>
            </p>
        </div>
        <div style="margin: 20px 0; background: #f8f9fa; padding: 10px; border-radius: 8px;">
            <p style="font-size: 1rem; margin-bottom: 5px; color: #555;">Total Acumulado:</p>
            <p id="detalle-total" style="font-size: 1.5rem; font-weight: bold; margin: 0; color: #555;">${data.total_semillas.toLocaleString()}</p>
        </div>
        <button onclick="document.getElementById('surco-modal-detalle').style.display='none'" style="margin-top: 10px; padding: 10px 30px; background: #dc3545; color: white; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; font-size: 1.1rem; width: 100%;">Cerrar</button>
    </div>
  `;

  // Mostramos el modal
  overlay.style.display = "flex";
};

// Función centralizada para colorear las pastillas
function actualizarPastillaEstado(elemento, data) {
  const surcoCol = document.getElementById(`surco-col-${data.bajada}`);
  const surcoId = elemento.id;

  // Limpiar clases anteriores
  elemento.classList.remove("status-ok", "status-alerta", "status-tapado");

  if (data.alerta) {
    elemento.classList.add("status-alerta");
    fallasActivas.add(surcoId);
    if (surcoCol) surcoCol.classList.add("falla");
    surcosConFalla.add(data.bajada);
  } else if (data.valor > 0) {
    elemento.classList.add("status-ok");
    fallasActivas.delete(surcoId);
    if (surcoCol) surcoCol.classList.remove("falla");
    surcosConFalla.delete(data.bajada);
  } else {
    elemento.classList.add("status-tapado");
    fallasActivas.delete(surcoId);
    if (surcoCol) surcoCol.classList.remove("falla");
    surcosConFalla.delete(data.bajada);
  }

  // Actualizar Ticker y KPI de Fallas
  const ticker = document.getElementById("alert-ticker");
  if (ticker) {
    if (surcosConFalla.size > 0) {
      ticker.innerText = `FALLA EN SURCO ${[...surcosConFalla].sort((a, b) => a - b).join(", ")}`;
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

// ==========================================
// ACTUALIZACIÓN GLOBAL (GPS)
// ==========================================
socket.on("global_update", (stats) => {
  if (stats.velocidad !== undefined) {
    const txtVel = document.getElementById("txt-vel");
    if (txtVel) txtVel.innerText = stats.velocidad.toFixed(1);
  }
  if (stats.promedio !== undefined) {
    const kpiAvg = document.getElementById("kpi-avg");
    if (kpiAvg) kpiAvg.innerText = stats.promedio;
  }
});

function abrirDetalleSurco(numero, tipo) {
  console.log(`Abriendo detalle del surco ${numero} (${tipo})`);
}

window.guardarObjetivoRapido = async function (nuevoValor) {
  if (!APP_CONFIG || !APP_CONFIG.id) return;

  // Actualizar variable en memoria
  if (!APP_CONFIG.setup) APP_CONFIG.setup = {};
  APP_CONFIG.setup.densidad_objetivo = parseFloat(nuevoValor);

  // Guardado silencioso en el backend
  try {
    await fetch("/api/config/maquinas/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(APP_CONFIG),
    });

    // Destello verde para avisarle al operario que se guardó
    const input = document.getElementById("input-objetivo");
    input.style.backgroundColor = "var(--accent)";
    input.style.color = "#000";
    setTimeout(() => {
      input.style.backgroundColor = "#111";
      input.style.color = "var(--accent)";
    }, 300);
  } catch (e) {
    console.error("Error guardando objetivo", e);
  }
};

// ==========================================
// DETECCIÓN DE NUEVOS NODOS (AUTO-REGISTRO)
// ==========================================
socket.on("new_node_detected", (nodoData) => {
  console.log("--> LLEGÓ AL NAVEGADOR EL EVENTO DEL NODO: ", nodoData); // Agregamos esto para espiar

  // Evitamos repeticiones (COMENTADO TEMPORALMENTE PARA PROBAR)
  // if (window.ultimoNodoDetectado === nodoData.uid) return;
  // window.ultimoNodoDetectado = nodoData.uid;

  // Llamamos directamente a la función que abre el modal sin preguntar
  if (typeof window.prepararNuevoNodo === "function") {
    window.prepararNuevoNodo(nodoData);
  } else {
    console.error(
      "🚨 ERROR: No se encontró la función prepararNuevoNodo en config.js",
    );
  }
});
