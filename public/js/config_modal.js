let workingMapeo = [];
let nodoActual = "";

// --- 1. INICIALIZACIÓN Y CARGA ---
function abrirModal() {
  const modal = document.getElementById("modal-config");
  if (!modal) return;
  modal.style.display = "flex";

  const setValueIfExists = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };

  // Cargar General
  setValueIfExists("cfg-nombre", APP_CONFIG.nombre || "Máquina Sin Nombre");
  setValueIfExists(
    "cfg-distancia",
    APP_CONFIG.setup?.distancia_entre_surcos || 0.191,
  );
  setValueIfExists("cfg-k", APP_CONFIG.setup?.factor_k_default || 0.15);
  setValueIfExists("cfg-p1000", APP_CONFIG.setup?.p1000 || 180);
  setValueIfExists("cfg-rpm-min", APP_CONFIG.setup?.rpm_min || 2000);
  setValueIfExists("cfg-rpm-max", APP_CONFIG.setup?.rpm_max || 5000);
  setValueIfExists("cfg-qty-tolvas", APP_CONFIG.setup?.tolvas || 2);

  const txtId = document.getElementById("cfg-id-maquina");
  if (txtId) txtId.innerText = `ID: ${APP_CONFIG.id || "N/A"}`;

  // Clonamos la config para editarla en memoria sin afectar la principal hasta guardar
  workingMapeo = JSON.parse(JSON.stringify(APP_CONFIG.mapeo_sensores || []));

  actualizarSelectNodos();
  switchTab("general");
}

// --- 2. LÓGICA DE NODOS (SELECTOR) ---
function actualizarSelectNodos(nodoForzado = null) {
  const select = document.getElementById("select-nodo-filter");
  if (!select) return;

  // Extraer nombres de nodos únicos
  let nodos = [...new Set(workingMapeo.map((s) => s.uid))];
  if (nodos.length === 0) nodos.push("VX-A1"); // Nodo inicial si la máquina está vacía

  select.innerHTML = "";
  nodos.sort().forEach((n) => {
    select.innerHTML += `<option value="${n}">${n}</option>`;
  });

  nodoActual = nodoForzado || nodos[0];
  select.value = nodoActual;

  renderizarTablaNodo(nodoActual);
}

function guardarEstadoTablaActual() {
  if (!nodoActual) return;

  // Limpiamos la memoria solo de este nodo
  workingMapeo = workingMapeo.filter((s) => s.uid !== nodoActual);

  const filas = document.querySelectorAll(
    "#lista-sensores-tbody tr.sensor-row",
  );
  filas.forEach((fila) => {
    const bajada = parseInt(fila.querySelector(".edit-bajada").value);
    workingMapeo.push({
      uid: nodoActual,
      cable: parseInt(fila.querySelector(".edit-cable").value),
      bajada: bajada,
      tipo: fila.querySelector(".edit-tipo").value,
      nombre: "S" + bajada,
      tren: parseInt(fila.querySelector(".edit-tren").value), // <-- ¡Leemos el select del tren!
    });
  });
}

function cambiarNodo() {
  guardarEstadoTablaActual(); // Guardar cambios del nodo anterior
  nodoActual = document.getElementById("select-nodo-filter").value;
  renderizarTablaNodo(nodoActual); // Cargar el nuevo nodo seleccionado
}

function agregarNuevoNodo() {
  guardarEstadoTablaActual();
  const nuevo = prompt("Identificador del nuevo nodo (Ej: VX-B2):");
  if (nuevo && nuevo.trim() !== "") {
    nodoActual = nuevo.trim().toUpperCase();
    workingMapeo.push({
      uid: nodoActual,
      cable: 1,
      bajada: 1,
      tipo: "semilla",
    }); // Crea un cable inicial
    actualizarSelectNodos(nodoActual);
  }
}

