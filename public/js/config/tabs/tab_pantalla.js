// ============================================================
// VistaX — tab_pantalla.js  (v3.0)
//
// Tab "Pantalla y Sonidos": configuración de UI y audio.
//
// Estructura en perfil.ui:
//   {
//     tema: "dark",
//     tamano_fuente: "normal" | "chico" | "grande",
//     sonidos: {
//       master_mute, master_volumen,
//       globales: { evento: {enabled, archivo, volumen} },
//       por_tipo: { tipo: {mute, evento: {enabled, archivo, volumen}} },
//       por_sensor: { uid_cable: {mute, evento: {archivo, volumen}} }   // overrides
//     }
//   }
//
// Sub-vistas:
//   1. Pantalla       — tema, tamaño de fuente
//   2. Master         — mute total + volumen general
//   3. Globales       — un sonido por evento del sistema
//   4. Por tipo       — acordeón con cada tipo de sensor
//
// Los overrides POR SENSOR INDIVIDUAL se editan desde el Tab Sensores
// (modal del sensor → botón "Override sonido"). Acá solo se ven contados.
// ============================================================

// ── Catálogo de eventos del sistema ────────────────────────
const EVENTOS_GLOBALES = [
  { id: "nodo_offline",   label: "Nodo sin reportar",    icon: "fa-plug-circle-xmark", desc: "Un nodo no envía heartbeat por más de 30s" },
  { id: "aog_perdido",    label: "AgOpenGPS desconectado", icon: "fa-satellite-dish",  desc: "No llega telemetría del bridge CoreX" },
  { id: "lote_inicio",    label: "Lote auto-iniciado",   icon: "fa-circle-play",       desc: "Confirmación al arrancar un lote" },
  { id: "lote_cierre",    label: "Lote auto-cerrado",    icon: "fa-circle-stop",       desc: "Confirmación al cerrar un lote" },
  { id: "velocidad_alta", label: "Velocidad excedida",   icon: "fa-gauge-high",        desc: "Velocidad por encima del máximo configurado" },
];

const TIPOS_CON_EVENTOS = [
  {
    tipo: "semilla", label: "Semilla", icon: "fa-seedling",
    eventos: [
      { id: "tapado",         label: "Tubo tapado",      desc: "No se detectan semillas con velocidad > mínima" },
      { id: "fuera_de_dosis", label: "Fuera de dosis",   desc: "Densidad real por debajo de (objetivo × tolerancia)" },
    ],
  },
  {
    tipo: "ferti_linea", label: "Fertilizante línea", icon: "fa-droplet",
    eventos: [
      { id: "tapado",         label: "Línea tapada",     desc: "Sin pulsos con velocidad > mínima" },
      { id: "fuera_de_dosis", label: "Fuera de dosis",   desc: "Caudal por debajo del esperado" },
    ],
  },
  {
    tipo: "ferti_costado", label: "Fertilizante costado", icon: "fa-droplet",
    eventos: [
      { id: "tapado",         label: "Tapado",           desc: "Sin pulsos con velocidad > mínima" },
      { id: "fuera_de_dosis", label: "Fuera de dosis",   desc: "Caudal por debajo del esperado" },
    ],
  },
  {
    tipo: "turbina", label: "Turbina", icon: "fa-fan",
    eventos: [
      { id: "rpm_fuera_rango", label: "RPM fuera de rango", desc: "RPM fuera del rango configurado en Monitoreo" },
      { id: "detenida",        label: "Detenida",          desc: "Sin pulsos con velocidad > mínima" },
    ],
  },
  {
    tipo: "rotacion_eje", label: "Rotación de eje", icon: "fa-arrows-spin",
    eventos: [
      { id: "detenido", label: "Eje detenido", desc: "Sin pulsos con velocidad > mínima" },
    ],
  },
  {
    tipo: "tolva_vacia", label: "Tolva vacía", icon: "fa-box-open",
    eventos: [
      { id: "activacion", label: "Tolva se vacía", desc: "Cambio a estado vacío" },
    ],
  },
  {
    tipo: "tolva_llena", label: "Tolva llena", icon: "fa-box",
    eventos: [
      { id: "activacion", label: "Tolva se llena", desc: "Cambio a estado lleno" },
    ],
  },
];

