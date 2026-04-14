// ============================================================
// VistaX — config_modal.js  v2.5
//
// CAMBIOS v2.5:
//   1. [NEW] Tab Trenes funcional: el usuario define cantidad de trenes
//      y cantidad de surcos por tren. La numeración se calcula automáticamente.
//   2. [FIX] _onTrenCambiado ahora respeta los rangos de los trenes:
//      - Si hay estructura definida, busca huecos dentro del rango del tren.
//      - Si no hay estructura, muestra aviso y no hace nada.
//   3. [FIX] renderizarTablaNodo ya no dispara autonumerado automático.
//      El autonumerado solo ocurre cuando el usuario cambia el selector de Tren.
//   4. [FIX] Pre-carga de cables vacíos solo en acción explícita (cambiarNodo),
//      nunca en renders internos de actualizarSelectNodos.
//
// CAMBIOS v2.4:
//   1. Dropdown de sensores no se refresca por Socket.IO (no pisa edición).
//
// CAMBIOS v5:
//   1. Checkbox is_active en tabla (soft-delete, nunca se borra)
//   2. N trenes dinámico (select genera opciones 1..max)
//   3. Campo objetivo de densidad por tren en pestaña General
//   4. Nombres automáticos por tipo (Semilla 1, Tolva 1, RPM 1...)
// ============================================================

let workingMapeo = [];
let nodoActual = "";
let _estructuraTrenes = null; // {"2": {surcos:20, orden:1, nombre:"Trasero"}, ...}

const ETIQUETAS = {
  semilla: "Semilla",
  ferti_linea: "Ferti L",
  ferti_costado: "Ferti C",
  turbina: "RPM",
  rotacion_eje: "Eje",
  tolva_vacia: "Tolva",
  bajada_herramienta: "Trabajo",
  bateria: "Batería",
};

function _generarNombresAutomaticos() {
  const porTipo = {};
  workingMapeo.forEach((s) => {
    if (!porTipo[s.tipo]) porTipo[s.tipo] = [];
    porTipo[s.tipo].push(s);
  });
  Object.keys(porTipo).forEach((tipo) => {
    const grupo = porTipo[tipo].sort(
      (a, b) => (a.bajada || 0) - (b.bajada || 0),
    );
    const prefijo = ETIQUETAS[tipo] || tipo;
    grupo.forEach((sensor, idx) => {
      sensor.nombre = `${prefijo} ${idx + 1}`;
    });
  });
}

/**
 * Detecta cuántos trenes existen en el workingMapeo.
 * Retorna un array ordenado [1, 2, ...N]
 */
function _trenesExistentes() {
  const trenes = new Set(workingMapeo.map((s) => s.tren || 1));
  return [...trenes].sort((a, b) => a - b);
}

/**
 * Genera las opciones del select de tren dinámicamente.
 * Usa la estructura definida (_estructuraTrenes) si existe,
 * si no cae a los trenes presentes en el workingMapeo.
 */
function _opcionesTren(trenSeleccionado) {
  let trenesDisponibles = [];

  if (_estructuraTrenes && Object.keys(_estructuraTrenes).length > 0) {
    trenesDisponibles = Object.keys(_estructuraTrenes)
      .map((k) => parseInt(k))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b);
  } else {
    const existentes = _trenesExistentes();
    const maxTren = existentes.length > 0 ? Math.max(...existentes) : 1;
    for (let i = 1; i <= Math.max(maxTren + 1, 2); i++) trenesDisponibles.push(i);
  }

  if (trenesDisponibles.length === 0) trenesDisponibles = [1, 2];

  const opciones = trenesDisponibles.map((i) => {
    const sel = (trenSeleccionado || 1) == i ? "selected" : "";
    let label;
    if (_estructuraTrenes && _estructuraTrenes[String(i)]?.nombre) {
      label = `Tren ${i} (${_estructuraTrenes[String(i)].nombre})`;
    } else {
      label = i <= 2 ? `Tren ${i} (${i === 1 ? "Delantero" : "Trasero"})` : `Tren ${i}`;
    }
    return `<option value="${i}" ${sel}>${label}</option>`;
  });

  return opciones.join("");
}

// --- INICIALIZACIÓN ---
function abrirModal() {
  // Si estamos en el Shell → abrir en ventana nueva
  if (window.Shell) {
    window.open("/config", "config", "width=900,height=700");
    return;
  }
  // Navegador normal → overlay
  _mostrarModal();
}

