// ============================================================
// VistaX — tab_sensores.js  (v3.1)
//
// Tab "Sensores": vincular sensores físicos (nodos+cables) con
// sus roles lógicos en el implemento (surcos, tolvas, ejes, etc).
//
// Estructura:
//   perfil.mapeo_sensores = [
//     { uid, cable, tipo, bajada?, tren?, nombre?, is_active, logica_invertida? }
//   ]
//
// Vistas internas:
//   1. Siembra      — grilla por tren, un slot por surco
//   2. Otros        — lista de sensores no-siembra (tolvas, turbinas, etc)
//   3. Cables libres — qué cables de cada nodo están sin asignar
//
// Features:
//   - Alta/edición manual por modal
//   - Wizard de autonumeración por tren
//   - Validaciones de conflictos en tiempo real
//   - Soft-delete (is_active: false) para mantener historial
//   - Override de sonidos por sensor individual (Commit 6.1)
// ============================================================

const TIPOS_SENSOR = [
  { id: "semilla",           label: "Semilla",            cat: "siembra", icon: "fa-seedling",      modo: "pulse" },
  { id: "ferti_linea",       label: "Fertilizante línea", cat: "siembra", icon: "fa-droplet",       modo: "pulse" },
  { id: "ferti_costado",     label: "Fertilizante costado", cat: "siembra", icon: "fa-droplet",     modo: "pulse" },
  { id: "rotacion_eje",      label: "Rotación eje",       cat: "otros",   icon: "fa-arrows-spin",   modo: "pulse" },
  { id: "turbina",           label: "Turbina",            cat: "otros",   icon: "fa-fan",           modo: "pulse" },
  { id: "tolva_vacia",       label: "Tolva vacía",        cat: "otros",   icon: "fa-box-open",      modo: "state" },
  { id: "tolva_llena",       label: "Tolva llena",        cat: "otros",   icon: "fa-box",           modo: "state" },
  { id: "bajada_herramienta", label: "Bajada herramienta", cat: "otros",  icon: "fa-down-long",     modo: "state" },
  { id: "presion",           label: "Presión",            cat: "otros",   icon: "fa-gauge",         modo: "state" },
  { id: "final_carrera",     label: "Final de carrera",   cat: "otros",   icon: "fa-circle-dot",    modo: "state" },
];

const TIPOS_SIEMBRA = TIPOS_SENSOR.filter(t => t.cat === "siembra").map(t => t.id);

class TabSensores extends TabBase {
  constructor(opts) {
    super(opts);
    this.sensores = this._clonar(this.perfil?.mapeo_sensores || []);
    this.vista    = "siembra"; // siembra | otros | libres
    this._dirty   = false;
    this.nodos    = []; // inventario fresco
  }

  _clonar(arr) {
    return JSON.parse(JSON.stringify(arr || []));
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-broadcast-tower"></i>
          Sensores
          <span class="tab-subtitle">
            Vinculá cada cable de los nodos ESP32 con su función en la máquina
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn" id="btn-sens-wizard">
            <i class="fas fa-wand-magic-sparkles"></i> Autonumerar Tren
          </button>
          <button class="btn" id="btn-sens-nuevo">
            <i class="fas fa-plus"></i> Agregar Sensor
          </button>
          <button class="btn btn-primary" id="btn-sens-guardar" disabled>
            <i class="fas fa-check"></i> Guardar
          </button>
        </div>
      </div>

      <div class="sens-subtabs">
        <button class="sens-subtab active" data-vista="siembra">
          <i class="fas fa-seedling"></i> Siembra
          <span class="count" id="ct-siembra">0</span>
        </button>
        <button class="sens-subtab" data-vista="otros">
          <i class="fas fa-fan"></i> Otros sensores
          <span class="count" id="ct-otros">0</span>
        </button>
        <button class="sens-subtab" data-vista="libres">
          <i class="fas fa-plug-circle-xmark"></i> Cables libres
          <span class="count" id="ct-libres">0</span>
        </button>
      </div>

      <div id="sens-content">
        <div class="cfg-loading">
          <i class="fas fa-circle-notch fa-spin"></i>
          <span>Cargando inventario de nodos...</span>
        </div>
      </div>
    `;

    container.querySelector("#btn-sens-guardar").addEventListener("click", () => this._guardar());
    container.querySelector("#btn-sens-nuevo").addEventListener("click", () => this._abrirFormSensor());
    container.querySelector("#btn-sens-wizard").addEventListener("click", () => this._abrirWizard());

    container.querySelectorAll(".sens-subtab").forEach(btn => {
      btn.addEventListener("click", () => {
        this.vista = btn.dataset.vista;
        container.querySelectorAll(".sens-subtab").forEach(b =>
          b.classList.toggle("active", b === btn)
        );
        this._renderVista();
      });
    });

    // Cargar inventario de nodos
    await this._cargarNodos();
    this._renderVista();
    this._actualizarContadores();
  }

  async _cargarNodos() {
    try {
      const r = await fetch("/api/nodos");
      const data = await r.json();
      this.nodos = (data.nodos || []).filter(n => !n.ignorado);
    } catch (e) {
      console.error("[TabSensores] Error cargando nodos:", e);
      this.nodos = [];
    }
  }

  // ── Contadores ────────────────────────────────────────────

  _actualizarContadores() {
    const activos = this.sensores.filter(s => s.is_active !== false);
    const cSiembra = activos.filter(s => TIPOS_SIEMBRA.includes(s.tipo)).length;
    const cOtros = activos.filter(s => !TIPOS_SIEMBRA.includes(s.tipo)).length;
    const cLibres = this._contarCablesLibres();

    this.container.querySelector("#ct-siembra").textContent = cSiembra;
    this.container.querySelector("#ct-otros").textContent = cOtros;
    this.container.querySelector("#ct-libres").textContent = cLibres;
  }

  _contarCablesLibres() {
    let libres = 0;
    for (const n of this.nodos) {
      const cap = n.capacidad_cables || 8;
      const asignados = this.sensores.filter(s =>
        s.is_active !== false && s.uid === n.uid
      ).length;
      libres += Math.max(0, cap - asignados);
    }
    return libres;
  }

  // ── Render por vista ──────────────────────────────────────

  _renderVista() {
    const cont = this.container.querySelector("#sens-content");
    if (this.vista === "siembra")  return this._renderSiembra(cont);
    if (this.vista === "otros")    return this._renderOtros(cont);
    if (this.vista === "libres")   return this._renderLibres(cont);
  }

  // ── Vista: Siembra (grilla por tren) ──────────────────────

  _renderSiembra(cont) {
    const rangos = this._calcularRangosTrenes();

    if (!rangos || rangos.lista.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-train"></i>
          <div class="title">Sin trenes definidos</div>
          <div>Primero definí la estructura de trenes en el tab <strong>Trenes</strong></div>
        </div>
      `;
      return;
    }

