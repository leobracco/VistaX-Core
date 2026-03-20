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
