// ============================================================
// VistaX — tab_trenes.js  (v3.0)
//
// Tab "Trenes": edición de la estructura de trenes del implemento.
//
//   perfil.trenes = {
//     "1": { surcos: 19, orden: 2, nombre: "Delantero" },
//     "2": { surcos: 20, orden: 1, nombre: "Trasero"   }
//   }
//
// Reglas de numeración (agronómicas):
//   - El "orden" define quién arranca en el surco 1.
//   - El tren con orden=1 ocupa los surcos 1..N
//   - El siguiente (orden=2) ocupa los surcos N+1..N+M
//   - La regla "Tren 2 primero" es decisión del OPERARIO: él define orden.
//
// Features:
//   - Preview en vivo de rangos calculados (sin llamar al backend)
//   - Detección de sensores huérfanos (opción 2: permitir y avisar)
//   - Validaciones antes de guardar
// ============================================================

class TabTrenes extends TabBase {
  constructor(opts) {
    super(opts);
    // Copia de trabajo editable (no tocar this.perfil hasta guardar)
    this.trenes = this._clonarTrenes(this.perfil?.trenes || {});
    this._dirty = false;
  }

  _clonarTrenes(src) {
    const out = {};
    for (const [id, cfg] of Object.entries(src)) {
      out[id] = {
        surcos: parseInt(cfg.surcos) || 0,
        orden:  parseInt(cfg.orden)  || 99,
        nombre: cfg.nombre || `Tren ${id}`,
      };
    }
    return out;
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-train"></i>
          Trenes de Siembra
          <span class="tab-subtitle">
            Estructura de la sembradora: cuántos trenes, en qué orden y con cuántos surcos
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn" id="btn-tren-agregar">
            <i class="fas fa-plus"></i> Agregar Tren
          </button>
          <button class="btn btn-primary" id="btn-tren-guardar" disabled>
            <i class="fas fa-check"></i> Guardar
          </button>
        </div>
      </div>

      <div class="trenes-wrapper">
        <div class="trenes-editor" id="trenes-editor"></div>
        <div class="trenes-preview" id="trenes-preview"></div>
      </div>

      <div id="trenes-warnings"></div>
    `;

    container.querySelector("#btn-tren-agregar")
      .addEventListener("click", () => this._agregarTren());
    container.querySelector("#btn-tren-guardar")
      .addEventListener("click", () => this._guardar());

    this._renderEditor();
    this._renderPreview();
    this._renderWarnings();
  }

  // ── Editor de trenes ──────────────────────────────────────

  _renderEditor() {
    const cont = this.container.querySelector("#trenes-editor");
    const ids = Object.keys(this.trenes).sort((a, b) =>
      (this.trenes[a].orden || 99) - (this.trenes[b].orden || 99)
    );

    if (ids.length === 0) {
      cont.innerHTML = `
        <div class="empty-state" style="padding: 40px 20px;">
          <i class="fas fa-train"></i>
          <div class="title">Sin trenes definidos</div>
          <div>Agregá el primer tren para empezar</div>
        </div>
      `;
      return;
    }

    cont.innerHTML = `
      <div class="tren-editor-header">
        <span>Orden</span>
        <span>ID</span>
        <span>Nombre</span>
        <span>Surcos</span>
        <span></span>
      </div>
      ${ids.map(id => this._renderTrenRow(id)).join("")}
    `;

    cont.querySelectorAll(".tren-row").forEach(row => {
      const id = row.dataset.id;
      row.querySelector(".inp-orden").addEventListener("input", (e) => {
        this.trenes[id].orden = parseInt(e.target.value) || 1;
        this._marcarDirty();
        this._renderPreview();
        this._renderWarnings();
      });
      row.querySelector(".inp-nombre").addEventListener("input", (e) => {
        this.trenes[id].nombre = e.target.value;
        this._marcarDirty();
        this._renderPreview();
      });
      row.querySelector(".inp-surcos").addEventListener("input", (e) => {
        this.trenes[id].surcos = parseInt(e.target.value) || 0;
        this._marcarDirty();
        this._renderPreview();
        this._renderWarnings();
      });
      row.querySelector(".btn-up").addEventListener("click", () => this._moverArriba(id));
      row.querySelector(".btn-down").addEventListener("click", () => this._moverAbajo(id));
      row.querySelector(".btn-eliminar").addEventListener("click", () => this._eliminarTren(id));
    });
  }

  _renderTrenRow(id) {
    const t = this.trenes[id];
    return `
      <div class="tren-row" data-id="${this._esc(id)}">
        <input class="inp-orden inp-num" type="number" min="1" max="99" value="${t.orden}" />
        <span class="tren-id">Tren ${this._esc(id)}</span>
        <input class="inp-nombre" type="text" value="${this._esc(t.nombre)}"
               placeholder="Nombre del tren" maxlength="40" />
        <input class="inp-surcos inp-num" type="number" min="1" max="200" value="${t.surcos}" />
        <div class="tren-actions">
          <button class="btn-up btn-icon-sm" title="Subir orden">
            <i class="fas fa-arrow-up"></i>
          </button>
          <button class="btn-down btn-icon-sm" title="Bajar orden">
            <i class="fas fa-arrow-down"></i>
          </button>
          <button class="btn-eliminar btn-icon-sm danger" title="Eliminar tren">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }

  _moverArriba(id) {
    const actual = this.trenes[id].orden;
    const ids = Object.keys(this.trenes);
    // Encontrar el tren con orden inmediatamente menor
    let prevId = null;
    let prevOrden = -Infinity;
    for (const otroId of ids) {
      const o = this.trenes[otroId].orden;
      if (o < actual && o > prevOrden) {
        prevOrden = o;
        prevId = otroId;
      }
    }
    if (!prevId) return;
    this.trenes[id].orden = prevOrden;
    this.trenes[prevId].orden = actual;
    this._marcarDirty();
    this._renderEditor();
    this._renderPreview();
    this._renderWarnings();
  }

  _moverAbajo(id) {
    const actual = this.trenes[id].orden;
    const ids = Object.keys(this.trenes);
    let nextId = null;
    let nextOrden = Infinity;
    for (const otroId of ids) {
      const o = this.trenes[otroId].orden;
      if (o > actual && o < nextOrden) {
        nextOrden = o;
        nextId = otroId;
      }
    }
    if (!nextId) return;
    this.trenes[id].orden = nextOrden;
    this.trenes[nextId].orden = actual;
    this._marcarDirty();
    this._renderEditor();
    this._renderPreview();
    this._renderWarnings();
  }

  // ── Acciones de lista ─────────────────────────────────────

  _agregarTren() {
    // Buscar el siguiente ID numérico libre
    let nuevoId = 1;
    while (this.trenes[String(nuevoId)]) nuevoId++;
    nuevoId = String(nuevoId);

    // Orden: el más grande + 1
    const ordenes = Object.values(this.trenes).map(t => t.orden || 0);
    const nuevoOrden = ordenes.length ? Math.max(...ordenes) + 1 : 1;

    this.trenes[nuevoId] = {
      surcos: 10,
      orden:  nuevoOrden,
      nombre: `Tren ${nuevoId}`,
    };
    this._marcarDirty();
    this._renderEditor();
    this._renderPreview();
    this._renderWarnings();
  }

  async _eliminarTren(id) {
    const t = this.trenes[id];
    const ok = await this._confirm(
      `¿Eliminar Tren ${id}?`,
      `Se removerá "${t.nombre}" con ${t.surcos} surcos. Los sensores asignados a esos surcos quedarán huérfanos hasta que los reasignes desde el tab Sensores.`
    );
    if (!ok) return;
    delete this.trenes[id];
    this._marcarDirty();
    this._renderEditor();
    this._renderPreview();
    this._renderWarnings();
  }

  // ── Preview de rangos (cálculo en vivo, sin backend) ──────

  _calcularRangos() {
    const arr = Object.entries(this.trenes)
      .map(([id, cfg]) => ({
        id,
        surcos: parseInt(cfg.surcos) || 0,
        orden:  parseInt(cfg.orden)  || 99,
        nombre: cfg.nombre || `Tren ${id}`,
      }))
      .filter(t => t.surcos > 0)
      .sort((a, b) => a.orden - b.orden);

    if (arr.length === 0) return { rangos: {}, totalSurcos: 0, lista: [] };

    const rangos = {};
    const lista  = [];
    let siguiente = 1;
    for (const t of arr) {
      const r = {
        id:     t.id,
        inicio: siguiente,
        fin:    siguiente + t.surcos - 1,
        surcos: t.surcos,
        orden:  t.orden,
        nombre: t.nombre,
      };
      rangos[t.id] = r;
      lista.push(r);
      siguiente += t.surcos;
    }

    return { rangos, totalSurcos: siguiente - 1, lista };
  }

