// config_modal.js — v2.8 (Select dinámico de bajadas por tipo + Nodos desde Backend)
let workingMapeo = [];
let nodoActual = "";

// --- 1. INICIALIZACIÓN Y CARGA ---
async function abrirModal() {
  const modal = document.getElementById("modal-config");
  if (!modal) return;
  modal.style.display = "flex";

  console.log("[Config Modal v2.8] Abriendo modal...");

  // Obtener ID de máquina desde APP_CONFIG o elemento del DOM
  const maquinaId = APP_CONFIG?.id || document.querySelector("[data-maquina-id]")?.dataset.maquinaId;
  
  if (!maquinaId) {
    console.error("[Config Modal] No se encontró ID de máquina");
    alert("⚠️ Error: No se pudo identificar la máquina.");
    return;
  }

  console.log(`[Config Modal] Cargando configuración para: ${maquinaId}`);

  try {
    // FETCH FRESCO desde backend (no usar stale APP_CONFIG)
    const response = await fetch(`/api/config/maquinas/${maquinaId}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const configFresca = await response.json();
    console.log("[Config Modal] Config cargada del backend:", configFresca);

    // Usar config fresca, fallback a APP_CONFIG si falla
    const config = configFresca || APP_CONFIG || {};

    // Helper para asignar valores
    const setValueIfExists = (id, value) => {
      const el = document.getElementById(id);
      if (el) {
        el.value = value;
        console.log(`[Config Modal] Set ${id} = ${value}`);
      } else {
        console.warn(`[Config Modal] Elemento no encontrado: ${id}`);
      }
    };

    // GENERAL TAB
    setValueIfExists("cfg-nombre", config.nombre || "Máquina Sin Nombre");
    setValueIfExists("cfg-distancia", config.setup?.distancia_entre_surcos || 0.191);
    setValueIfExists("cfg-k", config.setup?.factor_k_default || 0.15);
    setValueIfExists("cfg-p1000", config.setup?.p1000 || 180);
    setValueIfExists("cfg-rpm-min", config.setup?.rpm_min || 2000);
    setValueIfExists("cfg-rpm-max", config.setup?.rpm_max || 5000);
    setValueIfExists("cfg-tolerancia", config.setup?.tolerancia_porcentaje || 20);

    // TRENES Y SENSORES
    setValueIfExists("cfg-qty-trenes", config.setup?.qty_trenes || 2);
    setValueIfExists("cfg-qty-surcos", config.setup?.qty_surcos || 0);
    setValueIfExists("cfg-qty-semilla", config.setup?.qty_semilla || 0);
    setValueIfExists("cfg-qty-ferti-linea", config.setup?.qty_ferti_linea || 0);
    setValueIfExists("cfg-qty-ferti-costado", config.setup?.qty_ferti_costado || 0);
    setValueIfExists("cfg-qty-rpm", config.setup?.qty_rpm || 0);
    setValueIfExists("cfg-qty-rotacion", config.setup?.qty_rotacion || 0);
    setValueIfExists("cfg-qty-tolvas", config.setup?.tolvas || 0);
    setValueIfExists("cfg-qty-baterias", config.setup?.qty_baterias || 0);
    setValueIfExists("cfg-qty-trabajo", config.setup?.qty_trabajo || 0);

    // DENSIDAD POR TREN (si existen)
    if (config.setup?.densidad_t1) {
      setValueIfExists("cfg-densidad-t1", config.setup.densidad_t1);
    }
    if (config.setup?.densidad_t2) {
      setValueIfExists("cfg-densidad-t2", config.setup.densidad_t2);
    }

    // ID MÁQUINA
    const txtId = document.getElementById("cfg-id-maquina");
    if (txtId) {
      txtId.innerText = `ID: ${config.id || "N/A"}`;
      console.log(`[Config Modal] ID Máquina: ${config.id}`);
    }

    // MAPEO SENSORES - CARGA CRÍTICA
    console.log("[Config Modal] Mapeo sensores en config:", config.mapeo_sensores?.length || 0);
    workingMapeo = JSON.parse(JSON.stringify(config.mapeo_sensores || []));
    
    if (workingMapeo.length === 0) {
      console.warn("[Config Modal] ⚠️ No hay mapeo de sensores. Máquina nueva o sin configuración.");
    } else {
      console.log(`[Config Modal] ✓ Cargados ${workingMapeo.length} sensores`);
      console.log(workingMapeo.slice(0, 3)); // Log primeros 3 para debug
    }

    // ACTUALIZAR SELECTORES — AHORA DESDE BACKEND
    await actualizarSelectNodos();
    
    // IR A PESTAÑA GENERAL
    switchTab("general");

    console.log("[Config Modal] ✓ Modal iniciado exitosamente");

  } catch (error) {
    console.error("[Config Modal] Error al cargar config:", error);
    alert(`⚠️ Error al cargar configuración:\n${error.message}\n\nUsando datos en cache...`);
    
    // FALLBACK: usar APP_CONFIG local (aunque esté stale)
    const setValueIfExists = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };

    setValueIfExists("cfg-nombre", APP_CONFIG?.nombre || "Máquina Sin Nombre");
    setValueIfExists("cfg-distancia", APP_CONFIG?.setup?.distancia_entre_surcos || 0.191);
    
    workingMapeo = JSON.parse(JSON.stringify(APP_CONFIG?.mapeo_sensores || []));
    await actualizarSelectNodos();
    switchTab("general");
  }
}

// --- 2. LÓGICA DE NODOS (SELECTOR) — NUEVA VERSIÓN CON BACKEND ---
async function actualizarSelectNodos(nodoForzado = null) {
  const select = document.getElementById("select-nodo-filter");
  if (!select) {
    console.error("[Config Modal] Select de nodos no encontrado");
    return;
  }

  console.log(`[Nodos] Iniciando carga desde backend...`);

  try {
    // ▶ NUEVA: Obtener nodos del BACKEND
    const respNodos = await fetch("/api/nodos");
    if (!respNodos.ok) {
      console.warn("[Nodos] ⚠️ GET /api/nodos devolvió error, usando fallback");
      actualizarSelectNodosLocal(select, nodoForzado);
      return;
    }

    const dataNodos = await respNodos.json();
    const nodosBackend = dataNodos.nodos || [];

    console.log(`[Nodos] Backend devolvió ${nodosBackend.length} nodos`);

    if (nodosBackend.length === 0) {
      console.warn("[Nodos] ⚠️ Inventario vacío, usando fallback");
      actualizarSelectNodosLocal(select, nodoForzado);
      return;
    }

    // ▶ Combinar: nodos del backend + UIDs ya asignados en workingMapeo
    const workingMapeo_copy = workingMapeo || [];
    const uidsEnMapeo = new Set(
      workingMapeo_copy.filter(m => m.uid).map(m => m.uid.trim())
    );

    console.log(`[Nodos] UIDs en mapeo actual: ${uidsEnMapeo.size}`);

    // Ordenar: primero los asignados, luego los no asignados
    const nodosOrdenados = [
      ...nodosBackend.filter(n => uidsEnMapeo.has(n.uid)),
      ...nodosBackend.filter(n => !uidsEnMapeo.has(n.uid))
    ];

    // ▶ Llenar el SELECT
    select.innerHTML = "";
    nodosOrdenados.forEach(nodo => {
      const opcion = document.createElement("option");
      const asignado = uidsEnMapeo.has(nodo.uid) ? " ✓" : "";
      const estado = nodo.online ? "🟢" : "🟡";
      const label = `${estado} ${nodo.uid}${asignado}`;

      opcion.value = nodo.uid;
      opcion.textContent = label;
      opcion.dataset.alias = nodo.alias || "";
      opcion.dataset.estado = nodo.estado || "desconocido";

      if (uidsEnMapeo.has(nodo.uid)) {
        opcion.style.fontWeight = "bold";
      }

      select.appendChild(opcion);
    });

    // ▶ Seleccionar nodo
    nodoActual = nodoForzado || nodosOrdenados[0]?.uid || "VX-A1";
    select.value = nodoActual;

    console.log(`[Nodos] ✓ SELECT actualizado con ${nodosOrdenados.length} nodos`);
    console.log(`[Nodos] ✓ Nodo actual: ${nodoActual}`);

    renderizarTablaNodo(nodoActual);

  } catch (e) {
    console.error("[Nodos] ❌ Error:", e.message);
    actualizarSelectNodosLocal(select, nodoForzado);
  }
}

// Fallback: si el backend falla, usar solo workingMapeo
function actualizarSelectNodosLocal(select, nodoForzado = null) {
  console.log(`[Nodos] Usando fallback: extrayendo de workingMapeo`);

  const workingMapeo_copy = workingMapeo || [];
  let nodos = [...new Set(
    workingMapeo_copy
      .filter(m => m && m.uid)
      .map(m => m.uid.trim())
  )];

  console.log(`[Nodos] UIDs únicos encontrados: ${nodos.length}`, nodos);

  if (nodos.length === 0) {
    console.warn("[Nodos] ⚠️ Sin nodos. Agregando VX-A1 por defecto");
    nodos.push("VX-A1");
  }

  select.innerHTML = "";
  nodos.sort().forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    select.appendChild(opt);
  });

  nodoActual = nodoForzado || nodos[0];
  select.value = nodoActual;

  console.log(`[Nodos] ✓ Nodo actual: ${nodoActual}`);

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
      tren: parseInt(fila.querySelector(".edit-tren").value),
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
      bajada: "",
      tipo: "semilla",
      tren: 1,
    }); // Crea un cable inicial
    actualizarSelectNodos(nodoActual);
  }
}

// --- 3. DIBUJAR LA TABLA (SOLO EL NODO SELECCIONADO) ---
function renderizarTablaNodo(uid, inicializarSiVacio = false) {
  const tbody = document.getElementById("lista-sensores-tbody");
  if (!tbody) return;
  tbody.innerHTML = ""; // Vaciamos la tabla por completo

  // Filtramos para que SOLO aparezcan los de este nodo
  const sensoresNodo = workingMapeo.filter((s) => s.uid === uid);

  if (sensoresNodo.length === 0 && !inicializarSiVacio) return;

  sensoresNodo
    .sort((a, b) => a.cable - b.cable)
    .forEach((sensor) => {
      agregarFilaSensor(sensor);
    });

  // Refrescamos todos los selects después de pintar toda la tabla
  refrescarTodosSelectsBajada();
}

// ==========================================================
// --- HELPERS PARA EL SELECT DINÁMICO DE BAJADAS ---
// ==========================================================

// Devuelve cuántas bajadas tiene un tipo según los campos de General
function _getQtyParaTipo(tipo) {
  const MAPA = {
    semilla:            parseInt(document.getElementById("cfg-qty-semilla")?.value)        || 0,
    ferti_linea:        parseInt(document.getElementById("cfg-qty-ferti-linea")?.value)    || 0,
    ferti_costado:      parseInt(document.getElementById("cfg-qty-ferti-costado")?.value)  || 0,
    turbina:            parseInt(document.getElementById("cfg-qty-rpm")?.value)            || 0,
    rotacion_eje:       parseInt(document.getElementById("cfg-qty-rotacion")?.value)       || 0,
    tolva_vacia:        parseInt(document.getElementById("cfg-qty-tolvas")?.value)         || 0,
    bateria:            parseInt(document.getElementById("cfg-qty-baterias")?.value)       || 0,
    bajada_herramienta: parseInt(document.getElementById("cfg-qty-trabajo")?.value)        || 0,
  };
  return MAPA[tipo] || 0;
}

// Puebla un <select class="edit-bajada"> con los números disponibles para ese tipo.
// Los duplicados dentro del mismo tipo quedan excluidos, EXCEPTO el valor actual de este select.
// Dos tipos distintos (ej: semilla + ferti_linea) SÍ pueden compartir el mismo número de bajada.
function _poblarSelectBajada(selectEl, tipo, valorActual) {
  const qty = _getQtyParaTipo(tipo);
  const valNum = parseInt(valorActual) || 0;

  // Recolectamos los ya asignados para ese tipo (excluyendo este mismo select)
  const asignados = new Set();
  document.querySelectorAll("#lista-sensores-tbody tr.sensor-row").forEach((row) => {
    const s = row.querySelector(".edit-bajada");
    const t = row.querySelector(".edit-tipo");
    if (s && t && s !== selectEl && t.value === tipo) {
      const v = parseInt(s.value);
      if (v > 0) asignados.add(v);
    }
  });

  const prevVal = parseInt(selectEl.value) || valNum;
  selectEl.innerHTML = '<option value="">— Sin asignar —</option>';

  if (qty === 0) {
    selectEl.innerHTML =
      '<option value="">⚠ Configura la cantidad en General</option>';
    return;
  }

  for (let i = 1; i <= qty; i++) {
    // Mostramos si no está asignado a otra fila, O si es el valor que ya tenía este select
    if (!asignados.has(i) || i === prevVal) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i;
      if (i === prevVal) opt.selected = true;
      selectEl.appendChild(opt);
    }
  }
}

// Refresca todos los selects de bajada de la tabla activa.
// Llamar tras cualquier cambio de bajada o de tipo.
function refrescarTodosSelectsBajada() {
  document.querySelectorAll("#lista-sensores-tbody tr.sensor-row").forEach((row) => {
    const selectBajada = row.querySelector(".edit-bajada");
    const selectTipo   = row.querySelector(".edit-tipo");
    if (selectBajada && selectTipo) {
      _poblarSelectBajada(selectBajada, selectTipo.value, selectBajada.value);
    }
  });
}

// Handler para cuando el operario cambia el tipo de sensor en una fila
function _onTipoCambia(selectTipo) {
  const row = selectTipo.closest("tr");
  const selectBajada = row.querySelector(".edit-bajada");
  // Al cambiar tipo, el número anterior probablemente no aplica → reseteamos
  _poblarSelectBajada(selectBajada, selectTipo.value, "");
  // Refrescamos el resto para liberar el número que tenía esta fila
  refrescarTodosSelectsBajada();
}

// --- AGREGAR FILA DE SENSOR ---
function agregarFilaSensor(datos = null) {
  // Valores por defecto si se llama sin argumentos (botón "+ AGREGAR CABLE")
  if (!datos)
    datos = { uid: nodoActual, cable: 1, bajada: "", tipo: "semilla", tren: 1 };

  const tbody = document.getElementById("lista-sensores-tbody");
  const row = document.createElement("tr");
  row.className = "sensor-row";

  const opcionesTipo = [
    { val: "semilla",            label: "Semilla" },
    { val: "ferti_linea",        label: "Ferti Línea" },
    { val: "ferti_costado",      label: "Ferti Costado" },
    { val: "turbina",            label: "RPM Turbina" },
    { val: "rotacion_eje",       label: "Rotación Eje" },
    { val: "tolva_vacia",        label: "Nivel de Tolva" },
    { val: "bajada_herramienta", label: "Sensor de Trabajo" },
    { val: "bateria",            label: "Voltaje Bat." },
  ];

  const selectTipoHTML = opcionesTipo
    .map(
      (opt) =>
        `<option value="${opt.val}" ${datos.tipo === opt.val ? "selected" : ""}>${opt.label}</option>`,
    )
    .join("");

  row.innerHTML = `
        <td><input type="number" class="edit-cable" value="${datos.cable}" min="1" max="7"></td>
        <td>
            <select class="edit-bajada" onchange="refrescarTodosSelectsBajada()">
                <!-- Poblado dinámicamente por _poblarSelectBajada() -->
            </select>
        </td>
        <td>
            <select class="edit-tren">
                <option value="1" ${datos.tren == 1 ? "selected" : ""}>Tren 1 (Delantero)</option>
                <option value="2" ${datos.tren == 2 ? "selected" : ""}>Tren 2 (Trasero)</option>
            </select>
        </td>
        <td><select class="edit-tipo" onchange="_onTipoCambia(this)">${selectTipoHTML}</select></td>
        <td style="text-align:center">
            <button class="btn-delete" onclick="this.parentElement.parentElement.remove(); refrescarTodosSelectsBajada();"><i class="fas fa-trash"></i></button>
        </td>
    `;
  tbody.appendChild(row);

  // Poblamos el select de bajada con las opciones disponibles para este tipo y valor
  _poblarSelectBajada(row.querySelector(".edit-bajada"), datos.tipo, datos.bajada);
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

  console.log("[Mapeo Visual] Dibujando planta con", workingMapeo.length, 'sensores');

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
      const t = `tren${s.tren || 1}`;
      if (!grupos[t]) grupos[t] = [];
      grupos[t].push(s);
    }
  });

  console.log("[Mapeo Visual] Grupos:", grupos);

  // 2. Dibujar Trenes de Siembra
  ["tren1", "tren2"].forEach((tKey) => {
    if (grupos[tKey] && grupos[tKey].length > 0) {
      const row = document.createElement("div");
      row.className = "mapeo-tren-row";
      row.innerHTML = `<small>${tKey.toUpperCase()}</small>`;

      const grid = document.createElement("div");
      grid.style.display = "flex";
      grid.style.gap = "4px";
      grid.style.flexWrap = "nowrap";
      grid.style.overflowX = "auto";
      grid.style.paddingBottom = "10px";
      grid.style.justifyContent = "center";

      // Agrupamos por bajada (por si hay semilla y ferti en el mismo surco)
      const bajadas = {};
      grupos[tKey].forEach((s) => {
        const b = s.bajada || "sin-asignar";
        if (!bajadas[b]) bajadas[b] = [];
        bajadas[b].push(s);
      });

      Object.keys(bajadas)
        .sort((a, b) => {
          const numA = parseInt(a);
          const numB = parseInt(b);
          // Si no son números, ponerlos al final
          if (isNaN(numA)) return 1;
          if (isNaN(numB)) return -1;
          return numA - numB;
        })
        .forEach((numBajada) => {
          const col = document.createElement("div");
          col.className = "surco-column";
          col.style.flexShrink = "0";

          let pillsHTML = "";
          bajadas[numBajada].forEach((sensor) => {
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
      console.log(`[Mapeo Visual] ✓ ${tKey} dibujado con ${grupos[tKey].length} sensores`);
    }
  });

  // 3. Dibujar Sensores Especiales
  if (grupos.especiales.length > 0) {
    const espRow = document.createElement("div");
    espRow.className = "mapeo-tren-row";
    espRow.innerHTML = `<small>SENSORES DE ESTADO</small>`;

    const grid = document.createElement("div");
    grid.style.display = "flex";
    grid.style.gap = "8px";
    grid.style.flexWrap = "wrap";
    grid.style.justifyContent = "center";

    const ICONOS = {
      rotacion_eje:       "fas fa-cogs",
      turbina:            "fas fa-fan",
      bajada_herramienta: "fas fa-arrow-down",
      bateria:            "fas fa-car-battery",
      tolva_vacia:        "fas fa-archive",
    };

    grupos.especiales
      .sort((a, b) => a.bajada - b.bajada)
      .forEach((e) => {
        const box = document.createElement("div");
        box.className = "sensor-especial";
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
      // Cantidades por tipo de sensor (campos nuevos e independientes)
      qty_trenes:        parseInt(document.getElementById("cfg-qty-trenes")?.value)        || 2,
      qty_surcos:        parseInt(document.getElementById("cfg-qty-surcos")?.value)        || 0,
      qty_semilla:       parseInt(document.getElementById("cfg-qty-semilla")?.value)       || 0,
      qty_ferti_linea:   parseInt(document.getElementById("cfg-qty-ferti-linea")?.value)   || 0,
      qty_ferti_costado: parseInt(document.getElementById("cfg-qty-ferti-costado")?.value) || 0,
      qty_rpm:           parseInt(document.getElementById("cfg-qty-rpm")?.value)           || 0,
      qty_rotacion:      parseInt(document.getElementById("cfg-qty-rotacion")?.value)      || 0,
      tolvas:            parseInt(document.getElementById("cfg-qty-tolvas")?.value)        || 0,
      qty_baterias:      parseInt(document.getElementById("cfg-qty-baterias")?.value)      || 0,
      qty_trabajo:       parseInt(document.getElementById("cfg-qty-trabajo")?.value)       || 0,
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
        cable: i + 1,
        bajada: "", // Vacío para que el operario lo asigne
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
  if (typeof switchTab === "function") switchTab("sensores");

  // Mini aviso para el operario
  alert(
    `🚜 ¡Se detectó el nodo ${nodoData.uid}!\nPor favor, asígnale el "Nº de Bajada" a cada cable y haz clic en Guardar Configuración.`,
  );
};