// Defaults razonables para cada evento
function _defEvento(archivo = "alarma.mp3", vol = 80, enabled = true) {
  return { enabled, archivo, volumen: vol };
}

const DEFAULTS_GLOBALES = {
  nodo_offline:   _defEvento("alerta_grave.mp3", 90),
  aog_perdido:    _defEvento("alerta_grave.mp3", 90),
  lote_inicio:    _defEvento("beep_corto.mp3",   60),
  lote_cierre:    _defEvento("beep_corto.mp3",   60),
  velocidad_alta: _defEvento("alerta_media.mp3", 80),
};

const DEFAULTS_POR_TIPO = {
  semilla: {
    mute: false,
    tapado:         _defEvento("alarma.mp3",       100),
    fuera_de_dosis: _defEvento("alerta_media.mp3", 80),
  },
  ferti_linea: {
    mute: false,
    tapado:         _defEvento("alarma.mp3",       100),
    fuera_de_dosis: _defEvento("alerta_media.mp3", 80),
  },
  ferti_costado: {
    mute: false,
    tapado:         _defEvento("alarma.mp3",       100),
    fuera_de_dosis: _defEvento("alerta_media.mp3", 80),
  },
  turbina: {
    mute: false,
    rpm_fuera_rango: _defEvento("alerta_media.mp3", 80),
    detenida:        _defEvento("alarma.mp3",       100),
  },
  rotacion_eje: {
    mute: false,
    detenido: _defEvento("alarma.mp3", 100),
  },
  tolva_vacia: {
    mute: false,
    activacion: _defEvento("alerta_media.mp3", 80),
  },
  tolva_llena: {
    mute: false,
    activacion: _defEvento("alerta_media.mp3", 80),
  },
};

// ════════════════════════════════════════════════════════════
class TabPantalla extends TabBase {
  constructor(opts) {
    super(opts);
    this.ui       = this._inicializar(this.perfil?.ui || {});
    this.archivos = []; // se carga del backend
    this.vista    = "master";
    this._dirty   = false;
    this._audioPlayer = null; // para previews de sonido
  }