// --- 3. DIBUJAR LA TABLA (SOLO EL NODO SELECCIONADO) ---
function renderizarTablaNodo(uid) {
  const tbody = document.getElementById("lista-sensores-tbody");
  if (!tbody) return;
  tbody.innerHTML = ""; // Vaciamos la tabla por completo

  // Filtramos para que SOLO aparezcan los de este nodo
  const sensoresNodo = workingMapeo.filter((s) => s.uid === uid);

  sensoresNodo
    .sort((a, b) => a.cable - b.cable)
    .forEach((sensor) => {
      agregarFilaSensor(sensor);
    });
}

function agregarFilaSensor(datos = null) {
  // Agregamos tren: 1 por defecto si es nuevo
  if (!datos)
    datos = { uid: nodoActual, cable: 1, bajada: 1, tipo: "semilla", tren: 1 };

  const tbody = document.getElementById("lista-sensores-tbody");
  const row = document.createElement("tr");
  row.className = "sensor-row";

  const opcionesTipo = [
    { val: "semilla", label: "Semilla" },
    { val: "ferti_linea", label: "Ferti Línea" },
    { val: "ferti_costado", label: "Ferti Costado" },
    { val: "turbina", label: "RPM Turbina" },
    { val: "rotacion_eje", label: "Rotación Eje" },
    { val: "tolva_vacia", label: "Nivel de Tolva" },
    { val: "bajada_herramienta", label: "Sensor de Trabajo" },
    { val: "bateria", label: "Voltaje Bat." },
  ];

  const selectHTML = opcionesTipo
    .map(
      (opt) =>
        `<option value="${opt.val}" ${datos.tipo === opt.val ? "selected" : ""}>${opt.label}</option>`,
    )
    .join("");

  row.innerHTML = `
        <td><input type="number" class="edit-cable" value="${datos.cable}" min="1" max="7"></td>
        <td><input type="number" class="edit-bajada" value="${datos.bajada}"></td>
        <td>
            <select class="edit-tren">
                <option value="1" ${datos.tren == 1 ? "selected" : ""}>Tren 1 (Delantero)</option>
                <option value="2" ${datos.tren == 2 ? "selected" : ""}>Tren 2 (Trasero)</option>
            </select>
        </td>
        <td><select class="edit-tipo">${selectHTML}</select></td>
        <td style="text-align:center">
            <button class="btn-delete" onclick="this.parentElement.parentElement.remove()"><i class="fas fa-trash"></i></button>
        </td>
    `;
  tbody.appendChild(row);
}
// --- 4. TABS Y MAPA VISUAL ---
window.switchTab = function (tabId) {
  if (tabId === "mapeo") guardarEstadoTablaActual(); // Guardamos antes de dibujar el mapa

  document
    .querySelectorAll(".tab-content")
    .forEach((t) => (t.style.display = "none"));
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.remove("active"));

  const target = document.getElementById(`tab-${tabId}`);
  if (target) {
    target.style.display = "block";
    const btn = document.querySelector(
      `button[onclick="switchTab('${tabId}')"]`,
    );
    if (btn) btn.classList.add("active");
  }

  if (tabId === "mapeo") dibujarPlanta();
};