    cont.innerHTML = rangos.lista.map(r => this._renderTrenGrilla(r)).join("");

    // Wire de slots
    cont.querySelectorAll(".slot-surco").forEach(slot => {
      slot.addEventListener("click", () => {
        const tren = slot.dataset.tren;
        const bajada = parseInt(slot.dataset.bajada);
        const idx = parseInt(slot.dataset.idx);
        if (idx >= 0) {
          this._abrirFormSensor(this.sensores[idx]);
        } else {
          this._abrirFormSensor(null, { tren, bajada });
        }
      });
    });
  }

  _renderTrenGrilla(r) {
    const slots = [];
    for (let b = r.inicio; b <= r.fin; b++) {
      const idx = this.sensores.findIndex(s =>
        s.is_active !== false &&
        TIPOS_SIEMBRA.includes(s.tipo) &&
        String(s.tren) === String(r.id) &&
        parseInt(s.bajada) === b
      );
      slots.push({ bajada: b, idx });
    }

    const cobertura = slots.filter(s => s.idx >= 0).length;
    const total = slots.length;
    const pct = total ? Math.round((cobertura / total) * 100) : 0;

    return `
      <div class="tren-grilla">
        <div class="tren-grilla-header">
          <div>
            <strong>${this._esc(r.nombre)}</strong>
            <span class="tren-rango">Surcos ${r.inicio}–${r.fin}</span>
          </div>
          <div class="tren-cobertura ${pct === 100 ? "ok" : pct > 0 ? "partial" : "empty"}">
            ${cobertura}/${total} asignados · ${pct}%
          </div>
        </div>
        <div class="tren-slots">
          ${slots.map(s => {
            if (s.idx >= 0) {
              const sensor = this.sensores[s.idx];
              const tipo = TIPOS_SENSOR.find(t => t.id === sensor.tipo);
              return `
                <div class="slot-surco ok" data-tren="${this._esc(r.id)}"
                     data-bajada="${s.bajada}" data-idx="${s.idx}"
                     title="${this._esc(sensor.uid)} cable ${sensor.cable}">
                  <div class="slot-num">${s.bajada}</div>
                  <div class="slot-uid">${this._esc(sensor.uid.slice(-4))}</div>
                  <div class="slot-cable">c${sensor.cable}</div>
                  <i class="fas ${tipo?.icon || "fa-seedling"} slot-icon"></i>
                </div>
              `;
            }
            return `
              <div class="slot-surco empty" data-tren="${this._esc(r.id)}"
                   data-bajada="${s.bajada}" data-idx="-1"
                   title="Click para asignar surco ${s.bajada}">
                <div class="slot-num">${s.bajada}</div>
                <div class="slot-plus"><i class="fas fa-plus"></i></div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  // ── Vista: Otros sensores ─────────────────────────────────

  _renderOtros(cont) {
    const otros = this.sensores
      .map((s, idx) => ({ ...s, _idx: idx }))
      .filter(s => s.is_active !== false && !TIPOS_SIEMBRA.includes(s.tipo));

    if (otros.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-box-open"></i>
          <div class="title">Sin sensores "otros" configurados</div>
          <div>Agregá sensores de tolvas, turbinas, ejes o herramienta</div>
        </div>
      `;
      return;
    }

    cont.innerHTML = `
      <div class="otros-grid">
        ${otros.map(s => this._renderSensorCard(s)).join("")}
      </div>
    `;
    cont.querySelectorAll(".sensor-card").forEach(card => {
      const idx = parseInt(card.dataset.idx);
      card.addEventListener("click", () => this._abrirFormSensor(this.sensores[idx]));
    });
  }

  _renderSensorCard(s) {
    const tipo = TIPOS_SENSOR.find(t => t.id === s.tipo) || { label: s.tipo, icon: "fa-question" };
    return `
      <div class="sensor-card" data-idx="${s._idx}">
        <div class="sensor-card-icon"><i class="fas ${tipo.icon}"></i></div>
        <div class="sensor-card-body">
          <div class="sensor-card-tipo">${this._esc(tipo.label)}</div>
          <div class="sensor-card-nombre">${this._esc(s.nombre || "(sin nombre)")}</div>
          <div class="sensor-card-meta">
            <span><i class="fas fa-microchip"></i> ${this._esc(s.uid)}</span>
            <span><i class="fas fa-plug"></i> cable ${s.cable}</span>
            ${s.logica_invertida ? `<span class="chip-inv">INV</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  // ── Vista: Cables libres ──────────────────────────────────

  _renderLibres(cont) {
    if (this.nodos.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-microchip"></i>
          <div class="title">No hay nodos en el inventario</div>
          <div>Encendé los ESP32 para que aparezcan acá</div>
        </div>
      `;
      return;
    }

    cont.innerHTML = `
      <div class="libres-list">
        ${this.nodos.map(n => this._renderNodoCables(n)).join("")}
      </div>
    `;

    cont.querySelectorAll(".cable-slot.libre").forEach(slot => {
      slot.addEventListener("click", () => {
        const uid = slot.dataset.uid;
        const cable = parseInt(slot.dataset.cable);
        this._abrirFormSensor(null, { uid, cable });
      });
    });
    cont.querySelectorAll(".cable-slot.ocupado").forEach(slot => {
      slot.addEventListener("click", () => {
        const idx = parseInt(slot.dataset.idx);
        this._abrirFormSensor(this.sensores[idx]);
      });
    });
  }

  _renderNodoCables(n) {
    const cap = n.capacidad_cables || 8;
    const cables = [];
    for (let c = 0; c < cap; c++) {
      const idx = this.sensores.findIndex(s =>
        s.is_active !== false && s.uid === n.uid && parseInt(s.cable) === c
      );
      cables.push({ num: c, idx });
    }
    const libres = cables.filter(c => c.idx < 0).length;

    return `
      <div class="nodo-cables-card">
        <div class="nodo-cables-header">
          <div class="nodo-status-dot" style="background: ${n.online ? "#84cc16" : "#f59e0b"}"></div>
          <div>
            <div class="nodo-cables-uid">${this._esc(n.uid)}</div>
            ${n.alias ? `<div class="nodo-cables-alias">${this._esc(n.alias)}</div>` : ""}
          </div>
          <div class="nodo-cables-libres">
            <strong>${libres}</strong> libres / ${cap}
          </div>
        </div>
        <div class="cables-slots">
          ${cables.map(c => {
            if (c.idx >= 0) {
              const s = this.sensores[c.idx];
              const tipo = TIPOS_SENSOR.find(t => t.id === s.tipo);
              return `
                <div class="cable-slot ocupado" data-idx="${c.idx}"
                     title="${this._esc(tipo?.label || s.tipo)}">
                  <div class="cable-num">c${c.num}</div>
                  <i class="fas ${tipo?.icon || "fa-plug"}"></i>
                </div>
              `;
            }
            return `
              <div class="cable-slot libre" data-uid="${this._esc(n.uid)}" data-cable="${c.num}"
                   title="Click para asignar">
                <div class="cable-num">c${c.num}</div>
                <i class="fas fa-plus"></i>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  // ── Cálculo de rangos de trenes (local) ───────────────────

  _calcularRangosTrenes() {
    const trenes = this.perfil?.trenes || {};
    const arr = Object.entries(trenes)
      .map(([id, cfg]) => ({
        id,
        surcos: parseInt(cfg.surcos) || 0,
        orden:  parseInt(cfg.orden)  || 99,
        nombre: cfg.nombre || `Tren ${id}`,
      }))
      .filter(t => t.surcos > 0)
      .sort((a, b) => a.orden - b.orden);

    if (arr.length === 0) return null;

    const rangos = {};
    const lista = [];
    let sig = 1;
    for (const t of arr) {
      const r = { id: t.id, inicio: sig, fin: sig + t.surcos - 1, surcos: t.surcos, nombre: t.nombre };
      rangos[t.id] = r;
      lista.push(r);
      sig += t.surcos;
    }
    return { rangos, lista, totalSurcos: sig - 1 };
  }

  // ── Formulario de sensor (alta / edición) ─────────────────

  _abrirFormSensor(sensor = null, preset = {}) {
    const esNuevo = !sensor;
    const s = sensor || {
      uid: preset.uid || "",
      cable: preset.cable ?? 0,
      tipo: preset.tren ? "semilla" : "tolva_vacia",
      bajada: preset.bajada || null,
      tren: preset.tren || null,
      nombre: "",
      is_active: true,
      logica_invertida: false,
    };

    const rangos = this._calcularRangosTrenes();
    const overlay = document.createElement("div");
    overlay.className = "cfg-prompt-overlay";
    overlay.innerHTML = `
      <div class="cfg-prompt" style="min-width: 520px; max-width: 600px;">
        <h3>
          <i class="fas fa-broadcast-tower"></i>
          ${esNuevo ? "Nuevo sensor" : "Editar sensor"}
        </h3>

        <div class="form-grid">
          <div class="form-field full">
            <label>Tipo de sensor</label>
            <select id="f-tipo">
              <optgroup label="Siembra">
                ${TIPOS_SENSOR.filter(t => t.cat === "siembra").map(t =>
                  `<option value="${t.id}" ${s.tipo === t.id ? "selected" : ""}>${t.label}</option>`
                ).join("")}
              </optgroup>
              <optgroup label="Otros">
                ${TIPOS_SENSOR.filter(t => t.cat === "otros").map(t =>
                  `<option value="${t.id}" ${s.tipo === t.id ? "selected" : ""}>${t.label} (${t.modo})</option>`
                ).join("")}
              </optgroup>
            </select>
          </div>

          <div class="form-field">
            <label>Nodo ESP32</label>
            <select id="f-uid">
              <option value="">— Elegir —</option>
              ${this.nodos.map(n =>
                `<option value="${this._esc(n.uid)}" ${s.uid === n.uid ? "selected" : ""}>
                  ${this._esc(n.uid)}${n.alias ? ` (${this._esc(n.alias)})` : ""}
                </option>`
              ).join("")}
            </select>
          </div>

          <div class="form-field">
            <label>Cable (0–7)</label>
            <select id="f-cable"></select>
          </div>

          <div class="form-field form-siembra" id="wrap-tren">
            <label>Tren</label>
            <select id="f-tren">
              ${(rangos?.lista || []).map(r =>
                `<option value="${this._esc(r.id)}" ${String(s.tren) === String(r.id) ? "selected" : ""}>
                  ${this._esc(r.nombre)} (${r.inicio}–${r.fin})
                </option>`
              ).join("")}
            </select>
          </div>

          <div class="form-field form-siembra" id="wrap-bajada">
            <label>Surco (bajada)</label>
            <input type="number" id="f-bajada" min="1" value="${s.bajada || ""}" />
          </div>

          <div class="form-field full">
            <label>Nombre (opcional)</label>
            <input type="text" id="f-nombre" value="${this._esc(s.nombre || "")}"
                   placeholder="Ej: Surco izquierdo 1" maxlength="40" />
          </div>

          <div class="form-field full form-state" id="wrap-inv">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="f-inv" ${s.logica_invertida ? "checked" : ""} />
              <span>Lógica invertida (activo en bajo)</span>
            </label>
          </div>

          <div class="form-field full" id="wrap-override-sonido"
               style="${esNuevo ? 'display:none;' : ''}">
            <button type="button" class="btn-override-sonido" id="f-override">
              <i class="fas fa-music"></i>
              <span id="ov-label">Configurar sonido individual</span>
            </button>
          </div>
        </div>

        <div id="f-error" class="form-error"></div>

        <div class="actions">
          ${!esNuevo ? `<button class="btn btn-danger" id="f-del">
            <i class="fas fa-trash"></i> Eliminar
          </button>` : ""}
          <div style="flex: 1;"></div>
          <button class="btn btn-ghost" id="f-cancel">Cancelar</button>
          <button class="btn btn-primary" id="f-ok">
            <i class="fas fa-check"></i> ${esNuevo ? "Agregar" : "Guardar"}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const $ = sel => overlay.querySelector(sel);
    const close = () => overlay.remove();

    const actualizarCables = () => {
      const uid = $("#f-uid").value;
      const nodo = this.nodos.find(n => n.uid === uid);
      const cap = nodo?.capacidad_cables || 8;
      const cableSel = $("#f-cable");
      cableSel.innerHTML = "";
      for (let c = 0; c < cap; c++) {
        // Verificar si está ocupado por OTRO sensor (distinto del que estamos editando)
        const ocupado = this.sensores.some(otro =>
          otro !== sensor &&
          otro.is_active !== false &&
          otro.uid === uid &&
          parseInt(otro.cable) === c
        );
        const sel = parseInt(s.cable) === c ? "selected" : "";
        const label = `c${c}${ocupado ? " (ocupado)" : ""}`;
        cableSel.innerHTML += `<option value="${c}" ${sel} ${ocupado ? "disabled" : ""}>${label}</option>`;
      }
    };

    const actualizarCamposPorTipo = () => {
      const tipo = $("#f-tipo").value;
      const esSiembra = TIPOS_SIEMBRA.includes(tipo);
      const tipoDef = TIPOS_SENSOR.find(t => t.id === tipo);
      const esState = tipoDef?.modo === "state";

      overlay.querySelectorAll(".form-siembra").forEach(el =>
        el.style.display = esSiembra ? "" : "none"
      );
      overlay.querySelectorAll(".form-state").forEach(el =>
        el.style.display = esState ? "" : "none"
      );
    };

    $("#f-tipo").addEventListener("change", actualizarCamposPorTipo);
    $("#f-uid").addEventListener("change", actualizarCables);

    actualizarCables();
    actualizarCamposPorTipo();

    // ── Wire del botón Override de sonido (Commit 6.1) ──
    const btnOverride = $("#f-override");
    if (btnOverride && !esNuevo) {
      // Actualizar label si ya tiene override
      if (window.vistaxKeyOverride) {
        const key = window.vistaxKeyOverride(sensor.uid, sensor.cable);
        const tieneOverride = !!this.perfil?.ui?.sonidos?.por_sensor?.[key];
        if (tieneOverride) {
          btnOverride.classList.add("has-override");
          $("#ov-label").innerHTML = `Override de sonido configurado <span class="badge-count">●</span>`;
        }
      }
      btnOverride.addEventListener("click", () => {
        this._abrirOverrideSonido(sensor);
      });
    }

    $("#f-cancel").onclick = close;

    if (!esNuevo) {
      $("#f-del").onclick = () => {
        sensor.is_active = false;
        this._marcarDirty();
        this._renderVista();
        this._actualizarContadores();
        close();
        this._toast("Sensor eliminado");
      };
    }

    $("#f-ok").onclick = () => {
      const nuevo = {
        uid:              $("#f-uid").value,
        cable:            parseInt($("#f-cable").value),
        tipo:             $("#f-tipo").value,
        nombre:           $("#f-nombre").value.trim(),
        is_active:        true,
        logica_invertida: $("#f-inv").checked,
      };

      if (TIPOS_SIEMBRA.includes(nuevo.tipo)) {
        nuevo.tren   = $("#f-tren").value;
        nuevo.bajada = parseInt($("#f-bajada").value);
      }

      const err = this._validarSensor(nuevo, sensor);
      if (err) {
        $("#f-error").textContent = err;
        return;
      }

      if (esNuevo) {
        this.sensores.push(nuevo);
      } else {
        Object.assign(sensor, nuevo);
      }
      this._marcarDirty();
      this._renderVista();
      this._actualizarContadores();
      close();
      this._toast(esNuevo ? "Sensor agregado" : "Sensor actualizado");
    };
  }

  _validarSensor(nuevo, excluir = null) {
    if (!nuevo.uid) return "Seleccioná un nodo";
    if (nuevo.cable == null || isNaN(nuevo.cable)) return "Cable inválido";
    if (!nuevo.tipo) return "Tipo requerido";

    // UID+cable único
    const conflicto = this.sensores.find(s =>
      s !== excluir &&
      s.is_active !== false &&
      s.uid === nuevo.uid &&
      parseInt(s.cable) === parseInt(nuevo.cable)
    );
    if (conflicto) return `El cable ${nuevo.cable} del nodo ${nuevo.uid} ya está asignado`;

    // Validaciones de siembra
    if (TIPOS_SIEMBRA.includes(nuevo.tipo)) {
      if (!nuevo.tren) return "Falta el tren";
      if (!nuevo.bajada || nuevo.bajada < 1) return "Surco (bajada) inválido";

      const rangos = this._calcularRangosTrenes();
      const r = rangos?.rangos?.[nuevo.tren];
      if (!r) return `El tren ${nuevo.tren} no existe`;
      if (nuevo.bajada < r.inicio || nuevo.bajada > r.fin) {
        return `El surco ${nuevo.bajada} está fuera del rango del tren (${r.inicio}–${r.fin})`;
      }

      // Bajada+tren único
      const dup = this.sensores.find(s =>
        s !== excluir &&
        s.is_active !== false &&
        TIPOS_SIEMBRA.includes(s.tipo) &&
        String(s.tren) === String(nuevo.tren) &&
        parseInt(s.bajada) === parseInt(nuevo.bajada)
      );
      if (dup) return `El surco ${nuevo.bajada} del tren ${nuevo.tren} ya tiene un sensor (${dup.uid} c${dup.cable})`;
    }

    return null;
  }

  // ── Wizard de autonumeración ──────────────────────────────

  _abrirWizard() {
    const rangos = this._calcularRangosTrenes();
    if (!rangos || rangos.lista.length === 0) {
      this._toast("Primero definí trenes en el tab Trenes", "warn");
      return;
    }
    if (this.nodos.length === 0) {
      this._toast("No hay nodos en el inventario", "warn");
      return;
    }

    let trenSel = rangos.lista[0].id;
    let tipoSel = "semilla";
    let nodosSeleccionados = [];
    let sobrescribir = false;

    const overlay = document.createElement("div");
    overlay.className = "cfg-prompt-overlay";
    overlay.innerHTML = `
      <div class="cfg-prompt" style="min-width: 640px; max-width: 760px;">
        <h3><i class="fas fa-wand-magic-sparkles"></i> Autonumerar Tren</h3>

        <p style="color: var(--ap-text-muted); margin: 0 0 16px 0; font-size: 13px;">
          Asigna cables consecutivos de los nodos seleccionados a surcos correlativos del tren.
          El orden importa: arrastrá los nodos para definir cuál va primero.
        </p>

        <div class="form-grid">
          <div class="form-field">
            <label>Tren</label>
            <select id="w-tren">
              ${rangos.lista.map(r =>
                `<option value="${this._esc(r.id)}">${this._esc(r.nombre)} (${r.inicio}–${r.fin}, ${r.surcos} surcos)</option>`
              ).join("")}
            </select>
          </div>
          <div class="form-field">
            <label>Tipo</label>
            <select id="w-tipo">
              ${TIPOS_SENSOR.filter(t => t.cat === "siembra").map(t =>
                `<option value="${t.id}">${t.label}</option>`
              ).join("")}
            </select>
          </div>
        </div>

        <label style="display:block;font-size:11px;text-transform:uppercase;color:var(--ap-text-muted);margin:16px 0 8px;font-weight:700;">
          Nodos a usar (en orden)
        </label>
        <div class="wizard-nodos" id="w-nodos"></div>

        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:14px;">
          <input type="checkbox" id="w-sobrescribir" />
          <span>Sobrescribir sensores existentes en este tren</span>
        </label>

        <div class="wizard-preview" id="w-preview"></div>

        <div id="w-error" class="form-error"></div>

        <div class="actions" style="margin-top: 16px;">
          <button class="btn btn-ghost" id="w-cancel">Cancelar</button>
          <button class="btn btn-primary" id="w-ok">
            <i class="fas fa-check"></i> Aplicar
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const $ = sel => overlay.querySelector(sel);
    const close = () => overlay.remove();

    const renderNodos = () => {
      const cont = $("#w-nodos");
      cont.innerHTML = this.nodos.map(n => {
        const cap = n.capacidad_cables || 8;
        const ocupados = this.sensores.filter(s =>
          s.is_active !== false && s.uid === n.uid
        ).length;
        const libres = cap - ocupados;
        const checked = nodosSeleccionados.includes(n.uid) ? "checked" : "";
        const orden = nodosSeleccionados.indexOf(n.uid);
        return `
          <label class="wizard-nodo ${checked ? "selected" : ""}">
            <input type="checkbox" data-uid="${this._esc(n.uid)}" ${checked} />
            <div class="wiz-nodo-orden">${orden >= 0 ? orden + 1 : ""}</div>
            <div class="wiz-nodo-body">
              <strong>${this._esc(n.uid)}</strong>
              ${n.alias ? `<span>${this._esc(n.alias)}</span>` : ""}
            </div>
            <div class="wiz-nodo-libres">${libres} libres</div>
          </label>
        `;
      }).join("");

      cont.querySelectorAll("input[type=checkbox]").forEach(chk => {
        chk.addEventListener("change", () => {
          const uid = chk.dataset.uid;
          if (chk.checked) {
            if (!nodosSeleccionados.includes(uid)) nodosSeleccionados.push(uid);
          } else {
            nodosSeleccionados = nodosSeleccionados.filter(u => u !== uid);
          }
          renderNodos();
          renderPreview();
        });
      });
    };

    const calcularAsignaciones = () => {
      const r = rangos.rangos[trenSel];
      if (!r) return [];
      const asign = [];
      let surcoActual = r.inicio;

      for (const uid of nodosSeleccionados) {
        const nodo = this.nodos.find(n => n.uid === uid);
        if (!nodo) continue;
        const cap = nodo.capacidad_cables || 8;
        for (let c = 0; c < cap; c++) {
          if (surcoActual > r.fin) break;

          // Verificar si el cable ya está ocupado por otro tipo
          const cableOcupado = this.sensores.find(s =>
            s.is_active !== false && s.uid === uid && parseInt(s.cable) === c
          );

          // Verificar si el surco ya tiene sensor en ese tren
          const surcoOcupado = this.sensores.find(s =>
            s.is_active !== false &&
            TIPOS_SIEMBRA.includes(s.tipo) &&
            String(s.tren) === String(trenSel) &&
            parseInt(s.bajada) === surcoActual
          );

          let estado = "ok";
          if (cableOcupado) estado = "cable_ocupado";
          else if (surcoOcupado && !sobrescribir) estado = "surco_ocupado";

          asign.push({
            uid, cable: c,
            tren: trenSel, bajada: surcoActual,
            estado,
          });
          surcoActual++;
        }
        if (surcoActual > r.fin) break;
      }
      return asign;
    };

    const renderPreview = () => {
      const asign = calcularAsignaciones();
      const cont = $("#w-preview");
      if (asign.length === 0) {
        cont.innerHTML = `<div style="color:var(--ap-text-dim);text-align:center;padding:16px;">
          Seleccioná al menos un nodo para ver el preview
        </div>`;
        return;
      }

      const r = rangos.rangos[trenSel];
      const ok = asign.filter(a => a.estado === "ok").length;
      const conflictos = asign.filter(a => a.estado !== "ok").length;
      const faltan = r.surcos - asign.length;

      cont.innerHTML = `
        <div class="wizard-preview-head">
          <i class="fas fa-eye"></i> Preview
          <span class="wiz-stat ok">${ok} OK</span>
          ${conflictos > 0 ? `<span class="wiz-stat err">${conflictos} conflictos</span>` : ""}
          ${faltan > 0 ? `<span class="wiz-stat warn">${faltan} sin asignar</span>` : ""}
        </div>
        <div class="wizard-preview-list">
          ${asign.map(a => `
            <div class="wiz-asig ${a.estado}">
              <span class="wiz-surco">S${a.bajada}</span>
              <span class="wiz-uid">${this._esc(a.uid.slice(-6))}</span>
              <span class="wiz-cable">c${a.cable}</span>
              ${a.estado === "cable_ocupado" ? `<i class="fas fa-xmark" title="Cable ocupado"></i>` : ""}
              ${a.estado === "surco_ocupado" ? `<i class="fas fa-triangle-exclamation" title="Surco ocupado"></i>` : ""}
            </div>
          `).join("")}
        </div>
      `;
    };

    $("#w-tren").addEventListener("change", e => { trenSel = e.target.value; renderPreview(); });
    $("#w-tipo").addEventListener("change", e => { tipoSel = e.target.value; renderPreview(); });
    $("#w-sobrescribir").addEventListener("change", e => { sobrescribir = e.target.checked; renderPreview(); });

    $("#w-cancel").onclick = close;
    $("#w-ok").onclick = () => {
      const asign = calcularAsignaciones();
      const aplicables = asign.filter(a => a.estado === "ok" || (a.estado === "surco_ocupado" && sobrescribir));
      if (aplicables.length === 0) {
        $("#w-error").textContent = "No hay asignaciones aplicables. Revisá conflictos.";
        return;
      }

      for (const a of aplicables) {
        // Si sobrescribimos, primero quitar el sensor del surco
        if (sobrescribir) {
          this.sensores.forEach(s => {
            if (s.is_active !== false &&
                TIPOS_SIEMBRA.includes(s.tipo) &&
                String(s.tren) === String(a.tren) &&
                parseInt(s.bajada) === a.bajada) {
              s.is_active = false;
            }
          });
        }

        this.sensores.push({
          uid: a.uid,
          cable: a.cable,
          tipo: tipoSel,
          tren: a.tren,
          bajada: a.bajada,
          nombre: "",
          is_active: true,
        });
      }

      this._marcarDirty();
      this._renderVista();
      this._actualizarContadores();
      close();
      this._toast(`${aplicables.length} sensores asignados automáticamente`);
    };

    renderNodos();
    renderPreview();
  }

  // ── Guardado ──────────────────────────────────────────────

  _marcarDirty() {
    this._dirty = true;
    const btn = this.container.querySelector("#btn-sens-guardar");
    if (btn) btn.disabled = false;
  }

  recolectar() {
    return { mapeo_sensores: this.sensores };
  }

  async _guardar() {
    try {
      await this.parent.guardarPerfil();
      this._dirty = false;
      this.container.querySelector("#btn-sens-guardar").disabled = true;
      this._toast("Sensores guardados");
      // Refrescar desde el perfil recargado
      this.sensores = this._clonar(this.parent.perfil?.mapeo_sensores || []);
      this._renderVista();
      this._actualizarContadores();
    } catch (e) {
      this._toast("Error al guardar: " + e.message, "error");
    }
  }

  // ════════════════════════════════════════════════════════════
  // COMMIT 6.1 — Override de sonidos por sensor individual
  // ════════════════════════════════════════════════════════════

  /**
   * Abre el sub-modal de override de sonidos para un sensor.
   * Lee y escribe en this.perfil.ui.sonidos.por_sensor[uid_cable].
   */
  _abrirOverrideSonido(sensor) {
    if (!sensor) return;

    // Asegurar que la estructura exista en perfil.ui.sonidos
    if (!this.perfil.ui) this.perfil.ui = {};
    if (!this.perfil.ui.sonidos) this.perfil.ui.sonidos = {};
    if (!this.perfil.ui.sonidos.por_sensor) this.perfil.ui.sonidos.por_sensor = {};

    const key = window.vistaxKeyOverride(sensor.uid, sensor.cable);
    const eventosTipo = window.VISTAX_EVENTOS_POR_TIPO?.[sensor.tipo] || [];

    if (eventosTipo.length === 0) {
      this._toast("Este tipo de sensor no tiene eventos sonoros", "warn");
      return;
    }

    // Override actual (puede ser undefined si nunca se configuró)
    const overrideActual = this.perfil.ui.sonidos.por_sensor[key] || {};
    // Buffer local — modificamos esto y al confirmar lo persistimos
    const buffer = JSON.parse(JSON.stringify(overrideActual));

    // Cargar archivos de audio para los dropdowns
    this._cargarAudiosParaOverride().then(archivos => {
      this._renderModalOverride(sensor, key, buffer, eventosTipo, archivos);
    });
  }

  async _cargarAudiosParaOverride() {
    try {
      const r = await fetch("/api/audio/archivos");
      const data = await r.json();
      return data.archivos || [];
    } catch (e) {
      return [];
    }
  }

  _renderModalOverride(sensor, key, buffer, eventos, archivos) {
    // Defaults heredados del tipo (para mostrar de comparación)
    const defaultsTipo = this.perfil?.ui?.sonidos?.por_tipo?.[sensor.tipo] || {};

    const overlay = document.createElement("div");
    overlay.className = "cfg-prompt-overlay";
    overlay.innerHTML = `
      <div class="cfg-prompt" style="min-width: 600px; max-width: 720px;">
        <h3>
          <i class="fas fa-music"></i>
          Override de sonido
          <span style="font-size: 12px; color: var(--ap-text-muted); font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 10px;">
            ${this._esc(sensor.uid)} cable ${sensor.cable}
          </span>
        </h3>

        <div class="info-box" style="margin-bottom: 16px;">
          <i class="fas fa-info-circle"></i>
          <span>
            Por defecto este sensor usa la configuración del tipo
            <strong>${this._esc(sensor.tipo)}</strong>. Acá podés definir
            sonidos distintos solo para este sensor sin afectar a los demás.
          </span>
        </div>

        <!-- Mute individual -->
        <div class="override-mute-row">
          <label class="switch">
            <input type="checkbox" id="ov-mute" ${buffer.mute ? "checked" : ""} />
            <span class="slider"></span>
          </label>
          <div>
            <strong>Silenciar este sensor por completo</strong>
            <span>No suena nada para este sensor, sin importar el evento</span>
          </div>
        </div>

        <!-- Eventos del tipo -->
        <div class="override-eventos">
          ${eventos.map(ev => this._renderOverrideEvento(ev, buffer, defaultsTipo, archivos)).join("")}
        </div>

        <div class="actions" style="margin-top: 18px;">
          ${Object.keys(buffer).length > 0 || buffer.mute !== undefined ? `
            <button class="btn btn-danger" id="ov-reset">
              <i class="fas fa-rotate-left"></i> Quitar overrides
            </button>
          ` : ""}
          <div style="flex: 1;"></div>
          <button class="btn btn-ghost" id="ov-cancel">Cancelar</button>
          <button class="btn btn-primary" id="ov-ok">
            <i class="fas fa-check"></i> Aplicar
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const $ = sel => overlay.querySelector(sel);
    const close = () => overlay.remove();

    // Mute toggle
    $("#ov-mute").addEventListener("change", e => {
      buffer.mute = e.target.checked;
    });

    // Wire de cada evento
    overlay.querySelectorAll(".override-evento").forEach(row => {
      const evId = row.dataset.ev;
      const enabledChk = row.querySelector(".ov-ev-enabled");
      const archivoSel = row.querySelector("select.ov-ev-archivo");
      const volRange = row.querySelector(".ov-ev-vol");
      const volVal = row.querySelector(".ov-ev-vol-val");
      const testBtn = row.querySelector(".ov-ev-test");

      const sincronizarRow = () => {
        const activo = enabledChk.checked;
        row.classList.toggle("active", activo);
        archivoSel.disabled = !activo;
        volRange.disabled = !activo;
        testBtn.disabled = !activo;
      };

      enabledChk.addEventListener("change", () => {
        if (enabledChk.checked) {
          // Activar override → copiar valores actuales del archivo/volumen visibles
          buffer[evId] = {
            archivo: archivoSel.value,
            volumen: parseInt(volRange.value),
          };
        } else {
          // Desactivar → quitar override (vuelve a heredar del tipo)
          delete buffer[evId];
        }
        sincronizarRow();
      });

      archivoSel.addEventListener("change", () => {
        if (buffer[evId]) buffer[evId].archivo = archivoSel.value;
      });

      volRange.addEventListener("input", () => {
        volVal.textContent = volRange.value + "%";
        if (buffer[evId]) buffer[evId].volumen = parseInt(volRange.value);
      });

      testBtn.addEventListener("click", () => {
        this._previewSonido(archivoSel.value, parseInt(volRange.value));
      });
    });

    // Quitar todos los overrides de este sensor
    overlay.querySelector("#ov-reset")?.addEventListener("click", () => {
      delete this.perfil.ui.sonidos.por_sensor[key];
      this._marcarDirty();
      close();
      this._toast("Overrides eliminados — vuelve a heredar del tipo");
    });

    $("#ov-cancel").onclick = close;

    $("#ov-ok").onclick = () => {
      // Limpiar buffer: si solo tiene mute=false y nada más, no guardamos nada
      const tieneOverrides = Object.keys(buffer).some(k => k !== "mute") || buffer.mute === true;

      if (tieneOverrides) {
        this.perfil.ui.sonidos.por_sensor[key] = buffer;
      } else {
        // Buffer vacío → borrar la entrada para mantener el JSON limpio
        delete this.perfil.ui.sonidos.por_sensor[key];
      }

      this._marcarDirty();
      close();
      this._toast("Override aplicado — recordá guardar el perfil");
    };
  }

  _renderOverrideEvento(ev, buffer, defaultsTipo, archivos) {
    const tieneOverride = !!buffer[ev.id];
    const defTipo = defaultsTipo[ev.id] || { archivo: "alarma.mp3", volumen: 80 };
    const archivoActual = tieneOverride ? buffer[ev.id].archivo : defTipo.archivo;
    const volActual = tieneOverride ? buffer[ev.id].volumen : defTipo.volumen;

    const opcionesArchivo = archivos.length > 0
      ? archivos
      : [{ nombre: archivoActual }];

    return `
      <div class="override-evento ${tieneOverride ? "active" : ""}" data-ev="${ev.id}">
        <div class="ov-ev-toggle">
          <label class="switch">
            <input type="checkbox" class="ov-ev-enabled" ${tieneOverride ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="ov-ev-info">
          <strong>${this._esc(ev.label)}</strong>
          <span>${tieneOverride
            ? `<i class="fas fa-pen" style="color: var(--ap-green); font-size: 9px;"></i> Override activo`
            : `<i class="fas fa-link" style="color: var(--ap-text-dim); font-size: 9px;"></i> Hereda del tipo: ${this._esc(defTipo.archivo)} (${defTipo.volumen}%)`
          }</span>
        </div>
        <div class="ov-ev-archivo">
          <select class="ov-ev-archivo" ${tieneOverride ? "" : "disabled"}>
            ${opcionesArchivo.map(a => `
              <option value="${this._esc(a.nombre)}" ${a.nombre === archivoActual ? "selected" : ""}>
                ${this._esc(a.nombre)}
              </option>
            `).join("")}
          </select>
        </div>
        <div class="ov-ev-volumen">
          <input type="range" class="ov-ev-vol" min="0" max="100" value="${volActual}"
                 ${tieneOverride ? "" : "disabled"} />
          <span class="ov-ev-vol-val">${volActual}%</span>
        </div>
        <div class="ov-ev-acciones">
          <button class="ov-ev-test btn-icon-sm" title="Probar" ${tieneOverride ? "" : "disabled"}>
            <i class="fas fa-play"></i>
          </button>
        </div>
      </div>
    `;
  }

  _previewSonido(archivo, volumen) {
    if (!archivo) return;
    if (this._audioPreview) {
      try { this._audioPreview.pause(); } catch {}
    }
    try {
      this._audioPreview = new Audio(`/audio/${encodeURIComponent(archivo)}`);
      this._audioPreview.volume = Math.max(0, Math.min(1, (volumen || 80) / 100));
      this._audioPreview.play().catch(err => {
        this._toast(`No se pudo reproducir: ${err.message}`, "error");
      });
    } catch (e) {
      this._toast("Error al reproducir: " + e.message, "error");
    }
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}

window.TabSensores = TabSensores;
