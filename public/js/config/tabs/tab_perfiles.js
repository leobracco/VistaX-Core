// ============================================================
// VistaX — tab_perfiles.js  (v3.0)
//
// Tab "Perfiles": CRUD de perfiles de implemento.
//   - Listar todos los perfiles con metadata (surcos, trenes, fecha)
//   - Crear perfil vacío
//   - Duplicar perfil existente
//   - Activar perfil (recarga config en backend + emite profile_changed)
//   - Bloquear / desbloquear (lock)
//   - Borrar (excepto activo y bloqueados)
//
// Este tab NO participa del guardado global del modal: cada acción
// llama directamente a su endpoint y refresca la lista.
// ============================================================

class TabPerfiles extends TabBase {
  constructor(opts) {
    super(opts);
    this.lista     = [];
    this.activoId  = null;
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-layer-group"></i>
          Perfiles de Implemento
          <span class="tab-subtitle">
            Configuraciones predefinidas para cada sembradora del cliente
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn" id="btn-perfil-duplicar">
            <i class="fas fa-copy"></i> Duplicar Activo
          </button>
          <button class="btn btn-primary" id="btn-perfil-nuevo">
            <i class="fas fa-plus"></i> Nuevo Perfil
          </button>
        </div>
      </div>

      <div id="perfiles-lista">
        <div class="cfg-loading">
          <i class="fas fa-circle-notch fa-spin"></i>
          <span>Cargando perfiles...</span>
        </div>
      </div>
    `;

    // Wire de botones del header
    container.querySelector("#btn-perfil-nuevo")
      .addEventListener("click", () => this._crearNuevo());
    container.querySelector("#btn-perfil-duplicar")
      .addEventListener("click", () => this._duplicarActivo());

    await this._cargar();
  }

  async _cargar() {
    try {
      const r = await fetch("/api/config/perfiles");
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error al listar perfiles");

      this.lista    = data.perfiles || [];
      this.activoId = data.activo;

      this._renderLista();
    } catch (e) {
      this.container.querySelector("#perfiles-lista").innerHTML = `
        <div class="empty-state">
          <i class="fas fa-triangle-exclamation"></i>
          <div class="title">No se pudieron cargar los perfiles</div>
          <div>${e.message}</div>
        </div>
      `;
      this._toast("Error al cargar perfiles: " + e.message, "error");
    }
  }

  _renderLista() {
    const cont = this.container.querySelector("#perfiles-lista");

    if (this.lista.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-folder-open"></i>
          <div class="title">No hay perfiles creados</div>
          <div>Creá el primer perfil para empezar a configurar tu implemento</div>
        </div>
      `;
      return;
    }

    cont.innerHTML = `
      <div class="perfil-list">
        ${this.lista.map(p => this._renderRow(p)).join("")}
      </div>
    `;