function dibujarPlanta() {
  const canvas = document.getElementById("mapeo-visual-canvas");
  if (!canvas) return;
  canvas.innerHTML = "";

  const grupos = { tren1: [], tren2: [], especiales: [] };
  const tiposEspeciales = [
    "turbina",
    "rotacion_eje",
    "tolva_vacia",
    "bajada_herramienta",
    "bateria",
  ];

  // 1. Clasificamos todos los sensores que están en la memoria actual
  workingMapeo.forEach((s) => {
    if (tiposEspeciales.includes(s.tipo)) {
      grupos.especiales.push(s);
    } else {
      // Asignamos al tren configurado (o 1 por defecto)
      const t = `tren${s.tren || 1}`;
      if (!grupos[t]) grupos[t] = [];
      grupos[t].push(s);
    }
  });

  // 2. Dibujar Trenes de Siembra (Con el mismo diseño de la pantalla principal)
  ["tren1", "tren2"].forEach((tKey) => {
    if (grupos[tKey] && grupos[tKey].length > 0) {
      const row = document.createElement("div");
      row.className = "mapeo-tren-row";
      row.innerHTML = `<small>${tKey.toUpperCase()}</small>`;

      const grid = document.createElement("div");
      grid.style.display = "flex";
      grid.style.gap = "4px"; // Mismo gap que la principal
      grid.style.flexWrap = "nowrap";
      grid.style.overflowX = "auto";
      grid.style.paddingBottom = "10px";
      grid.style.justifyContent = "center";

      // Agrupamos por bajada (Por si hay semilla y ferti en el mismo surco)
      const bajadas = {};
      grupos[tKey].forEach((s) => {
        if (!bajadas[s.bajada]) bajadas[s.bajada] = [];
        bajadas[s.bajada].push(s);
      });

      // Dibujamos las columnas
      Object.keys(bajadas)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .forEach((numBajada) => {
          const col = document.createElement("div");
          col.className = "surco-column"; // REUTILIZAMOS LA CLASE PRINCIPAL
          col.style.flexShrink = "0";

          // Creamos tantas pastillas como sensores haya en esta bajada
          let pillsHTML = "";
          bajadas[numBajada].forEach((sensor) => {
            // Usamos status-tapado (negro) con borde gris para indicar que "está configurado"
            pillsHTML += `<div class="pill-status status-tapado" title="${sensor.tipo.toUpperCase()}" style="border-color: #555;"></div>`;
          });

          col.innerHTML = `
                    <div class="surco-id">${numBajada}</div>
                    <div class="pills-area">${pillsHTML}</div>
                `;
          grid.appendChild(col);
        });

      row.appendChild(grid);
      canvas.appendChild(row);
    }
  });

  // 3. Dibujar Sensores de Estado (Especiales)
  if (grupos.especiales.length > 0) {
    const espRow = document.createElement("div");
    espRow.className = "mapeo-tren-row";
    espRow.innerHTML = `<small>SENSORES DE ESTADO</small>`;

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.gap = "8px";
    grid.style.flexWrap = "wrap";
    grid.style.justifyContent = "center";

    // Diccionario de íconos para los especiales
    const ICONOS = {
      rotacion_eje: "fas fa-cogs",
      turbina: "fas fa-fan",
      bajada_herramienta: "fas fa-arrow-down",
      bateria: "fas fa-car-battery",
      tolva_vacia: "fas fa-archive",
    };

    // Ordenamos y dibujamos
    grupos.especiales
      .sort((a, b) => a.bajada - b.bajada)
      .forEach((e) => {
        const box = document.createElement("div");
        box.className = "sensor-especial"; // REUTILIZAMOS LA CLASE PRINCIPAL
        box.style.borderColor = "#444";

        box.innerHTML = `
                <i class="${ICONOS[e.tipo] || "fas fa-microchip"}" style="color: #666;"></i>
                <div class="info">
                    <span style="color: #888;">${e.tipo.replace("_", " ").toUpperCase()}</span>
                    <strong style="color: #aaa;">#${e.bajada}</strong>
                </div>
            `;
        grid.appendChild(box);
      });

    espRow.appendChild(grid);
    canvas.appendChild(espRow);
  }
}
// --- 5. VALIDACIÓN Y GUARDADO ---
function validarDuplicados() {
  guardarEstadoTablaActual();
  let vistos = new Set();
  for (let i = 0; i < workingMapeo.length; i++) {
    let s = workingMapeo[i];
    let clave = `${s.tipo}-${s.bajada}`;
    if (vistos.has(clave)) {
      alert(
        `⚠️ ERROR DE CONFIGURACIÓN:\n\nTienes más de un sensor "${s.tipo}" en la bajada ${s.bajada}.`,
      );
      return false;
    }
    vistos.add(clave);
  }
  return true;
}

