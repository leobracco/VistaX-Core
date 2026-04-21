// ============================================================
// VistaX — tab_monitoreo.js  (v3.0)
//
// Tab "Monitoreo": parámetros operativos del perfil (perfil.setup).
//
// Secciones:
//   1. Modo de monitoreo  → cuándo arrancar a monitorear
//   2. Geometría           → distancia entre surcos, densidad objetivo
//   3. Velocidad           → min/max para alarmas
//   4. Alarmas             → tiempos, tolerancias
//   5. Turbina (opcional)  → RPM mín/máx
// ============================================================

class TabMonitoreo extends TabBase {
  constructor(opts) {
    super(opts);
    this.setup  = this._inicializar(this.perfil?.setup || {});
    this._dirty = false;
  }

  /**
   * Aplica defaults para campos que pueden no existir en perfiles viejos.
   * Esto evita que el form muestre valores undefined.
   */
  _inicializar(src) {
    return {
      // Modo de monitoreo (NUEVOS)
      modo_monitoreo:           src.modo_monitoreo           ?? "semilla",
      surcos_minimos_monitoreo: src.surcos_minimos_monitoreo ?? 1,
      velocidad_min_monitoreo:  src.velocidad_min_monitoreo  ?? 1.5,

      // Geometría
      distancia_entre_surcos: src.distancia_entre_surcos ?? 0.525,
      densidad_objetivo:      src.densidad_objetivo      ?? 5.2,
      tolerancia_desvio:      src.tolerancia_desvio      ?? 20,

      // Velocidad
      velocidad_max: src.velocidad_max ?? 8.5,

      // Alarmas
      alarma_tiempo_seg: src.alarma_tiempo_seg ?? 2,

      // Turbina
      rpm_min: src.rpm_min ?? 2000,
      rpm_max: src.rpm_max ?? 5000,

      // Tolvas (existente)
      tolvas: src.tolvas ?? 2,

      // Conservar campos desconocidos del setup original
      ...Object.fromEntries(
        Object.entries(src).filter(([k]) => ![
          "modo_monitoreo", "surcos_minimos_monitoreo", "velocidad_min_monitoreo",
          "distancia_entre_surcos", "densidad_objetivo", "tolerancia_desvio",
          "velocidad_max", "alarma_tiempo_seg", "rpm_min", "rpm_max", "tolvas",
          "objetivos_tren",
        ].includes(k))
      ),

      // Conservar objetivos por tren si existen
      objetivos_tren: src.objetivos_tren || {},
    };
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-gauge-high"></i>
          Monitoreo
          <span class="tab-subtitle">
            Parámetros operativos: cuándo arrancar a monitorear, alarmas y tolerancias
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn btn-primary" id="btn-mon-guardar" disabled>
            <i class="fas fa-check"></i> Guardar
          </button>
        </div>
      </div>

      <div class="mon-grid">

        <!-- ── Modo de monitoreo ── -->
        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-toggle-on"></i>
            <div>
              <h3>Modo de monitoreo</h3>
              <p>Decide cuándo VistaX considera que la sembradora está sembrando</p>
            </div>
          </div>

          <div class="form-field full">
            <label>Disparador de monitoreo</label>
            <div class="radio-cards">
              <label class="radio-card ${this.setup.modo_monitoreo === "semilla" ? "selected" : ""}">
                <input type="radio" name="modo" value="semilla" ${this.setup.modo_monitoreo === "semilla" ? "checked" : ""} />
                <div class="radio-card-icon"><i class="fas fa-seedling"></i></div>
                <div class="radio-card-body">
                  <strong>Por caída de semilla</strong>
                  <span>Empieza a monitorear cuando detecta semillas en cualquier surco. Funciona sin AgOpenGPS.</span>
                </div>
              </label>
              <label class="radio-card ${this.setup.modo_monitoreo === "aog" ? "selected" : ""}">
                <input type="radio" name="modo" value="aog" ${this.setup.modo_monitoreo === "aog" ? "checked" : ""} />
                <div class="radio-card-icon"><i class="fas fa-satellite-dish"></i></div>
                <div class="radio-card-body">
                  <strong>Por señal de AgOpenGPS</strong>
                  <span>Solo monitorea cuando AOG indica que las secciones están abiertas. Evita falsos positivos en cabeceras.</span>
                </div>
              </label>
            </div>
          </div>

          <div class="form-grid" style="margin-top: 14px;">
            <div class="form-field">
              <label>Surcos mínimos para iniciar</label>
              <input type="number" min="1" max="200" id="f-surcos-min"
                     value="${this.setup.surcos_minimos_monitoreo}" />
              <span class="field-help">Cantidad mínima de surcos que tienen que detectar semilla para considerar que se está sembrando</span>
            </div>
            <div class="form-field">
              <label>Velocidad mínima (km/h)</label>
              <input type="number" min="0" max="20" step="0.1" id="f-vel-min"
                     value="${this.setup.velocidad_min_monitoreo}" />
              <span class="field-help">Por debajo de este valor no se generan alarmas (movimiento de maniobra)</span>
            </div>
          </div>
        </div>

        <!-- ── Geometría ── -->
        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-ruler-combined"></i>
            <div>
              <h3>Geometría y densidad</h3>
              <p>Características físicas de la sembradora y objetivos agronómicos</p>
            </div>
          </div>

          <div class="form-grid">
            <div class="form-field">
              <label>Distancia entre surcos (m)</label>
              <input type="number" min="0.1" max="2" step="0.001" id="f-dist"
                     value="${this.setup.distancia_entre_surcos}" />
            </div>
            <div class="form-field">
              <label>Densidad objetivo (sem/m)</label>
              <input type="number" min="0" max="50" step="0.1" id="f-dens"
                     value="${this.setup.densidad_objetivo}" />
            </div>
            <div class="form-field">
              <label>Tolerancia de desvío (%)</label>
              <input type="number" min="0" max="100" id="f-tol"
                     value="${this.setup.tolerancia_desvio}" />
              <span class="field-help">Si la densidad real cae por debajo de (objetivo × tolerancia/100), se dispara alarma</span>
            </div>
            <div class="form-field">
              <label>Cantidad de tolvas</label>
              <input type="number" min="1" max="20" id="f-tolvas"
                     value="${this.setup.tolvas}" />
            </div>
          </div>
        </div>

        <!-- ── Alarmas ── -->
        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-bell"></i>
            <div>
              <h3>Alarmas</h3>
              <p>Tiempos de espera y disparadores</p>
            </div>
          </div>

          <div class="form-grid">
            <div class="form-field">
              <label>Tiempo de tubo tapado (seg)</label>
              <input type="number" min="0" max="30" step="0.5" id="f-alarma-t"
                     value="${this.setup.alarma_tiempo_seg}" />
              <span class="field-help">Segundos sin pulsos de semilla (con velocidad &gt; mínima) antes de marcar tubo tapado</span>
            </div>
            <div class="form-field">
              <label>Velocidad máxima (km/h)</label>
              <input type="number" min="0" max="30" step="0.1" id="f-vel-max"
                     value="${this.setup.velocidad_max}" />
              <span class="field-help">Velocidad operativa máxima recomendada para esta sembradora</span>
            </div>
          </div>
        </div>

        <!-- ── Turbina ── -->
        <div class="mon-section">
          <div class="mon-section-head">
            <i class="fas fa-fan"></i>
            <div>
              <h3>Turbina (opcional)</h3>
              <p>Rangos de RPM válidos para sensores de tipo "rotación de eje" o "turbina"</p>
            </div>
          </div>

          <div class="form-grid">
            <div class="form-field">
              <label>RPM mínima</label>
              <input type="number" min="0" max="20000" step="50" id="f-rpm-min"
                     value="${this.setup.rpm_min}" />
            </div>
            <div class="form-field">
              <label>RPM máxima</label>
              <input type="number" min="0" max="20000" step="50" id="f-rpm-max"
                     value="${this.setup.rpm_max}" />
            </div>
          </div>
        </div>

      </div>
    `;

    container.querySelector("#btn-mon-guardar")
      .addEventListener("click", () => this._guardar());

    // Wire de cambios — cualquier input dispara dirty
    this._wireInputs();
  }

  _wireInputs() {
    const map = {
      "f-surcos-min": "surcos_minimos_monitoreo",
      "f-vel-min":    "velocidad_min_monitoreo",
      "f-dist":       "distancia_entre_surcos",
      "f-dens":       "densidad_objetivo",
      "f-tol":        "tolerancia_desvio",
      "f-tolvas":     "tolvas",
      "f-alarma-t":   "alarma_tiempo_seg",
      "f-vel-max":    "velocidad_max",
      "f-rpm-min":    "rpm_min",
      "f-rpm-max":    "rpm_max",
    };

    for (const [id, key] of Object.entries(map)) {
      const el = this.container.querySelector(`#${id}`);
      if (!el) continue;
      el.addEventListener("input", () => {
        const val = parseFloat(el.value);
        this.setup[key] = isNaN(val) ? 0 : val;
        this._marcarDirty();
      });
    }