    // Wire de acciones por fila
    cont.querySelectorAll(".perfil-row").forEach(row => {
      const id = row.dataset.id;
      row.querySelector(".act-activar")?.addEventListener("click", () => this._activar(id));
      row.querySelector(".act-duplicar")?.addEventListener("click", () => this._duplicar(id));
      row.querySelector(".act-lock")?.addEventListener("click", () => this._toggleLock(id));
      row.querySelector(".act-borrar")?.addEventListener("click", () => this._borrar(id));
    });
  }

  _renderRow(p) {
    const esActivo = p.id === this.activoId;
    const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }) : "—";

    return `
      <div class="perfil-row ${esActivo ? "activo" : ""}" data-id="${p.id}">
        <div class="icon-impl">
          <i class="fas fa-tractor"></i>
        </div>
        <div>
          <div class="nombre">
            ${this._esc(p.nombre)}
            ${esActivo ? `<span class="badge-activo">ACTIVO</span>` : ""}
            ${p.locked ? `<i class="fas fa-lock badge-locked" title="Bloqueado"></i>` : ""}
          </div>
          <div class="meta">
            <span><strong>${p.surcos}</strong> surcos</span>
            <span><strong>${p.trenes}</strong> trenes</span>
            <span><strong>${p.totalSensores}</strong> sensores</span>
            <span><i class="far fa-clock"></i> ${fecha}</span>
          </div>
        </div>
        <div></div>
        <div class="acciones">
          <button class="act-activar activate" title="Activar perfil"
                  ${esActivo ? "disabled" : ""}>
            <i class="fas fa-power-off"></i>
          </button>
          <button class="act-duplicar" title="Duplicar">
            <i class="fas fa-copy"></i>
          </button>
          <button class="act-lock" title="${p.locked ? "Desbloquear" : "Bloquear"}">
            <i class="fas fa-${p.locked ? "unlock" : "lock"}"></i>
          </button>
          <button class="act-borrar danger" title="Borrar"
                  ${esActivo || p.locked ? "disabled" : ""}>
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }

  // ── Acciones ──────────────────────────────────────────────

  async _crearNuevo() {
    const nombre = await this._prompt("Nuevo perfil", "Nombre del perfil (ej: Tanzi 43)");
    if (!nombre) return;

    try {
      const r = await fetch("/api/config/perfiles/nuevo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error desconocido");

      this._toast(`Perfil "${nombre}" creado`);
      await this._cargar();
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  async _duplicarActivo() {
    if (!this.activoId) {
      this._toast("No hay perfil activo para duplicar", "warn");
      return;
    }
    return this._duplicar(this.activoId);
  }

  async _duplicar(sourceId) {
    const original = this.lista.find(p => p.id === sourceId);
    const sugerido = original ? `${original.nombre} (copia)` : "Nuevo perfil";
    const nombre = await this._prompt("Duplicar perfil", "Nombre del nuevo perfil", sugerido);
    if (!nombre) return;

    try {
      const r = await fetch("/api/config/perfiles/duplicar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, nombre })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error desconocido");

      this._toast(`Perfil duplicado como "${nombre}"`);
      await this._cargar();
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  async _activar(id) {
    if (id === this.activoId) return;

    try {
      const r = await fetch("/api/config/perfiles/activar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error desconocido");

      this._toast(`Perfil activado`);
      // Recargar el perfil global del modal (impacta otros tabs)
      await this._recargarPerfil();
      await this._cargar();
      // Actualizar header
      this.parent?.actualizarPerfilActivo();
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  async _toggleLock(id) {
    try {
      const r = await fetch("/api/config/perfiles/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error desconocido");

      this._toast(data.locked ? "Perfil bloqueado" : "Perfil desbloqueado");
      await this._cargar();
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  async _borrar(id) {
    const p = this.lista.find(x => x.id === id);
    if (!p) return;

    const ok = await this._confirm(
      `¿Borrar perfil "${p.nombre}"?`,
      "Esta acción no se puede deshacer."
    );
    if (!ok) return;

    try {
      const r = await fetch(`/api/config/perfiles/${id}`, { method: "DELETE" });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "No se pudo borrar");

      this._toast(`Perfil "${p.nombre}" borrado`);
      await this._cargar();
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  // ── UI helpers (prompts) ──────────────────────────────────

  _prompt(titulo, label, valorInicial = "") {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "cfg-prompt-overlay";
      overlay.innerHTML = `
        <div class="cfg-prompt">
          <h3>${this._esc(titulo)}</h3>
          <input type="text" id="prompt-input"
                 placeholder="${this._esc(label)}"
                 value="${this._esc(valorInicial)}" />
          <div class="actions">
            <button class="btn btn-ghost" id="prompt-cancel">Cancelar</button>
            <button class="btn btn-primary" id="prompt-ok">Aceptar</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const input = overlay.querySelector("#prompt-input");
      input.focus();
      input.select();

      const close = (val) => {
        overlay.remove();
        resolve(val);
      };
      overlay.querySelector("#prompt-cancel").onclick = () => close(null);
      overlay.querySelector("#prompt-ok").onclick = () => close(input.value.trim() || null);
      input.onkeydown = (e) => {
        if (e.key === "Enter") close(input.value.trim() || null);
        if (e.key === "Escape") close(null);
      };
    });
  }

  _confirm(titulo, mensaje) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "cfg-prompt-overlay";
      overlay.innerHTML = `
        <div class="cfg-prompt">
          <h3>${this._esc(titulo)}</h3>
          <p style="color: var(--ap-text-muted); margin: 0 0 18px 0;">
            ${this._esc(mensaje)}
          </p>
          <div class="actions">
            <button class="btn btn-ghost" id="cf-cancel">Cancelar</button>
            <button class="btn btn-danger" id="cf-ok">
              <i class="fas fa-trash"></i> Borrar
            </button>
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

window.TabPerfiles = TabPerfiles;