async function guardarConfiguracionCompleta() {
  if (!validarDuplicados()) return;

  const btn = event.target;
  const originalText = btn.innerText;
  btn.innerText = "PROCESANDO...";

  // Usamos el operador seguro (?.) para que no crashee si falta un input en el HTML
  const nuevaConfig = {
    id: APP_CONFIG.id,
    nombre:
      document.getElementById("cfg-nombre")?.value ||
      APP_CONFIG.nombre ||
      "Máquina",
    setup: {
      distancia_entre_surcos:
        parseFloat(document.getElementById("cfg-distancia")?.value) || 0.191,
      factor_k_default:
        parseFloat(document.getElementById("cfg-k")?.value) || 0.15,
      p1000: parseFloat(document.getElementById("cfg-p1000")?.value) || 180,
      rpm_min:
        parseFloat(document.getElementById("cfg-rpm-min")?.value) || 2000,
      rpm_max:
        parseFloat(document.getElementById("cfg-rpm-max")?.value) || 5000,
      tolvas: parseInt(document.getElementById("cfg-qty-tolvas")?.value) || 2,
      velocidad_max: 8.5,
      alarma_tiempo_seg: 2,
    },
    mapeo_sensores: workingMapeo,
  };

  try {
    const response = await fetch("/api/config/maquinas/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nuevaConfig),
    });

    if (response.ok) {
      alert("Configuración Guardada Exitosamente.");
      location.reload();
    } else {
      throw new Error("Error en servidor");
    }
  } catch (e) {
    alert("Error de conexión con el backend.");
    btn.innerText = originalText;
  }
}
// --- FUNCIÓN PARA CERRAR EL MODAL ---
function cerrarModal() {
  const modal = document.getElementById("modal-config");
  if (modal) {
    modal.style.display = "none";
  }
}
window.probarSonido = function (rutaSonido) {
  const audioTest = new Audio(rutaSonido);
  // El catch atrapa el error si el archivo mp3 no existe
  audioTest
    .play()
    .catch((e) =>
      console.log("Aviso: Falta cargar el archivo de audio " + rutaSonido),
    );

  const audioPrincipal = document.getElementById("audio-alarma");
  if (audioPrincipal) audioPrincipal.src = rutaSonido;
};
// ==========================================
// AUTO-REGISTRO PARA EL NUEVO MODAL (VISTAX)
// ==========================================
window.prepararNuevoNodo = function (nodoData) {
  console.log("Preparando nuevo nodo en la UI:", nodoData);

  // 1. Abrimos el modal de configuración
  if (typeof abrirModal === "function") abrirModal();

  // 2. Guardamos la tabla actual por si el usuario estaba editando otro nodo
  if (typeof guardarEstadoTablaActual === "function")
    guardarEstadoTablaActual();

  // 3. Verificamos si el nodo ya está en nuestra memoria temporal
  let existe = workingMapeo.some((s) => s.uid === nodoData.uid);

  if (!existe) {
    // Agregamos los cables correspondientes a la memoria temporal
    for (let i = 0; i < nodoData.capacidad_cables; i++) {
      workingMapeo.push({
        uid: nodoData.uid,
        cable: i + 1, // El ESP32 envía cable 1 al 7
        bajada: "", // Lo dejamos vacío para que le asignes el surco
        tipo: "semilla",
        tren: 1,
      });
    }
  }

  // 4. Actualizamos el selector de nodos para que muestre este nuevo ID
  nodoActual = nodoData.uid;
  if (typeof actualizarSelectNodos === "function") {
    actualizarSelectNodos(nodoActual);
  }

  // 5. Nos aseguramos de estar en la pestaña donde se editan los sensores
  if (typeof switchTab === "function") switchTab("general");

  // Mini aviso para el operario
  alert(
    `🚜 ¡Se detectó el nodo ${nodoData.uid}!\nPor favor, asígnale el "Nº de Bajada" a cada cable y haz clic en Guardar Configuración.`,
  );
};

// ══════════════════════════════════════════════════════════
// AGREGAR al final de public/js/config_modal.js
// ══════════════════════════════════════════════════════════

// ── OTA: Abrir modal ──────────────────────────────────────
// ══════════════════════════════════════════════════════════
// REEMPLAZA el bloque OTA en public/js/config_modal.js
// ══════════════════════════════════════════════════════════

