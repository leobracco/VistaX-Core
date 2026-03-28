// ============================================================
// VistaX — config_modal.js  v5
//
// CAMBIOS v5:
//   1. Checkbox is_active en tabla (soft-delete, nunca se borra)
//   2. N trenes dinámico (select genera opciones 1..max)
//   3. Campo objetivo de densidad por tren en pestaña General
//   4. Nombres automáticos por tipo (Semilla 1, Tolva 1, RPM 1...)
// ============================================================

let workingMapeo = [];
let nodoActual = "";

const ETIQUETAS = {
  semilla: "Semilla", ferti_linea: "Ferti L", ferti_costado: "Ferti C",
  turbina: "RPM", rotacion_eje: "Eje", tolva_vacia: "Tolva",
  bajada_herramienta: "Trabajo", bateria: "Batería",
};

function _generarNombresAutomaticos() {
  const porTipo = {};
  workingMapeo.forEach(s => {
    if (!porTipo[s.tipo]) porTipo[s.tipo] = [];
    porTipo[s.tipo].push(s);
  });
  Object.keys(porTipo).forEach(tipo => {
    const grupo = porTipo[tipo].sort((a, b) => (a.bajada || 0) - (b.bajada || 0));
    const prefijo = ETIQUETAS[tipo] || tipo;
    grupo.forEach((sensor, idx) => { sensor.nombre = `${prefijo} ${idx + 1}`; });
  });
}

/**
 * Detecta cuántos trenes existen en el workingMapeo.
 * Retorna un array ordenado [1, 2, ...N]
 */
function _trenesExistentes() {
  const trenes = new Set(workingMapeo.map(s => s.tren || 1));
  return [...trenes].sort((a, b) => a - b);
}

/**
 * Genera las opciones del select de tren dinámicamente.
 * Siempre incluye los que ya existen + opción de "Nuevo tren".
 */
function _opcionesTren(trenSeleccionado) {
  const existentes = _trenesExistentes();
  const maxTren = existentes.length > 0 ? Math.max(...existentes) : 1;
  // Ofrecer hasta maxTren + 1 para poder crear uno nuevo
  const opciones = [];
  for (let i = 1; i <= Math.max(maxTren + 1, 2); i++) {
    const sel = (trenSeleccionado || 1) == i ? 'selected' : '';
    const label = i <= 2
      ? `Tren ${i} (${i === 1 ? 'Delantero' : 'Trasero'})`
      : `Tren ${i}`;
    opciones.push(`<option value="${i}" ${sel}>${label}</option>`);
  }
  return opciones.join('');
}

// --- INICIALIZACIÓN ---
function abrirModal() {
  const modal = document.getElementById("modal-config");
  if (!modal) return;
  modal.style.display = "flex";

  const sv = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

  sv("cfg-nombre", APP_CONFIG.nombre || "Máquina Sin Nombre");
  sv("cfg-distancia", APP_CONFIG.setup?.distancia_entre_surcos || 0.191);
  sv("cfg-k", APP_CONFIG.setup?.factor_k_default || 0.15);
  sv("cfg-p1000", APP_CONFIG.setup?.p1000 || 180);
  sv("cfg-rpm-min", APP_CONFIG.setup?.rpm_min || 2000);
  sv("cfg-rpm-max", APP_CONFIG.setup?.rpm_max || 5000);
  sv("cfg-qty-tolvas", APP_CONFIG.setup?.tolvas || 2);
  sv("cfg-tolerancia-desvio", APP_CONFIG.setup?.tolerancia_desvio || 20);

  const txtId = document.getElementById("cfg-id-maquina");
  if (txtId) txtId.innerText = `ID: ${APP_CONFIG.id || "N/A"}`;

  workingMapeo = JSON.parse(JSON.stringify(APP_CONFIG.mapeo_sensores || []));

  // Renderizar campos de objetivo por tren
  _renderizarObjetivosTren();

  actualizarSelectNodos();
  switchTab("general");
}