function _mostrarModal() {
  const modal = document.getElementById("modal-config");
  if (!modal) return;
  modal.style.display = "flex";

  const sv = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

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
  _cargarEstructuraTrenes();
  _renderizarObjetivosTren();
  _cargarConfigMonitoreo();
  actualizarSelectNodos();
  switchTab("perfiles");
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

  trenes.forEach((numTren) => {
    const val =
      objetivosPorTren[numTren] !== undefined
        ? objetivosPorTren[numTren]
        : objetivoGlobal;
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
let _nodosInventarioCache = [];

async function actualizarSelectNodos(nodoForzado = null) {
  const select = document.getElementById("select-nodo-filter");
  if (!select) return;

  // 1. UIDs que ya están mapeados en el perfil actual
  const uidsEnPerfil = [...new Set(workingMapeo.map((s) => s.uid))];

  // 2. UIDs del inventario central (nodos vistos por MQTT)
  try {
    const res = await fetch("/api/nodos");
    const data = await res.json();
    if (data.ok) _nodosInventarioCache = data.nodos || [];
  } catch (e) {
    console.warn("[config_modal] No se pudo cargar inventario:", e.message);
  }

  const uidsInventario = _nodosInventarioCache
    .filter((n) => !n.ignorado)
    .map((n) => n.uid);

  // 3. Unir ambos sets
  const todos = [...new Set([...uidsEnPerfil, ...uidsInventario])];
  if (todos.length === 0) todos.push("VX-A1");

  // 4. Pintar el select marcando los que no están en el perfil
  select.innerHTML = "";
  todos.sort().forEach((uid) => {
    const enPerfil = uidsEnPerfil.includes(uid);
    const invNodo = _nodosInventarioCache.find((n) => n.uid === uid);
    const online = invNodo?.online ? "🟢" : invNodo ? "⚪" : "";
    const marca = enPerfil ? "" : " · SIN MAPEAR";
    const label = `${online} ${uid}${marca}`.trim();
    select.innerHTML += `<option value="${uid}">${label}</option>`;
  });

  nodoActual = nodoForzado || todos[0];
  select.value = nodoActual;

  // Render INTERNO: no inicializa cables vacíos para nodos no mapeados.
  // La pre-carga solo ocurre cuando el usuario selecciona un nodo explícitamente
  // en el dropdown (eso dispara cambiarNodo -> renderizarTablaNodo(uid, true)).
  renderizarTablaNodo(nodoActual, false);
}

function guardarEstadoTablaActual() {
  if (!nodoActual) return;
  workingMapeo = workingMapeo.filter((s) => s.uid !== nodoActual);
  const filas = document.querySelectorAll("#lista-sensores-tbody tr.sensor-row");
  filas.forEach((fila) => {
    const bajadaRaw = fila.querySelector(".edit-bajada").value;
    const bajada = bajadaRaw === "" ? "" : parseInt(bajadaRaw);
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

  // Si el usuario selecciona el nodo desde otro tab, traer a Sensores automáticamente
  const target = document.getElementById("tab-sensores");
  if (target && target.style.display === "none") {
    document.querySelectorAll(".tab-content").forEach((t) => (t.style.display = "none"));
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    target.style.display = "block";
    const btn = document.querySelector(`button[onclick="switchTab('sensores')"]`);
    if (btn) btn.classList.add("active");
  }

  // true: es acción explícita del usuario, pre-carga cables vacíos si no hay
  renderizarTablaNodo(nodoActual, true);
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
      tren: 1,
      is_active: true,
    });
    actualizarSelectNodos(nodoActual);
  }
}

// --- TABLA ---
function renderizarTablaNodo(uid, inicializarSiVacio = false) {
  const tbody = document.getElementById("lista-sensores-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  let sensoresNodo = workingMapeo.filter((s) => s.uid === uid);

  // Solo pre-cargamos cables vacíos cuando fue una acción explícita del usuario
  if (sensoresNodo.length === 0 && inicializarSiVacio) {
    const invNodo = _nodosInventarioCache.find((n) => n.uid === uid);
    const capacidad = invNodo?.capacidad_cables || 7;
    for (let i = 1; i <= capacidad; i++) {
      const fila = {
        uid,
        cable: i,
        bajada: "",
        tipo: "semilla",
        tren: 1,
        is_active: true,
      };
      workingMapeo.push(fila);
      sensoresNodo.push(fila);
    }
    console.log(`[config_modal v2.5] Nodo ${uid} pre-cargado con ${capacidad} cables vacíos`);
  }

  sensoresNodo
    .sort((a, b) => a.cable - b.cable)
    .forEach((sensor) => agregarFilaSensor(sensor));
}

function agregarFilaSensor(datos = null) {
  if (!datos)
    datos = {
      uid: nodoActual,
      cable: 1,
      bajada: 1,
      tipo: "semilla",
      tren: 1,
      is_active: true,
    };

  const tbody = document.getElementById("lista-sensores-tbody");
  const row = document.createElement("tr");
  row.className = "sensor-row";

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
    .map(
      (opt) =>
        `<option value="${opt.val}" ${datos.tipo === opt.val ? "selected" : ""}>${opt.label}</option>`,
    )
    .join("");

  const isActive = datos.is_active !== false;

  row.innerHTML = `
    <td><input type="number" class="edit-cable" value="${datos.cable}" min="1" max="7"></td>
    <td><input type="number" class="edit-bajada" value="${datos.bajada}"></td>
    <td><select class="edit-tren" onchange="_onTrenCambiado(this)">${_opcionesTren(datos.tren)}</select></td>
    <td><select class="edit-tipo">${selectHTML}</select></td>
    <td style="text-align:center">
      <input type="checkbox" class="edit-active" ${isActive ? "checked" : ""}
             title="${isActive ? "Activo — click para desactivar (soft-delete)" : "Inactivo — click para reactivar"}"
             onchange="this.closest('tr').style.opacity = this.checked ? '1' : '0.35'">
    </td>
  `;
  tbody.appendChild(row);
}

// ============================================================
// [v2.5] AUTOCOMPLETADO DE NUMERACIÓN DE BAJADAS
// ============================================================

/**
 * Calcula los rangos (inicio-fin) de cada tren, basado en _estructuraTrenes.
 * Misma lógica que profiles_manager.calcularRangosTrenes del backend.
 * Retorna null si no hay estructura definida.
 */
function _calcularRangosTrenes() {
  if (!_estructuraTrenes || Object.keys(_estructuraTrenes).length === 0) {
    return null;
  }

  const trenesArray = Object.keys(_estructuraTrenes)
    .map((id) => {
      const cfg = _estructuraTrenes[id] || {};
      return {
        id: String(id),
        surcos: parseInt(cfg.surcos) || 0,
        orden: parseInt(cfg.orden) || 99,
        nombre: cfg.nombre || `Tren ${id}`,
      };
    })
    .filter((t) => t.surcos > 0)
    .sort((a, b) => a.orden - b.orden);

  if (trenesArray.length === 0) return null;

  const rangos = {};
  let siguiente = 1;
  trenesArray.forEach((t) => {
    rangos[t.id] = {
      inicio: siguiente,
      fin: siguiente + t.surcos - 1,
      surcos: t.surcos,
      orden: t.orden,
      nombre: t.nombre,
    };
    siguiente += t.surcos;
  });

  return { rangos, totalSurcos: siguiente - 1 };
}

/**
 * Se dispara al cambiar el selector de Tren en una fila.
 * Comportamiento:
 *   - Si la fila que cambió ya tiene bajada asignada → no hace nada.
 *   - Si no hay estructura de trenes definida → muestra aviso y no hace nada.
 *   - Si hay estructura → busca huecos libres dentro del rango del tren elegido,
 *     considerando workingMapeo + lo que el usuario tiene tipeado en el DOM.
 *     Asigna los cables del nodo actual a los huecos en orden de cable.
 *   - Respeta filas que ya tengan bajada asignada (edición manual).
 */
window._onTrenCambiado = function (selectEl) {
  const fila = selectEl.closest("tr");
  if (!fila) return;

  const inputBajadaEsta = fila.querySelector(".edit-bajada");
  if (!inputBajadaEsta) return;

  // Si la fila que cambió el tren ya tiene bajada, no autocompleto nada
  if (inputBajadaEsta.value.trim() !== "") return;

  const trenElegido = parseInt(selectEl.value);
  if (isNaN(trenElegido)) return;

  const estructura = _calcularRangosTrenes();

  if (!estructura) {
    _toast(
      "Definí la estructura de trenes en la pestaña 'Trenes' para activar el autonumerado",
      "warn"
    );
    return;
  }

  const rangoTren = estructura.rangos[String(trenElegido)];
  if (!rangoTren) {
    _toast(
      `El Tren ${trenElegido} no está en la estructura definida. Revisá el tab Trenes.`,
      "warn"
    );
    return;
  }

  // 1. Recolectar todas las bajadas ocupadas (workingMapeo + DOM del nodo actual)
  const bajadasOcupadas = new Set();

  workingMapeo.forEach((s) => {
    if (s.is_active === false) return;
    const b = parseInt(s.bajada);
    if (!isNaN(b)) bajadasOcupadas.add(b);
  });

  // Lo que el usuario tiene tipeado EN ESTE MOMENTO en el DOM puede ser más
  // nuevo que el workingMapeo. Leemos el DOM para no perder ediciones no guardadas.
  document.querySelectorAll("#lista-sensores-tbody tr.sensor-row").forEach((f) => {
    const inp = f.querySelector(".edit-bajada");
    const val = inp?.value.trim();
    if (val !== "" && !isNaN(parseInt(val))) {
      bajadasOcupadas.add(parseInt(val));
    }
  });

  // 2. Generar lista de huecos libres dentro del rango del tren elegido
  const huecosLibres = [];
  for (let n = rangoTren.inicio; n <= rangoTren.fin; n++) {
    if (!bajadasOcupadas.has(n)) huecosLibres.push(n);
  }

  if (huecosLibres.length === 0) {
    _toast(
      `Tren ${trenElegido} (${rangoTren.nombre}) está completo. No hay huecos libres.`,
      "warn"
    );
    return;
  }

  // 3. Recorrer las filas del nodo actual en orden de cable y llenar las vacías
  //    del tren elegido con los huecos libres
  const todasLasFilas = Array.from(
    document.querySelectorAll("#lista-sensores-tbody tr.sensor-row")
  ).sort((a, b) => {
    const ca = parseInt(a.querySelector(".edit-cable").value) || 0;
    const cb = parseInt(b.querySelector(".edit-cable").value) || 0;
    return ca - cb;
  });

  let asignadas = 0;
  let huecoIdx = 0;

  todasLasFilas.forEach((f) => {
    const inputBajada = f.querySelector(".edit-bajada");
    const selectTren = f.querySelector(".edit-tren");
    if (!inputBajada || !selectTren) return;

    if (
      inputBajada.value.trim() === "" &&
      parseInt(selectTren.value) === trenElegido &&
      huecoIdx < huecosLibres.length
    ) {
      inputBajada.value = huecosLibres[huecoIdx];
      huecoIdx++;
      asignadas++;
    }
  });

  // Detectar cuántas filas quedaron sin asignar por falta de huecos
  const filasDelTrenSinAsignar = Array.from(
    document.querySelectorAll("#lista-sensores-tbody tr.sensor-row")
  ).filter(
    (f) =>
      f.querySelector(".edit-bajada").value.trim() === "" &&
      parseInt(f.querySelector(".edit-tren").value) === trenElegido
  );
  const sinAsignar = filasDelTrenSinAsignar.length;

  if (asignadas > 0) {
    console.log(
      `[ConfigModal v2.5] Autonumerado ${asignadas} bajada(s) del nodo ${nodoActual} en Tren ${trenElegido} (${rangoTren.nombre}, rango ${rangoTren.inicio}-${rangoTren.fin})`
    );
    if (sinAsignar > 0) {
      _toast(
        `Se asignaron ${asignadas} bajadas. Quedaron ${sinAsignar} cables sin asignar (Tren ${trenElegido} sin huecos suficientes).`,
        "warn"
      );
    } else {
      _toast(`Se asignaron ${asignadas} bajadas en Tren ${trenElegido}`, "ok");
    }
  }
};

// ============================================================
// [v2.5] TAB TRENES — Definición de estructura
// ============================================================

/**
 * Carga la estructura de trenes desde APP_CONFIG al abrir el modal.
 * Si no existe, inicializa vacía (el usuario tiene que definirla).
 */
function _cargarEstructuraTrenes() {
  if (APP_CONFIG?.trenes && typeof APP_CONFIG.trenes === "object") {
    _estructuraTrenes = JSON.parse(JSON.stringify(APP_CONFIG.trenes));
  } else {
    _estructuraTrenes = {};
  }
}

/**
 * Re-renderiza todo el tab Trenes (cantidad + lista + preview + warning).
 * Se llama al entrar al tab y después de cada cambio del usuario.
 */
function _renderizarTabTrenes() {
  const qtyInput = document.getElementById("cfg-qty-trenes");
  const lista = document.getElementById("cfg-trenes-lista");
  const preview = document.getElementById("cfg-trenes-preview");
  const warning = document.getElementById("cfg-trenes-warning");

  if (!qtyInput || !lista || !preview) return;

  if (!_estructuraTrenes) _estructuraTrenes = {};

  // Si no hay trenes definidos, crear uno por default para arrancar
  if (Object.keys(_estructuraTrenes).length === 0) {
    _estructuraTrenes["1"] = { surcos: 0, orden: 1, nombre: "Delantero" };
  }

  qtyInput.value = Object.keys(_estructuraTrenes).length;

  // Pintar una card por cada tren, ordenado por 'orden'
  const trenesArray = Object.keys(_estructuraTrenes)
    .map((id) => ({
      id,
      ...(_estructuraTrenes[id] || {}),
      orden: parseInt(_estructuraTrenes[id]?.orden) || 99,
    }))
    .sort((a, b) => a.orden - b.orden);

  lista.innerHTML = "";
  trenesArray.forEach((t) => {
    const card = document.createElement("div");
    card.className = "input-card";
    card.style.cssText =
      "display:grid; grid-template-columns: 80px 1fr 1fr 120px; gap:12px; align-items:end;";
    card.innerHTML = `
      <div>
        <label>ID Tren</label>
        <input type="number" min="1" max="10" value="${t.id}"
               data-old-id="${t.id}"
               onchange="_onTrenIdChange(this)">
      </div>
      <div>
        <label>Nombre</label>
        <input type="text" value="${t.nombre || ''}"
               placeholder="Ej: Trasero"
               onchange="_onTrenFieldChange('${t.id}', 'nombre', this.value)">
      </div>
      <div>
        <label>Cantidad de Surcos</label>
        <input type="number" min="0" max="200" value="${t.surcos || 0}"
               onchange="_onTrenFieldChange('${t.id}', 'surcos', this.value)">
      </div>
      <div>
        <label>Orden</label>
        <input type="number" min="1" max="10" value="${t.orden || 1}"
               title="1 = se numera primero, 2 = sigue al anterior..."
               onchange="_onTrenFieldChange('${t.id}', 'orden', this.value)">
      </div>
    `;
    lista.appendChild(card);
  });

  // Preview calculado
  const estructura = _calcularRangosTrenes();
  if (!estructura || estructura.totalSurcos === 0) {
    preview.innerHTML =
      "<strong>Sin estructura definida.</strong> Ingresá cantidad de surcos para ver los rangos.";
  } else {
    const lineas = Object.keys(estructura.rangos)
      .sort((a, b) => estructura.rangos[a].orden - estructura.rangos[b].orden)
      .map((id) => {
        const r = estructura.rangos[id];
        return `<div><strong>Tren ${id}</strong> (${r.nombre}): surcos <strong>${r.inicio}</strong> al <strong>${r.fin}</strong> (${r.surcos} surcos)</div>`;
      });
    preview.innerHTML =
      `${lineas.join("")}<div style="margin-top:8px; font-weight:bold; color:var(--accent);">Total: ${estructura.totalSurcos} surcos</div>`;
  }

  // Warning si el mapeo_sensores tiene bajadas fuera de los rangos definidos
  if (warning) {
    const problemas = _validarMapeoContraEstructura();
    if (problemas.length === 0) {
      warning.style.display = "none";
    } else {
      warning.style.display = "block";
      warning.innerHTML =
        "<strong>⚠ Advertencias:</strong><ul style='margin:8px 0 0 20px; padding:0;'>" +
        problemas.map((p) => `<li>${p}</li>`).join("") +
        "</ul>";
    }
  }
}

/**
 * Verifica consistencia entre estructura y mapeo_sensores.
 * Retorna array de mensajes de advertencia (strings).
 */
function _validarMapeoContraEstructura() {
  const problemas = [];
  const estructura = _calcularRangosTrenes();
  if (!estructura) return problemas;

  // Bajadas activas del mapeo, agrupadas por tren
  const porTren = {};
  workingMapeo.forEach((s) => {
    if (s.is_active === false) return;
    if (
      s.tipo !== "semilla" &&
      s.tipo !== "ferti_linea" &&
      s.tipo !== "ferti_costado"
    )
      return;
    const t = String(s.tren || 1);
    if (!porTren[t]) porTren[t] = [];
    const b = parseInt(s.bajada);
    if (!isNaN(b)) porTren[t].push(b);
  });

  Object.keys(porTren).forEach((idTren) => {
    const rango = estructura.rangos[idTren];
    if (!rango) {
      problemas.push(
        `Hay sensores asignados al Tren ${idTren} pero ese tren no existe en la estructura.`
      );
      return;
    }
    const fuera = porTren[idTren].filter((b) => b < rango.inicio || b > rango.fin);
    if (fuera.length > 0) {
      problemas.push(
        `Tren ${idTren} (${rango.nombre}): hay ${fuera.length} bajada(s) fuera del rango ${rango.inicio}-${rango.fin} → ${fuera.sort((a, b) => a - b).join(", ")}`
      );
    }
  });

  return problemas;
}

/**
 * Handler: el usuario cambió la cantidad de trenes.
 * Crea o borra entradas en _estructuraTrenes según corresponda.
 */
window._onCantTrenesChange = function () {
  const qtyInput = document.getElementById("cfg-qty-trenes");
  if (!qtyInput) return;

  const nueva = Math.max(1, Math.min(10, parseInt(qtyInput.value) || 1));
  const clavesActuales = Object.keys(_estructuraTrenes || {});

  if (nueva > clavesActuales.length) {
    // Agregar trenes faltantes con IDs nuevos no usados
    for (let i = 1; i <= 10 && Object.keys(_estructuraTrenes).length < nueva; i++) {
      if (!_estructuraTrenes[String(i)]) {
        const ordenExistente = Math.max(
          0,
          ...Object.values(_estructuraTrenes).map((t) => parseInt(t.orden) || 0)
        );
        _estructuraTrenes[String(i)] = {
          surcos: 0,
          orden: ordenExistente + 1,
          nombre: i === 1 ? "Delantero" : i === 2 ? "Trasero" : `Tren ${i}`,
        };
      }
    }
  } else if (nueva < clavesActuales.length) {
    // Quitar los trenes con mayor 'orden' hasta dejar 'nueva'
    const ordenados = clavesActuales
      .map((id) => ({ id, orden: parseInt(_estructuraTrenes[id].orden) || 99 }))
      .sort((a, b) => b.orden - a.orden);
    const aBorrar = ordenados.slice(0, clavesActuales.length - nueva);
    aBorrar.forEach((t) => {
      delete _estructuraTrenes[t.id];
    });
  }

  _renderizarTabTrenes();
};

/**
 * Handler: el usuario cambió nombre, surcos u orden de un tren.
 */
window._onTrenFieldChange = function (idTren, campo, valor) {
  if (!_estructuraTrenes[idTren]) return;

  if (campo === "nombre") {
    _estructuraTrenes[idTren].nombre = String(valor).trim().substring(0, 32);
  } else if (campo === "surcos") {
    _estructuraTrenes[idTren].surcos = Math.max(0, parseInt(valor) || 0);
  } else if (campo === "orden") {
    _estructuraTrenes[idTren].orden = Math.max(1, parseInt(valor) || 1);
  }

  _renderizarTabTrenes();
};

/**
 * Handler: el usuario cambió el ID numérico de un tren.
 * Mueve la entrada de _estructuraTrenes de la clave vieja a la nueva.
 */
window._onTrenIdChange = function (inputEl) {
  const idViejo = String(inputEl.dataset.oldId);
  const idNuevo = String(Math.max(1, parseInt(inputEl.value) || 1));

  if (idViejo === idNuevo) return;

  if (_estructuraTrenes[idNuevo]) {
    _toast(`Ya existe el Tren ${idNuevo}. Elegí otro ID.`, "warn");
    inputEl.value = idViejo;
    return;
  }

  _estructuraTrenes[idNuevo] = _estructuraTrenes[idViejo];
  delete _estructuraTrenes[idViejo];

  _renderizarTabTrenes();
};

// ============================================================
// TOAST MINIMALISTA
// ============================================================

function _toast(mensaje, tipo) {
  if (!tipo) tipo = "ok";
  let host = document.getElementById("config-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "config-toast-host";
    host.style.cssText =
      "position:fixed; top:80px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:8px; max-width:360px;";
    document.body.appendChild(host);
  }

  const colores = {
    ok: { bg: "#1a3a1a", border: "#4ade80", color: "#dcfce7" },
    warn: { bg: "#3a2a0a", border: "#ffa500", color: "#fed7aa" },
    err: { bg: "#3a1a1a", border: "#ff4444", color: "#fecaca" },
  };
  const c = colores[tipo] || colores.ok;

  const toast = document.createElement("div");
  toast.style.cssText =
    "background:" + c.bg + "; color:" + c.color + "; border-left:4px solid " + c.border + "; " +
    "padding:12px 16px; border-radius:6px; font-size:14px; " +
    "box-shadow:0 4px 12px rgba(0,0,0,0.4); opacity:0; " +
    "transition:opacity 0.3s ease;";
  toast.textContent = mensaje;
  host.appendChild(toast);

  requestAnimationFrame(() => (toast.style.opacity = "1"));
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- TABS ---
window.switchTab = function (tabId) {
  if (tabId === "sensores") {
    actualizarSelectNodos(nodoActual).catch((e) =>
      console.warn("[ConfigModal v2.5] No se pudo refrescar nodos:", e.message)
    );
  }
  if (tabId === "perfiles" && typeof cargarPerfiles === "function") cargarPerfiles();
  if (tabId === "trenes") _renderizarTabTrenes();
  if (tabId === "mapeo") guardarEstadoTablaActual();

  document.querySelectorAll(".tab-content").forEach((t) => (t.style.display = "none"));
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
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
  const tiposEspeciales = [
    "turbina",
    "rotacion_eje",
    "tolva_vacia",
    "bajada_herramienta",
    "bateria",
  ];

  workingMapeo.forEach((s) => {
    if (s.is_active === false) return;
    if (tiposEspeciales.includes(s.tipo)) {
      if (!grupos.especiales) grupos.especiales = [];
      grupos.especiales.push(s);
    } else {
      const t = `tren${s.tren || 1}`;
      if (!grupos[t]) grupos[t] = [];
      grupos[t].push(s);
    }
  });

  const trenesKeys = Object.keys(grupos)
    .filter((k) => k.startsWith("tren"))
    .sort();
  trenesKeys.forEach((tKey) => {
    const row = document.createElement("div");
    row.className = "mapeo-tren-row";
    row.innerHTML = `<small>${tKey.toUpperCase().replace("TREN", "TREN ")}</small>`;
    const grid = document.createElement("div");
    grid.style.cssText =
      "display:flex;gap:4px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:10px;justify-content:center";

    const bajadas = {};
    grupos[tKey].forEach((s) => {
      if (!bajadas[s.bajada]) bajadas[s.bajada] = [];
      bajadas[s.bajada].push(s);
    });

    Object.keys(bajadas)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .forEach((numBajada) => {
        const col = document.createElement("div");
        col.className = "surco-column";
        col.style.flexShrink = "0";
        let pillsHTML = "";
        bajadas[numBajada].forEach((sensor) => {
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
    const ICONOS = {
      rotacion_eje: "fas fa-cogs",
      turbina: "fas fa-fan",
      bajada_herramienta: "fas fa-arrow-down",
      bateria: "fas fa-car-battery",
      tolva_vacia: "fas fa-archive",
    };
    grupos.especiales
      .sort((a, b) => a.bajada - b.bajada)
      .forEach((e) => {
        const box = document.createElement("div");
        box.className = "sensor-especial";
        box.style.borderColor = "#444";
        box.innerHTML = `<i class="${ICONOS[e.tipo] || "fas fa-microchip"}" style="color:#666"></i><div class="info"><span style="color:#888">${e.nombre}</span><strong style="color:#aaa">#${e.bajada}</strong></div>`;
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
    if (s.is_active === false) continue;
    if (s.bajada === "" || isNaN(parseInt(s.bajada))) continue;
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

  const objetivosPorTren = {};
  document.querySelectorAll(".cfg-obj-tren").forEach((inp) => {
    const t = inp.dataset.tren;
    objetivosPorTren[t] = parseFloat(inp.value) || 16;
  });

  const nuevaConfig = {
    id: APP_CONFIG.id,
    nombre:
      document.getElementById("cfg-nombre")?.value ||
      APP_CONFIG.nombre ||
      "Máquina",
    setup: {
      distancia_entre_surcos:
        parseFloat(document.getElementById("cfg-distancia")?.value) || 0.191,
      densidad_objetivo:
        parseFloat(document.getElementById("input-objetivo")?.value) || 16,
      objetivos_tren: objetivosPorTren,
      tolerancia_desvio:
        parseFloat(document.getElementById("cfg-tolerancia-desvio")?.value) || 20,
      rpm_min: parseFloat(document.getElementById("cfg-rpm-min")?.value) || 2000,
      rpm_max: parseFloat(document.getElementById("cfg-rpm-max")?.value) || 5000,
      tolvas: parseInt(document.getElementById("cfg-qty-tolvas")?.value) || 2,
      velocidad_max: 8.5,
      alarma_tiempo_seg: 2,
    },
    trenes: _estructuraTrenes || {},
    mapeo_sensores: workingMapeo,
    monitoreo: _leerConfigMonitoreo(),
  };

  try {
    const response = await fetch("/api/config/maquinas/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nuevaConfig),
    });
    if (response.ok) {
      alert("Configuración Guardada.");
      location.reload();
    } else throw new Error("Error en servidor");
  } catch (e) {
    alert("Error de conexión.");
    btn.innerText = originalText;
  }
}

function cerrarModal() {
  const modal = document.getElementById("modal-config");
  if (modal) modal.style.display = "none";
  if (window.Shell) Shell.barMode();
}

// ============================================================
// MONITOREO — Método de inicio configurable
// ============================================================

window._onMetodoInicioChange = function (val) {
  const optsDiv = document.getElementById("cfg-monitoreo-sensores-opts");
  if (optsDiv) optsDiv.style.display = val === "sensores" ? "" : "none";
};

function _cargarConfigMonitoreo() {
  const metodo = APP_CONFIG?.monitoreo?.metodo_inicio || "sensores";
  const umbral = APP_CONFIG?.monitoreo?.umbral_sensores_activos || 3;
  const tiempo = APP_CONFIG?.monitoreo?.tiempo_confirmacion_ms || 500;

  const selMetodo = document.getElementById("cfg-metodo-inicio");
  if (selMetodo) selMetodo.value = metodo;

  const slUmbral = document.getElementById("cfg-umbral-sensores");
  const lblUmbral = document.getElementById("cfg-umbral-val");
  if (slUmbral) slUmbral.value = umbral;
  if (lblUmbral) lblUmbral.textContent = umbral;

  const inpTiempo = document.getElementById("cfg-tiempo-confirmacion");
  if (inpTiempo) inpTiempo.value = tiempo;

  _onMetodoInicioChange(metodo);
}

function _leerConfigMonitoreo() {
  return {
    metodo_inicio: document.getElementById("cfg-metodo-inicio")?.value || "sensores",
    umbral_sensores_activos:
      parseInt(document.getElementById("cfg-umbral-sensores")?.value) || 3,
    tiempo_confirmacion_ms:
      parseInt(document.getElementById("cfg-tiempo-confirmacion")?.value) || 500,
  };
}

window._actualizarEstadoMonitoreo = function (monitoreoActivo) {
  const led = document.getElementById("cfg-monitoreo-estado-led");
  const txt = document.getElementById("cfg-monitoreo-estado-txt");
  if (led) led.style.background = monitoreoActivo ? "var(--accent)" : "#333";
  if (led) led.style.borderColor = monitoreoActivo ? "var(--accent)" : "#444";
  if (txt) txt.textContent = monitoreoActivo ? "MONITOREANDO" : "Esperando inicio...";
  if (txt) txt.style.color = monitoreoActivo ? "var(--accent)" : "#888";

  const footerLed = document.getElementById("monitoreo-estado-footer");
  if (footerLed) {
    footerLed.style.background = monitoreoActivo ? "var(--accent)" : "#333";
    footerLed.title = monitoreoActivo ? "Monitoreando" : "Esperando inicio";
  }
};

window.probarSonido = function (rutaSonido) {
  const audioTest = new Audio(rutaSonido);
  audioTest.play().catch(() => {});
  const audioPrincipal = document.getElementById("audio-alarma");
  if (audioPrincipal) audioPrincipal.src = rutaSonido;
};

window.prepararNuevoNodo = function (nodoData) {
  if (typeof abrirModal === "function") abrirModal();
  if (typeof guardarEstadoTablaActual === "function") guardarEstadoTablaActual();
  let existe = workingMapeo.some((s) => s.uid === nodoData.uid);
  if (!existe) {
    for (let i = 0; i < nodoData.capacidad_cables; i++) {
      workingMapeo.push({
        uid: nodoData.uid,
        cable: i + 1,
        bajada: "",
        tipo: "semilla",
        tren: 1,
        is_active: true,
      });
    }
  }
  nodoActual = nodoData.uid;
  if (typeof actualizarSelectNodos === "function") actualizarSelectNodos(nodoActual);
  if (typeof switchTab === "function") switchTab("perfiles");
  alert(`🚜 ¡Nodo ${nodoData.uid} detectado!\nAsigná cada cable y guardá.`);
};