// ── Abrir modal ───────────────────────────────────────────
function abrirModalOTA() {
  const overlay = document.getElementById("modal-ota-overlay");
  if (!overlay) return;

  document.getElementById("ota-uid-display").textContent =
    nodoActual || "— sin nodo —";
  document.getElementById("ota-status").style.display = "none";
  document.getElementById("ota-upload-status").textContent = "";
  document.getElementById("btn-enviar-ota").disabled = false;
  document.getElementById("btn-enviar-ota").textContent =
    "⬆ Enviar OTA al nodo";

  overlay.style.display = "flex";
  cargarFirmwares();
}

// ── Cerrar modal ──────────────────────────────────────────
function cerrarModalOTA() {
  const overlay = document.getElementById("modal-ota-overlay");
  if (overlay) overlay.style.display = "none";
}

// ── Cargar lista de firmwares desde el servidor ───────────
async function cargarFirmwares() {
  const select = document.getElementById("ota-firmware-select");
  const infoDiv = document.getElementById("ota-firmware-info");
  select.innerHTML = '<option value="">Cargando...</option>';
  infoDiv.textContent = "";

  try {
    const res = await fetch("/api/firmware");
    const data = await res.json();

    if (!data.ok || data.firmwares.length === 0) {
      select.innerHTML =
        '<option value="">— Sin firmwares disponibles —</option>';
      infoDiv.textContent = "Subí un archivo VX-*.bin para habilitar el envío.";
      infoDiv.style.color = "#555";
      return;
    }

    select.innerHTML = data.firmwares
      .map((f) => {
        const kb = (f.size / 1024).toFixed(1);
        const date = new Date(f.fecha).toLocaleDateString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
        return `<option value="${f.filename}" data-version="${f.version}" data-size="${kb}" data-date="${date}">
        VX-${f.version}.bin — ${kb} KB
      </option>`;
      })
      .join("");

    // Mostrar info del primer item
    actualizarInfoFirmware();

    select.onchange = actualizarInfoFirmware;
  } catch (e) {
    select.innerHTML = '<option value="">Error cargando lista</option>';
    infoDiv.textContent = "No se pudo conectar con el servidor.";
    infoDiv.style.color = "#ff1744";
  }
}

// ── Info del firmware seleccionado ────────────────────────
function actualizarInfoFirmware() {
  const select = document.getElementById("ota-firmware-select");
  const infoDiv = document.getElementById("ota-firmware-info");
  const opt = select.options[select.selectedIndex];
  if (!opt?.value) {
    infoDiv.textContent = "";
    return;
  }

  infoDiv.textContent = `Versión: ${opt.dataset.version}  ·  Tamaño: ${opt.dataset.size} KB  ·  Subido: ${opt.dataset.date}`;
  infoDiv.style.color = "#666";
}

// ── Drag & drop ───────────────────────────────────────────
function handleFirmwareDrop(event) {
  event.preventDefault();
  const dropzone = document.getElementById("ota-dropzone");
  dropzone.style.borderColor = "#333";
  dropzone.style.background = "transparent";

  const file = event.dataTransfer.files[0];
  if (file) subirFirmware(file);
}