/**
 * Genera inputs de "Objetivo Tren N" dinámicamente
 */
function _renderizarObjetivosTren() {
  const container = document.getElementById("cfg-objetivos-trenes");
  if (!container) return;
  container.innerHTML = "";

  const trenes = _trenesExistentes();
  const objetivoGlobal = APP_CONFIG?.setup?.densidad_objetivo || 16;
  const objetivosPorTren = APP_CONFIG?.setup?.objetivos_tren || {};

  trenes.forEach(numTren => {
    const val = objetivosPorTren[numTren] !== undefined ? objetivosPorTren[numTren] : objetivoGlobal;
    const div = document.createElement("div");
    div.className = "input-card";
    div.innerHTML = `
      <label>Objetivo Tren ${numTren} (s/m)</label>
      <input type="number" class="cfg-obj-tren" data-tren="${numTren}" value="${val}" step="0.1" min="0">
    `;
    container.appendChild(div);
  });
}

// --- NODOS ---
function actualizarSelectNodos(nodoForzado = null) {
  const select = document.getElementById("select-nodo-filter");
  if (!select) return;
  let nodos = [...new Set(workingMapeo.map(s => s.uid))];
  if (nodos.length === 0) nodos.push("VX-A1");
  select.innerHTML = "";
  nodos.sort().forEach(n => { select.innerHTML += `<option value="${n}">${n}</option>`; });
  nodoActual = nodoForzado || nodos[0];
  select.value = nodoActual;
  renderizarTablaNodo(nodoActual);
}

function guardarEstadoTablaActual() {
  if (!nodoActual) return;
  workingMapeo = workingMapeo.filter(s => s.uid !== nodoActual);
  const filas = document.querySelectorAll("#lista-sensores-tbody tr.sensor-row");
  filas.forEach(fila => {
    const bajada = parseInt(fila.querySelector(".edit-bajada").value);
    const tipo = fila.querySelector(".edit-tipo").value;
    const isActive = fila.querySelector(".edit-active")?.checked !== false;
    workingMapeo.push({
      uid: nodoActual,
      cable: parseInt(fila.querySelector(".edit-cable").value),
      bajada: bajada,
      tipo: tipo,
      nombre: "",
      tren: parseInt(fila.querySelector(".edit-tren").value),
      is_active: isActive,
    });
  });
}

function cambiarNodo() {
  guardarEstadoTablaActual();
  nodoActual = document.getElementById("select-nodo-filter").value;
  renderizarTablaNodo(nodoActual);
}

function agregarNuevoNodo() {
  guardarEstadoTablaActual();
  const nuevo = prompt("Identificador del nuevo nodo (Ej: VX-B2):");
  if (nuevo && nuevo.trim() !== "") {
    nodoActual = nuevo.trim().toUpperCase();
    workingMapeo.push({ uid: nodoActual, cable: 1, bajada: 1, tipo: "semilla", tren: 1, is_active: true });
    actualizarSelectNodos(nodoActual);
  }
}