  _inicializar(src) {
    const sonidos = src.sonidos || {};

    // Globales: completar con defaults los que falten
    const globales = {};
    for (const ev of EVENTOS_GLOBALES) {
      globales[ev.id] = { ...DEFAULTS_GLOBALES[ev.id], ...(sonidos.globales?.[ev.id] || {}) };
    }

    // Por tipo: completar con defaults
    const porTipo = {};
    for (const t of TIPOS_CON_EVENTOS) {
      const guardado = sonidos.por_tipo?.[t.tipo] || {};
      porTipo[t.tipo] = { mute: !!guardado.mute };
      for (const ev of t.eventos) {
        porTipo[t.tipo][ev.id] = {
          ...DEFAULTS_POR_TIPO[t.tipo][ev.id],
          ...(guardado[ev.id] || {}),
        };
      }
    }

    return {
      tema:           src.tema           || "dark",
      tamano_fuente:  src.tamano_fuente  || "normal",
      sonidos: {
        master_mute:    !!sonidos.master_mute,
        master_volumen: sonidos.master_volumen ?? 80,
        globales,
        por_tipo:   porTipo,
        por_sensor: sonidos.por_sensor || {},  // overrides individuales (preservar)
      },
    };
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-volume-high"></i>
          Pantalla y Sonidos
          <span class="tab-subtitle">
            Apariencia del monitor y configuración de alertas sonoras por evento
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn btn-primary" id="btn-pant-guardar" disabled>
            <i class="fas fa-check"></i> Guardar
          </button>
        </div>
      </div>

      <div class="sens-subtabs">
        <button class="sens-subtab" data-vista="pantalla">
          <i class="fas fa-display"></i> Pantalla
        </button>
        <button class="sens-subtab active" data-vista="master">
          <i class="fas fa-volume-high"></i> Master
        </button>
        <button class="sens-subtab" data-vista="globales">
          <i class="fas fa-globe"></i> Eventos globales
          <span class="count">${EVENTOS_GLOBALES.length}</span>
        </button>
        <button class="sens-subtab" data-vista="tipos">
          <i class="fas fa-broadcast-tower"></i> Por tipo de sensor
          <span class="count">${TIPOS_CON_EVENTOS.length}</span>
        </button>
      </div>

      <div id="pant-content">
        <div class="cfg-loading">
          <i class="fas fa-circle-notch fa-spin"></i>
          <span>Cargando archivos de audio...</span>
        </div>
      </div>
    `;

    container.querySelector("#btn-pant-guardar")
      .addEventListener("click", () => this._guardar());

    container.querySelectorAll(".sens-subtab").forEach(btn => {
      btn.addEventListener("click", () => {
        this.vista = btn.dataset.vista;
        container.querySelectorAll(".sens-subtab").forEach(b =>
          b.classList.toggle("active", b === btn)
        );
        this._renderVista();
      });
    });

    await this._cargarArchivos();
    this._renderVista();
  }

  destroy() {
    this._stopPreview();
    super.destroy();
  }

  async _cargarArchivos() {
    try {
      const r = await fetch("/api/audio/archivos");
      const data = await r.json();
      this.archivos = data.archivos || [];
    } catch (e) {
      console.error("[TabPantalla] Error cargando audios:", e);
      this.archivos = [];
    }
  }

  // ── Render por vista ──────────────────────────────────────

  _renderVista() {
    const cont = this.container.querySelector("#pant-content");
    if (this.vista === "pantalla") return this._renderPantalla(cont);
    if (this.vista === "master")   return this._renderMaster(cont);
    if (this.vista === "globales") return this._renderGlobales(cont);
    if (this.vista === "tipos")    return this._renderTipos(cont);
  }

  // ── Vista: Pantalla ───────────────────────────────────────

  _renderPantalla(cont) {
    const fuentes = [
      { id: "chico",   label: "Chico",   desc: "Para pantallas grandes en cabina" },
      { id: "normal",  label: "Normal",  desc: "Tamaño por defecto" },
      { id: "grande",  label: "Grande",  desc: "Para tablets a distancia" },
    ];

    cont.innerHTML = `
      <div class="mon-grid">
        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-display"></i>
            <div>
              <h3>Tema visual</h3>
              <p>Por ahora solo está disponible el tema oscuro</p>
            </div>
          </div>
          <div class="form-field full">
            <label>Tema</label>
            <select id="f-tema" disabled>
              <option value="dark" selected>Oscuro (Agro Parallel)</option>
            </select>
            <span class="field-help">El tema claro se va a sumar en una próxima versión</span>
          </div>
        </div>

        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-text-height"></i>
            <div>
              <h3>Tamaño de fuente</h3>
              <p>Afecta el monitor principal y la barra superior</p>
            </div>
          </div>
          <div class="form-field full">
            <label>Tamaño</label>
            <div class="radio-cards">
              ${fuentes.map(f => `
                <label class="radio-card ${this.ui.tamano_fuente === f.id ? "selected" : ""}">
                  <input type="radio" name="fuente" value="${f.id}" ${this.ui.tamano_fuente === f.id ? "checked" : ""} />
                  <div class="radio-card-icon">
                    <span style="font-size: ${f.id === "chico" ? "12" : f.id === "grande" ? "22" : "16"}px;">Aa</span>
                  </div>
                  <div class="radio-card-body">
                    <strong>${f.label}</strong>
                    <span>${f.desc}</span>
                  </div>
                </label>
              `).join("")}
            </div>
          </div>
        </div>
      </div>
    `;

    cont.querySelectorAll('input[name="fuente"]').forEach(r => {
      r.addEventListener("change", () => {
        this.ui.tamano_fuente = r.value;
        cont.querySelectorAll(".radio-card").forEach(c => {
          c.classList.toggle("selected", c.querySelector("input").checked);
        });
        this._marcarDirty();
      });
    });
  }

  // ── Vista: Master ─────────────────────────────────────────

  _renderMaster(cont) {
    const s = this.ui.sonidos;

    cont.innerHTML = `
      <div class="mon-grid">
        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-volume-${s.master_mute ? "xmark" : "high"}"></i>
            <div>
              <h3>Control maestro</h3>
              <p>Silencia todas las alarmas o ajusta el volumen general del sistema</p>
            </div>
          </div>

          <div class="master-control">
            <button class="master-mute-btn ${s.master_mute ? "muted" : ""}" id="btn-master-mute">
              <i class="fas fa-volume-${s.master_mute ? "xmark" : "high"}"></i>
              <span>${s.master_mute ? "TODO MUTEADO" : "SONIDO ACTIVO"}</span>
            </button>

            <div class="master-volumen ${s.master_mute ? "disabled" : ""}">
              <div class="vol-label">
                Volumen general
                <strong id="vol-master-val">${s.master_volumen}%</strong>
              </div>
              <input type="range" min="0" max="100" value="${s.master_volumen}"
                     id="vol-master" ${s.master_mute ? "disabled" : ""} />
            </div>
          </div>

          <div class="info-box" style="margin-top: 18px;">
            <i class="fas fa-info-circle"></i>
            <span>
              El control maestro afecta a todos los sonidos del sistema, sin importar
              su configuración individual. Es el botón de "pánico" para silenciar
              rápido durante una llamada o reunión en cabina.
            </span>
          </div>
        </div>

        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-sliders"></i>
            <div>
              <h3>Resumen de configuración</h3>
              <p>Vista rápida de qué eventos están activos</p>
            </div>
          </div>

          <div class="resumen-stats">
            ${this._renderResumen()}
          </div>
        </div>
      </div>
    `;

    cont.querySelector("#btn-master-mute").addEventListener("click", () => {
      this.ui.sonidos.master_mute = !this.ui.sonidos.master_mute;
      this._marcarDirty();
      this._renderMaster(cont);
    });

    const vol = cont.querySelector("#vol-master");
    vol.addEventListener("input", () => {
      this.ui.sonidos.master_volumen = parseInt(vol.value);
      cont.querySelector("#vol-master-val").textContent = vol.value + "%";
      this._marcarDirty();
    });
  }

  _renderResumen() {
    const s = this.ui.sonidos;
    const globalesActivos = EVENTOS_GLOBALES.filter(e => s.globales[e.id]?.enabled).length;
    const tiposMuteados = Object.values(s.por_tipo).filter(t => t.mute).length;
    const overrides = Object.keys(s.por_sensor || {}).length;

    return `
      <div class="resumen-stat">
        <i class="fas fa-globe"></i>
        <div>
          <strong>${globalesActivos}/${EVENTOS_GLOBALES.length}</strong>
          <span>Eventos globales activos</span>
        </div>
      </div>
      <div class="resumen-stat">
        <i class="fas fa-volume-xmark"></i>
        <div>
          <strong>${tiposMuteados}/${TIPOS_CON_EVENTOS.length}</strong>
          <span>Tipos de sensor muteados</span>
        </div>
      </div>
      <div class="resumen-stat">
        <i class="fas fa-wrench"></i>
        <div>
          <strong>${overrides}</strong>
          <span>Sensores con override individual</span>
        </div>
      </div>
    `;
  }

  // ── Vista: Eventos globales ───────────────────────────────

  _renderGlobales(cont) {
    cont.innerHTML = `
      <div class="info-box">
        <i class="fas fa-globe"></i>
        <span>
          Estos sonidos se disparan independientemente de los sensores: estado del sistema,
          conexión con AOG, inicio/cierre de lotes, etc.
        </span>
      </div>

      <div class="evento-list">
        ${EVENTOS_GLOBALES.map(ev => this._renderEventoFila(ev, this.ui.sonidos.globales[ev.id], "globales", ev.id)).join("")}
      </div>
    `;

    this._wireEventos(cont);
  }

  // ── Vista: Por tipo de sensor ─────────────────────────────

  _renderTipos(cont) {
    cont.innerHTML = `
      <div class="info-box">
        <i class="fas fa-info-circle"></i>
        <span>
          Cada tipo de sensor tiene sus propios eventos. Si muteás un tipo entero, ningún
          sensor de ese tipo va a sonar — útil cuando estás probando solo una parte de la máquina.
          Para overrides por sensor individual, editá el sensor desde el tab Sensores.
        </span>
      </div>

      <div class="acordeon-list">
        ${TIPOS_CON_EVENTOS.map(t => this._renderTipoAcordeon(t)).join("")}
      </div>
    `;

    // Toggle de mute por tipo
    cont.querySelectorAll(".tipo-mute-toggle").forEach(toggle => {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const tipo = toggle.dataset.tipo;
        this.ui.sonidos.por_tipo[tipo].mute = !this.ui.sonidos.por_tipo[tipo].mute;
        this._marcarDirty();
        this._renderTipos(cont);
      });
    });

    // Expandir/contraer cada acordeón
    cont.querySelectorAll(".acordeon-head").forEach(head => {
      head.addEventListener("click", () => {
        const card = head.closest(".acordeon-card");
        card.classList.toggle("open");
      });
    });

    this._wireEventos(cont);
  }

  _renderTipoAcordeon(t) {
    const cfg = this.ui.sonidos.por_tipo[t.tipo];
    return `
      <div class="acordeon-card ${cfg.mute ? "muted" : ""}">
        <div class="acordeon-head">
          <div class="acordeon-icon"><i class="fas ${t.icon}"></i></div>
          <div class="acordeon-title">
            <strong>${t.label}</strong>
            <span>${t.eventos.length} evento${t.eventos.length === 1 ? "" : "s"}</span>
          </div>
          <button class="tipo-mute-toggle ${cfg.mute ? "active" : ""}" data-tipo="${t.tipo}"
                  title="${cfg.mute ? "Desmutear" : "Mutear este tipo"}">
            <i class="fas fa-volume-${cfg.mute ? "xmark" : "high"}"></i>
          </button>
          <i class="fas fa-chevron-down acordeon-chevron"></i>
        </div>
        <div class="acordeon-body">
          <div class="evento-list">
            ${t.eventos.map(ev => this._renderEventoFila(ev, cfg[ev.id], `por_tipo.${t.tipo}`, ev.id)).join("")}
          </div>
        </div>
      </div>
    `;
  }

  // ── Fila de evento (la unidad atómica del tab) ────────────

  _renderEventoFila(ev, cfg, ruta, evId) {
    if (!cfg) cfg = { enabled: true, archivo: "alarma.mp3", volumen: 80 };
    const archivos = this.archivos.length > 0 ? this.archivos : [{ nombre: cfg.archivo }];

    return `
      <div class="evento-fila ${cfg.enabled ? "" : "disabled"}" data-ruta="${ruta}" data-ev="${evId}">
        <div class="evento-toggle">
          <label class="switch">
            <input type="checkbox" class="ev-enabled" ${cfg.enabled ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>

        <div class="evento-info">
          <div class="evento-label">
            <i class="fas ${ev.icon || "fa-bell"}"></i>
            <strong>${ev.label}</strong>
          </div>
          <div class="evento-desc">${ev.desc || ""}</div>
        </div>

        <div class="evento-archivo">
          <select class="ev-archivo" ${cfg.enabled ? "" : "disabled"}>
            ${archivos.map(a => `
              <option value="${this._esc(a.nombre)}" ${a.nombre === cfg.archivo ? "selected" : ""}>
                ${this._esc(a.nombre)}
              </option>
            `).join("")}
          </select>
        </div>

        <div class="evento-volumen">
          <input type="range" class="ev-vol" min="0" max="100" value="${cfg.volumen}"
                 ${cfg.enabled ? "" : "disabled"} />
          <span class="ev-vol-val">${cfg.volumen}%</span>
        </div>

        <div class="evento-acciones">
          <button class="ev-test btn-icon-sm" title="Probar sonido" ${cfg.enabled ? "" : "disabled"}>
            <i class="fas fa-play"></i>
          </button>
        </div>
      </div>
    `;
  }

  _wireEventos(cont) {
    cont.querySelectorAll(".evento-fila").forEach(fila => {
      const ruta = fila.dataset.ruta;
      const ev = fila.dataset.ev;
      const ref = this._refPorRuta(ruta, ev);
      if (!ref) return;

      // Enabled
      fila.querySelector(".ev-enabled").addEventListener("change", (e) => {
        ref.enabled = e.target.checked;
        this._marcarDirty();
        // Re-render solo esta fila para actualizar disabled visual
        this._actualizarFila(fila, ref);
      });

      // Archivo
      fila.querySelector(".ev-archivo").addEventListener("change", (e) => {
        ref.archivo = e.target.value;
        this._marcarDirty();
      });

      // Volumen
      const vol = fila.querySelector(".ev-vol");
      const valEl = fila.querySelector(".ev-vol-val");
      vol.addEventListener("input", () => {
        ref.volumen = parseInt(vol.value);
        valEl.textContent = vol.value + "%";
        this._marcarDirty();
      });

      // Test
      fila.querySelector(".ev-test").addEventListener("click", () => {
        this._previewSonido(ref.archivo, ref.volumen);
      });
    });
  }

  _refPorRuta(ruta, evId) {
    // ruta: "globales" | "por_tipo.semilla"
    if (ruta === "globales") return this.ui.sonidos.globales[evId];
    if (ruta.startsWith("por_tipo.")) {
      const tipo = ruta.split(".")[1];
      return this.ui.sonidos.por_tipo[tipo]?.[evId];
    }
    return null;
  }

  _actualizarFila(fila, ref) {
    fila.classList.toggle("disabled", !ref.enabled);
    fila.querySelector(".ev-archivo").disabled = !ref.enabled;
    fila.querySelector(".ev-vol").disabled = !ref.enabled;
    fila.querySelector(".ev-test").disabled = !ref.enabled;
  }

  // ── Preview de audio ──────────────────────────────────────

  _previewSonido(archivo, volumen) {
    this._stopPreview();
    if (!archivo) {
      this._toast("Sin archivo seleccionado", "warn");
      return;
    }
    try {
      this._audioPlayer = new Audio(`/audio/${encodeURIComponent(archivo)}`);
      this._audioPlayer.volume = Math.max(0, Math.min(1, (volumen || 80) / 100));
      this._audioPlayer.play().catch(err => {
        this._toast(`No se pudo reproducir: ${err.message}`, "error");
      });
    } catch (e) {
      this._toast("Error al reproducir: " + e.message, "error");
    }
  }

  _stopPreview() {
    if (this._audioPlayer) {
      try { this._audioPlayer.pause(); } catch {}
      this._audioPlayer = null;
    }
  }

  // ── Guardado ──────────────────────────────────────────────

  _marcarDirty() {
    this._dirty = true;
    const btn = this.container.querySelector("#btn-pant-guardar");
    if (btn) btn.disabled = false;
  }

  recolectar() {
    return { ui: this.ui };
  }

  async _guardar() {
    try {
      await this.parent.guardarPerfil();
      this._dirty = false;
      this.container.querySelector("#btn-pant-guardar").disabled = true;
      this._toast("Pantalla y sonidos guardados");
      this.ui = this._inicializar(this.parent.perfil?.ui || {});
    } catch (e) {
      this._toast("Error al guardar: " + e.message, "error");
    }
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}

window.TabPantalla = TabPantalla;