// ── Subir firmware al servidor ────────────────────────────
async function subirFirmware(file) {
  if (!file) return;

  const statusDiv = document.getElementById("ota-upload-status");
  const progressWrap = document.getElementById("ota-progress-bar-wrap");
  const progressBar = document.getElementById("ota-progress-bar");

  // Validar en cliente
  if (!file.name.endsWith(".bin")) {
    statusDiv.textContent = "❌ Solo se aceptan archivos .bin";
    statusDiv.style.color = "#ff1744";
    return;
  }
  if (!file.name.startsWith("VX-")) {
    statusDiv.textContent =
      "❌ El nombre debe comenzar con VX- (ej: VX-1.2.0.bin)";
    statusDiv.style.color = "#ff1744";
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    statusDiv.textContent = "❌ Archivo muy grande (máx 4MB)";
    statusDiv.style.color = "#ff1744";
    return;
  }

  // Subida con progreso via XHR (fetch no tiene progress nativo)
  statusDiv.textContent = `Subiendo ${file.name}...`;
  statusDiv.style.color = "#ffea00";
  progressWrap.style.display = "block";
  progressBar.style.width = "0%";

  const formData = new FormData();
  formData.append("firmware", file);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = pct + "%";
      }
    };

    xhr.onload = async () => {
      progressWrap.style.display = "none";
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.ok) {
          statusDiv.textContent = `✅ ${data.filename} subido correctamente`;
          statusDiv.style.color = "#00e676";
          await cargarFirmwares();
          // Seleccionar automáticamente el recién subido
          const select = document.getElementById("ota-firmware-select");
          for (const opt of select.options) {
            if (opt.value === data.filename) {
              select.value = data.filename;
              break;
            }
          }
          actualizarInfoFirmware();
        } else {
          statusDiv.textContent = `❌ ${data.error}`;
          statusDiv.style.color = "#ff1744";
        }
      } catch {
        statusDiv.textContent = "❌ Error inesperado del servidor";
        statusDiv.style.color = "#ff1744";
      }
      resolve();
    };

    xhr.onerror = () => {
      progressWrap.style.display = "none";
      statusDiv.textContent = "❌ Error de red al subir el archivo";
      statusDiv.style.color = "#ff1744";
      resolve();
    };

    xhr.open("POST", "/api/firmware/upload");
    xhr.send(formData);
  });
}

// ── Eliminar firmware seleccionado ────────────────────────
async function eliminarFirmwareSeleccionado() {
  const select = document.getElementById("ota-firmware-select");
  const filename = select.value;
  if (!filename) return;

  if (!confirm(`¿Eliminar ${filename} del servidor?`)) return;

  try {
    const res = await fetch(`/api/firmware/${filename}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      await cargarFirmwares();
    } else {
      alert("Error al eliminar: " + data.error);
    }
  } catch (e) {
    alert("Error de red: " + e.message);
  }
}

// ── Enviar comando OTA al nodo por MQTT ───────────────────
async function enviarComandoOTA() {
  const uid = nodoActual;
  const filename = document.getElementById("ota-firmware-select").value;
  const btn = document.getElementById("btn-enviar-ota");

  if (!uid) {
    _otaStatus("error", "⚠ Seleccioná un nodo antes de enviar.");
    return;
  }
  if (!filename) {
    _otaStatus("error", "⚠ Seleccioná o subí un firmware primero.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Enviando...";
  _otaStatus("info", "📡 Publicando comando en el broker MQTT...");

  try {
    const res = await fetch("/api/config/nodos/comando-ota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, filename }),
    });
    const data = await res.json();

    if (data.ok) {
      _otaStatus(
        "ok",
        `✅ Comando enviado al nodo ${uid}\n` +
          `Versión: ${data.version}\n` +
          `El nodo se va a reiniciar en ~30 seg.`,
      );
      btn.textContent = "✅ Enviado";
      setTimeout(cerrarModalOTA, 4000);
    } else {
      _otaStatus("error", `❌ ${data.error}`);
      btn.disabled = false;
      btn.textContent = "⬆ Enviar OTA al nodo";
    }
  } catch (e) {
    _otaStatus("error", `❌ Error de red: ${e.message}`);
    btn.disabled = false;
    btn.textContent = "⬆ Enviar OTA al nodo";
  }
}

// ── Helper status ─────────────────────────────────────────
function _otaStatus(tipo, msg) {
  const el = document.getElementById("ota-status");
  if (!el) return;
  const estilos = {
    ok: "background:rgba(0,230,118,0.08);border:1px solid #00e676;color:#00e676",
    error:
      "background:rgba(255,23,68,0.08);border:1px solid #ff1744;color:#ff1744",
    info: "background:rgba(255,234,0,0.06);border:1px solid rgba(255,234,0,0.3);color:#ffea00",
  };
  el.style.cssText = `display:block;padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:14px;text-align:center;white-space:pre-line;line-height:1.6;${estilos[tipo]}`;
  el.textContent = msg;
}

// ── Escape para cerrar ────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const overlay = document.getElementById("modal-ota-overlay");
    if (overlay?.style.display === "flex") cerrarModalOTA();
  }
});