// --- TABLA ---
function renderizarTablaNodo(uid) {
  const tbody = document.getElementById("lista-sensores-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const sensoresNodo = workingMapeo.filter(s => s.uid === uid);
  sensoresNodo.sort((a, b) => a.cable - b.cable).forEach(sensor => agregarFilaSensor(sensor));
}

function agregarFilaSensor(datos = null) {
  if (!datos) datos = { uid: nodoActual, cable: 1, bajada: 1, tipo: "semilla", tren: 1, is_active: true };

  const tbody = document.getElementById("lista-sensores-tbody");
  const row = document.createElement("tr");
  row.className = "sensor-row";

  // Estilo visual si está inactivo
  if (datos.is_active === false) row.style.opacity = "0.35";

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
    .map(opt => `<option value="${opt.val}" ${datos.tipo === opt.val ? "selected" : ""}>${opt.label}</option>`)
    .join("");

  const isActive = datos.is_active !== false;

  row.innerHTML = `
    <td><input type="number" class="edit-cable" value="${datos.cable}" min="1" max="7"></td>
    <td><input type="number" class="edit-bajada" value="${datos.bajada}"></td>
    <td><select class="edit-tren">${_opcionesTren(datos.tren)}</select></td>
    <td><select class="edit-tipo">${selectHTML}</select></td>
    <td style="text-align:center">
      <input type="checkbox" class="edit-active" ${isActive ? 'checked' : ''}
             title="${isActive ? 'Activo — click para desactivar (soft-delete)' : 'Inactivo — click para reactivar'}"
             onchange="this.closest('tr').style.opacity = this.checked ? '1' : '0.35'">
    </td>
  `;
  tbody.appendChild(row);
}

// --- TABS ---
window.switchTab = function (tabId) {
  if (tabId === "mapeo") guardarEstadoTablaActual();
  document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  const target = document.getElementById(`tab-${tabId}`);
  if (target) {
    target.style.display = "block";
    const btn = document.querySelector(`button[onclick="switchTab('${tabId}')"]`);
    if (btn) btn.classList.add("active");
  }
  if (tabId === "mapeo") dibujarPlanta();
};

function dibujarPlanta() {
  const canvas = document.getElementById("mapeo-visual-canvas");
  if (!canvas) return;
  canvas.innerHTML = "";
  _generarNombresAutomaticos();

  const grupos = {};
  const tiposEspeciales = ["turbina", "rotacion_eje", "tolva_vacia", "bajada_herramienta", "bateria"];

  workingMapeo.forEach(s => {
    if (s.is_active === false) return; // No dibujar inactivos
    if (tiposEspeciales.includes(s.tipo)) {
      if (!grupos.especiales) grupos.especiales = [];
      grupos.especiales.push(s);
    } else {
      const t = `tren${s.tren || 1}`;
      if (!grupos[t]) grupos[t] = [];
      grupos[t].push(s);
    }
  });

  // Trenes en orden ascendente
  const trenesKeys = Object.keys(grupos).filter(k => k.startsWith('tren')).sort();
  trenesKeys.forEach(tKey => {
    const row = document.createElement("div");
    row.className = "mapeo-tren-row";
    row.innerHTML = `<small>${tKey.toUpperCase().replace('TREN', 'TREN ')}</small>`;
    const grid = document.createElement("div");
    grid.style.cssText = "display:flex;gap:4px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:10px;justify-content:center";

    const bajadas = {};
    grupos[tKey].forEach(s => { if (!bajadas[s.bajada]) bajadas[s.bajada] = []; bajadas[s.bajada].push(s); });

    Object.keys(bajadas).sort((a, b) => parseInt(a) - parseInt(b)).forEach(numBajada => {
      const col = document.createElement("div");
      col.className = "surco-column"; col.style.flexShrink = "0";
      let pillsHTML = "";
      bajadas[numBajada].forEach(sensor => {
        pillsHTML += `<div class="pill-status status-tapado" title="${sensor.nombre}" style="border-color:#555"></div>`;
      });
      const primerSensor = bajadas[numBajada][0];
      col.innerHTML = `<div class="surco-id" title="${primerSensor.nombre}">${numBajada}</div><div class="pills-area">${pillsHTML}</div>`;
      grid.appendChild(col);
    });
    row.appendChild(grid);
    canvas.appendChild(row);
  });

  if (grupos.especiales && grupos.especiales.length > 0) {
    const espRow = document.createElement("div");
    espRow.className = "mapeo-tren-row";
    espRow.innerHTML = `<small>SENSORES DE ESTADO</small>`;
    const grid = document.createElement("div");
    grid.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center";
    const ICONOS = { rotacion_eje: "fas fa-cogs", turbina: "fas fa-fan", bajada_herramienta: "fas fa-arrow-down", bateria: "fas fa-car-battery", tolva_vacia: "fas fa-archive" };
    grupos.especiales.sort((a, b) => a.bajada - b.bajada).forEach(e => {
      const box = document.createElement("div");
      box.className = "sensor-especial"; box.style.borderColor = "#444";
      box.innerHTML = `<i class="${ICONOS[e.tipo] || 'fas fa-microchip'}" style="color:#666"></i><div class="info"><span style="color:#888">${e.nombre}</span><strong style="color:#aaa">#${e.bajada}</strong></div>`;
      grid.appendChild(box);
    });
    espRow.appendChild(grid);
    canvas.appendChild(espRow);
  }
}

// --- VALIDACIÓN Y GUARDADO ---
function validarDuplicados() {
  guardarEstadoTablaActual();
  let vistos = new Set();
  for (let i = 0; i < workingMapeo.length; i++) {
    let s = workingMapeo[i];
    if (s.is_active === false) continue; // Inactivos no cuentan como duplicado
    let clave = `${s.tipo}-${s.bajada}`;
    if (vistos.has(clave)) {
      alert(`⚠️ ERROR: Duplicado "${s.tipo}" en bajada ${s.bajada}.`);
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

  _generarNombresAutomaticos();

  // Leer objetivos por tren
  const objetivosPorTren = {};
  document.querySelectorAll('.cfg-obj-tren').forEach(inp => {
    const t = inp.dataset.tren;
    objetivosPorTren[t] = parseFloat(inp.value) || 16;
  });

  const nuevaConfig = {
    id: APP_CONFIG.id,
    nombre: document.getElementById("cfg-nombre")?.value || APP_CONFIG.nombre || "Máquina",
    setup: {
      distancia_entre_surcos: parseFloat(document.getElementById("cfg-distancia")?.value) || 0.191,
      factor_k_default: parseFloat(document.getElementById("cfg-k")?.value) || 0.15,
      p1000: parseFloat(document.getElementById("cfg-p1000")?.value) || 180,
      densidad_objetivo: parseFloat(document.getElementById("input-objetivo")?.value) || 16,
      objetivos_tren: objetivosPorTren,
      tolerancia_desvio: parseFloat(document.getElementById("cfg-tolerancia-desvio")?.value) || 20,
      rpm_min: parseFloat(document.getElementById("cfg-rpm-min")?.value) || 2000,
      rpm_max: parseFloat(document.getElementById("cfg-rpm-max")?.value) || 5000,
      tolvas: parseInt(document.getElementById("cfg-qty-tolvas")?.value) || 2,
      velocidad_max: 8.5,
      alarma_tiempo_seg: 2,
    },
    mapeo_sensores: workingMapeo,
  };

  try {
    const response = await fetch("/api/config/maquinas/guardar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nuevaConfig),
    });
    if (response.ok) { alert("Configuración Guardada."); location.reload(); }
    else throw new Error("Error en servidor");
  } catch (e) {
    alert("Error de conexión."); btn.innerText = originalText;
  }
}

function cerrarModal() {
  const modal = document.getElementById("modal-config");
  if (modal) modal.style.display = "none";
}

window.probarSonido = function (rutaSonido) {
  const audioTest = new Audio(rutaSonido);
  audioTest.play().catch(() => {});
  const audioPrincipal = document.getElementById("audio-alarma");
  if (audioPrincipal) audioPrincipal.src = rutaSonido;
};

window.prepararNuevoNodo = function (nodoData) {
  if (typeof abrirModal === "function") abrirModal();
  if (typeof guardarEstadoTablaActual === "function") guardarEstadoTablaActual();
  let existe = workingMapeo.some(s => s.uid === nodoData.uid);
  if (!existe) {
    for (let i = 0; i < nodoData.capacidad_cables; i++) {
      workingMapeo.push({ uid: nodoData.uid, cable: i + 1, bajada: "", tipo: "semilla", tren: 1, is_active: true });
    }
  }
  nodoActual = nodoData.uid;
  if (typeof actualizarSelectNodos === "function") actualizarSelectNodos(nodoActual);
  if (typeof switchTab === "function") switchTab("general");
  alert(`🚜 ¡Nodo ${nodoData.uid} detectado!\nAsigná cada cable y guardá.`);
};