  _renderPreview() {
    const cont = this.container.querySelector("#trenes-preview");
    const calc = this._calcularRangos();

    if (calc.lista.length === 0) {
      cont.innerHTML = `
        <div class="preview-header">
          <i class="fas fa-eye"></i> Vista previa
        </div>
        <div class="preview-empty">Sin estructura definida</div>
      `;
      return;
    }

    cont.innerHTML = `
      <div class="preview-header">
        <i class="fas fa-eye"></i> Vista previa
        <span class="preview-total">${calc.totalSurcos} surcos totales</span>
      </div>
      <div class="preview-list">
        ${calc.lista.map((r, idx) => `
          <div class="preview-row">
            <div class="preview-badge">#${idx + 1}</div>
            <div class="preview-nombre">
              <strong>${this._esc(r.nombre)}</strong>
              <span class="preview-id">Tren ${this._esc(r.id)}</span>
            </div>
            <div class="preview-rango">
              Surcos <strong>${r.inicio}</strong> a <strong>${r.fin}</strong>
              <span class="preview-count">(${r.surcos})</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  // ── Detección de huérfanos ────────────────────────────────

  _detectarHuerfanos() {
    const sensores = (this.perfil?.mapeo_sensores || []).filter(s => s.is_active !== false);
    if (sensores.length === 0) return { total: 0, huerfanos: [] };

    const calc = this._calcularRangos();
    const huerfanos = [];

    for (const s of sensores) {
      // Solo nos importan los sensores de siembra (semilla / ferti)
      const esSiembra = ["semilla", "ferti_linea", "ferti_costado"].includes(s.tipo);
      if (!esSiembra) continue;

      const bajada = parseInt(s.bajada);
      if (!bajada) continue;

      // ¿Existe un tren que cubra esta bajada?
      let cubierto = false;
      for (const r of Object.values(calc.rangos)) {
        if (bajada >= r.inicio && bajada <= r.fin) {
          // Además, el sensor debe pertenecer al tren correcto
          if (String(s.tren) === String(r.id)) {
            cubierto = true;
            break;
          }
        }
      }
      if (!cubierto) {
        huerfanos.push(s);
      }
    }
    return { total: sensores.length, huerfanos };
  }

  _renderWarnings() {
    const cont = this.container.querySelector("#trenes-warnings");
    const { total, huerfanos } = this._detectarHuerfanos();

    if (huerfanos.length === 0) {
      cont.innerHTML = "";
      return;
    }

    cont.innerHTML = `
      <div class="warning-box">
        <div class="warning-head">
          <i class="fas fa-triangle-exclamation"></i>
          <strong>${huerfanos.length} sensor${huerfanos.length === 1 ? "" : "es"} huérfano${huerfanos.length === 1 ? "" : "s"}</strong>
          <span class="warning-sub">de ${total} en total</span>
        </div>
        <p>
          Con esta estructura quedarían sensores apuntando a surcos o trenes que no existen.
          Podés guardar igual y reasignarlos desde el tab <strong>Sensores</strong>.
        </p>
        <div class="warning-list">
          ${huerfanos.slice(0, 12).map(s => `
            <span class="warning-chip">
              ${this._esc(s.uid)} · cable ${s.cable} → surco ${s.bajada} (tren ${s.tren})
            </span>
          `).join("")}
          ${huerfanos.length > 12 ? `<span class="warning-chip more">+${huerfanos.length - 12} más</span>` : ""}
        </div>
      </div>
    `;
  }

  // ── Guardado ──────────────────────────────────────────────

  _marcarDirty() {
    this._dirty = true;
    const btn = this.container.querySelector("#btn-tren-guardar");
    if (btn) btn.disabled = false;
  }

  validar() {
    const errores = [];
    const ordenes = new Set();
    for (const [id, t] of Object.entries(this.trenes)) {
      if (!t.nombre?.trim()) errores.push(`Tren ${id}: falta nombre`);
      if (!t.surcos || t.surcos < 1) errores.push(`Tren ${id}: surcos inválidos`);
      if (!t.orden || t.orden < 1) errores.push(`Tren ${id}: orden inválido`);
      if (ordenes.has(t.orden)) errores.push(`Orden ${t.orden} duplicado`);
      ordenes.add(t.orden);
    }
    return { ok: errores.length === 0, errores };
  }

  recolectar() {
    return { trenes: this.trenes };
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
      const btn = this.container.querySelector("#btn-tren-guardar");
      if (btn) btn.disabled = true;
      this._toast("Estructura de trenes guardada");
    } catch (e) {
      this._toast("Error al guardar: " + e.message, "error");
    }
  }

  // ── UI helpers ────────────────────────────────────────────

  _confirm(titulo, mensaje) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "cfg-prompt-overlay";
      overlay.innerHTML = `
        <div class="cfg-prompt">
          <h3>${this._esc(titulo)}</h3>
          <p style="color: var(--ap-text-muted); margin: 0 0 18px 0;">${this._esc(mensaje)}</p>
          <div class="actions">
            <button class="btn btn-ghost" id="cf-cancel">Cancelar</button>
            <button class="btn btn-danger" id="cf-ok"><i class="fas fa-trash"></i> Eliminar</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector("#cf-cancel").onclick = () => close(false);
      overlay.querySelector("#cf-ok").onclick = () => close(true);
    });
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}

window.TabTrenes = TabTrenes;