    // Radios de modo de monitoreo
    this.container.querySelectorAll('input[name="modo"]').forEach(radio => {
      radio.addEventListener("change", () => {
        this.setup.modo_monitoreo = radio.value;
        // Refrescar visual de selección
        this.container.querySelectorAll(".radio-card").forEach(card => {
          const inp = card.querySelector('input[type="radio"]');
          card.classList.toggle("selected", inp.checked);
        });
        this._marcarDirty();
      });
    });
  }

  _marcarDirty() {
    this._dirty = true;
    const btn = this.container.querySelector("#btn-mon-guardar");
    if (btn) btn.disabled = false;
  }

  validar() {
    const errores = [];
    const s = this.setup;

    if (!s.distancia_entre_surcos || s.distancia_entre_surcos <= 0)
      errores.push("Distancia entre surcos debe ser > 0");
    if (s.densidad_objetivo < 0)
      errores.push("Densidad objetivo no puede ser negativa");
    if (s.tolerancia_desvio < 0 || s.tolerancia_desvio > 100)
      errores.push("Tolerancia debe estar entre 0 y 100");
    if (s.surcos_minimos_monitoreo < 1)
      errores.push("Surcos mínimos debe ser ≥ 1");
    if (s.velocidad_min_monitoreo < 0)
      errores.push("Velocidad mínima no puede ser negativa");
    if (s.velocidad_max <= s.velocidad_min_monitoreo)
      errores.push("Velocidad máxima debe ser mayor a la mínima");
    if (s.rpm_max < s.rpm_min)
      errores.push("RPM máxima debe ser mayor o igual a la mínima");
    if (!["semilla", "aog"].includes(s.modo_monitoreo))
      errores.push("Modo de monitoreo inválido");

    return { ok: errores.length === 0, errores };
  }

  recolectar() {
    return { setup: this.setup };
  }

  async _guardar() {
    const val = this.validar();
    if (!val.ok) {
      this._toast("Errores: " + val.errores.join(", "), "error");
      return;
    }

    try {
      await this.parent.guardarPerfil();
      this._dirty = false;
      this.container.querySelector("#btn-mon-guardar").disabled = true;
      this._toast("Configuración de monitoreo guardada");
      // Refrescar desde el perfil recargado por si el backend cambió algo
      this.setup = this._inicializar(this.parent.perfil?.setup || {});
    } catch (e) {
      this._toast("Error al guardar: " + e.message, "error");
    }
  }
}

window.TabMonitoreo = TabMonitoreo;
