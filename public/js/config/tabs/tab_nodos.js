// ============================================================
// VistaX — tab_nodos.js  (v3.0)
//
// Tab "Nodos": gestión del inventario de nodos ESP32.
//   - Lista con firmware, IP, RSSI, estado, tiempo desde último visto
//   - Filtros por estado (todos / online / offline / sin_registrar / ignorado / error)
//   - Acciones por nodo:
//       · Reemplazar (migra automáticamente a todos los perfiles)
//       · Ignorar / Designorar
//       · Borrar
//       · Comandos remotos (reiniciar, borrar wifi)
//   - Auto-refresh por polling (5s) + socket "nodos_inventario_changed"
//
// Este tab NO participa del guardado global del modal: cada acción
// es atómica contra su endpoint REST.
// ============================================================

class TabNodos extends TabBase {
  constructor(opts) {
    super(opts);
    this.nodos        = [];
    this.filtroActual = "todos";
    this._pollTimer   = null;
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-microchip"></i>
          Nodos VistaX-Node
          <span class="tab-subtitle">
            Inventario de nodos detectados, su estado y asignación a perfiles
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn" id="btn-nodos-refrescar">
            <i class="fas fa-rotate-right"></i> Refrescar
          </button>
        </div>
      </div>

      <div class="nodos-filtros" id="nodos-filtros"></div>

      <div id="nodos-lista">
        <div class="cfg-loading">
          <i class="fas fa-circle-notch fa-spin"></i>
          <span>Cargando nodos...</span>
        </div>
      </div>
    `;

    container.querySelector("#btn-nodos-refrescar")
      .addEventListener("click", () => this._cargar());

    await this._cargar();

    // Polling cada 5s para reflejar heartbeats y estados online/offline
    this._pollTimer = setInterval(() => this._cargar(true), 5000);

    // Socket: refresh inmediato cuando otro tab/cliente cambia algo
    if (this.io) {
      this._on(this.io, "nodos_inventario_changed", () => this._cargar(true));
    }
  }

  destroy() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    super.destroy();
  }

  async _cargar(silencioso = false) {
    try {
      const r = await fetch("/api/nodos");
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Error al listar nodos");

      this.nodos = data.nodos || [];
      this._renderFiltros();
      this._renderLista();
    } catch (e) {
      if (!silencioso) this._toast("Error al cargar nodos: " + e.message, "error");
      console.error("[TabNodos]", e);
    }
  }

  // ── Filtros ───────────────────────────────────────────────

  _renderFiltros() {
    const cont = this.container.querySelector("#nodos-filtros");

    const conteos = {
      todos:         this.nodos.length,
      online:        this.nodos.filter(n => n.online && n.estado !== "ignorado").length,
      sin_registrar: this.nodos.filter(n => n.estado === "sin_registrar").length,
      ignorado:      this.nodos.filter(n => n.estado === "ignorado").length,
      error:         this.nodos.filter(n => n.estado === "error").length,
    };

    const filtros = [
      { id: "todos",         label: "Todos",          icon: "fa-list" },
      { id: "online",        label: "Online",         icon: "fa-circle" },
      { id: "sin_registrar", label: "Sin asignar",    icon: "fa-question" },
      { id: "ignorado",      label: "Ignorados",      icon: "fa-eye-slash" },
      { id: "error",         label: "Con error",      icon: "fa-triangle-exclamation" },
    ];

    cont.innerHTML = filtros.map(f => `
      <button class="filtro-chip ${this.filtroActual === f.id ? "active" : ""}"
              data-filtro="${f.id}">
        <i class="fas ${f.icon}"></i>
        ${f.label}
        <span class="count">${conteos[f.id]}</span>
      </button>
    `).join("");

    cont.querySelectorAll(".filtro-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        this.filtroActual = btn.dataset.filtro;
        this._renderFiltros();
        this._renderLista();
      });
    });
  }

  // ── Lista ─────────────────────────────────────────────────

  _renderLista() {
    const cont = this.container.querySelector("#nodos-lista");
    const filtrados = this._aplicarFiltro();

    if (filtrados.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-microchip"></i>
          <div class="title">No hay nodos en esta categoría</div>
          <div>${this.nodos.length === 0 ? "Encendé un nodo ESP32 para que aparezca acá" : "Probá con otro filtro"}</div>
        </div>
      `;
      return;
    }

    cont.innerHTML = `<div class="nodos-grid">${filtrados.map(n => this._renderNodo(n)).join("")}</div>`;

    cont.querySelectorAll(".nodo-card").forEach(card => {
      const uid = card.dataset.uid;
      card.querySelector(".act-reemplazar")?.addEventListener("click", () => this._abrirReemplazo(uid));
      card.querySelector(".act-ignorar")?.addEventListener("click", () => this._toggleIgnorar(uid));
      card.querySelector(".act-borrar")?.addEventListener("click", () => this._borrar(uid));
      card.querySelector(".act-reiniciar")?.addEventListener("click", () => this._comando(uid, "reiniciar"));
    });
  }

  _aplicarFiltro() {
    switch (this.filtroActual) {
      case "todos":         return this.nodos;
      case "online":        return this.nodos.filter(n => n.online && n.estado !== "ignorado");
      case "sin_registrar": return this.nodos.filter(n => n.estado === "sin_registrar");
      case "ignorado":      return this.nodos.filter(n => n.estado === "ignorado");
      case "error":         return this.nodos.filter(n => n.estado === "error");
      default:              return this.nodos;
    }
  }

  _renderNodo(n) {
    const estadoCfg = this._estadoVisual(n);
    const rssi = this._rssiVisual(n.rssi);
    const visto = this._formatVisto(n.segundos_desde_visto);
    const perfiles = (n.perfiles_asignado || []).join(", ") || "—";

    const reemplazadoBadge = n.reemplazado_por
      ? `<div class="nodo-reemplazado">
           <i class="fas fa-arrow-right"></i> Reemplazado por <strong>${this._esc(n.reemplazado_por)}</strong>
         </div>`
      : "";

    return `
      <div class="nodo-card ${estadoCfg.cls}" data-uid="${this._esc(n.uid)}">
        <div class="nodo-head">
          <div class="nodo-status-dot" style="background: ${estadoCfg.color}"
               title="${estadoCfg.label}"></div>
          <div class="nodo-uid">
            ${this._esc(n.uid)}
            ${n.alias ? `<span class="nodo-alias">${this._esc(n.alias)}</span>` : ""}
          </div>
          <div class="nodo-estado-badge" style="background: ${estadoCfg.bgColor}; color: ${estadoCfg.color}">
            ${estadoCfg.label}
          </div>
        </div>

        ${reemplazadoBadge}

        <div class="nodo-meta">
          <div class="nodo-meta-item">
            <i class="fas fa-code-branch"></i>
            <span>FW <strong>${this._esc(n.firmware || "?")}</strong></span>
          </div>
          <div class="nodo-meta-item">
            <i class="fas fa-network-wired"></i>
            <span>${this._esc(n.ip || "?")}</span>
          </div>
          <div class="nodo-meta-item">
            <i class="fas fa-signal"></i>
            <span>${rssi.html} <strong>${n.rssi ?? "—"} dBm</strong></span>
          </div>
          <div class="nodo-meta-item">
            <i class="far fa-clock"></i>
            <span>${visto}</span>
          </div>
          <div class="nodo-meta-item full">
            <i class="fas fa-layer-group"></i>
            <span>Perfiles: <strong>${this._esc(perfiles)}</strong></span>
          </div>
        </div>

        <div class="nodo-acciones">
          <button class="btn btn-sm act-reemplazar" title="Reemplazar este nodo por otro">
            <i class="fas fa-right-left"></i> Reemplazar
          </button>
          <button class="btn btn-sm act-reiniciar" title="Reiniciar nodo">
            <i class="fas fa-power-off"></i>
          </button>
          <button class="btn btn-sm act-ignorar" title="${n.ignorado ? "Quitar de ignorados" : "Ignorar este nodo"}">
            <i class="fas fa-${n.ignorado ? "eye" : "eye-slash"}"></i>
          </button>
          <button class="btn btn-sm btn-danger act-borrar" title="Borrar del inventario">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }

  // ── Helpers visuales ──────────────────────────────────────

  _estadoVisual(n) {
    if (n.estado === "ignorado") {
      return { label: "IGNORADO",  color: "#8a9bb0", bgColor: "rgba(138,155,176,0.15)", cls: "estado-ignorado" };
    }
    if (n.estado === "error") {
      return { label: "ERROR",     color: "#ef4444", bgColor: "rgba(239,68,68,0.15)",   cls: "estado-error" };
    }
    if (n.estado === "sin_registrar") {
      return { label: "SIN ASIGNAR", color: "#3b82f6", bgColor: "rgba(59,130,246,0.15)", cls: "estado-sin-registrar" };
    }
    // registrado
    if (n.online) {
      return { label: "ONLINE",    color: "#84cc16", bgColor: "rgba(132,204,22,0.15)",  cls: "estado-online" };
    }
    return { label: "OFFLINE",     color: "#f59e0b", bgColor: "rgba(245,158,11,0.15)",  cls: "estado-offline" };
  }

  _rssiVisual(rssi) {
    if (rssi == null) return { html: `<span class="rssi-bars off"><i></i><i></i><i></i><i></i></span>` };
    let bars = 1;
    if (rssi >= -55) bars = 4;
    else if (rssi >= -65) bars = 3;
    else if (rssi >= -75) bars = 2;
    return {
      html: `<span class="rssi-bars b${bars}">
               <i></i><i></i><i></i><i></i>
             </span>`
    };
  }

  _formatVisto(seg) {
    if (seg == null) return "—";
    if (seg < 60) return `hace ${seg}s`;
    if (seg < 3600) return `hace ${Math.floor(seg / 60)}m`;
    if (seg < 86400) return `hace ${Math.floor(seg / 3600)}h`;
    return `hace ${Math.floor(seg / 86400)}d`;
  }

  // ── Acciones ──────────────────────────────────────────────

  async _toggleIgnorar(uid) {
    const n = this.nodos.find(x => x.uid === uid);
    if (!n) return;
    try {
      await fetch(`/api/nodos/${uid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ignorado: !n.ignorado }),
      });
      this._toast(n.ignorado ? "Nodo restaurado" : "Nodo ignorado");
      await this._cargar(true);
    } catch (e) {
      this._toast("Error: " + e.message, "error");
    }
  }

  async _borrar(uid) {
    const n = this.nodos.find(x => x.uid === uid);
    if (!n) return;
    const ok = await this._confirm(
      `¿Borrar nodo ${uid} del inventario?`,
      "También se eliminará de todos los perfiles donde aparezca. Esta acción no se puede deshacer."
    );
    if (!ok) return;

    try {
      const r = await fetch(`/api/nodos/${uid}`, { method: "DELETE" });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "No se pudo borrar");
      this._toast(`Nodo ${uid} borrado (afectó ${data.perfilesAfectados?.length || 0} perfiles)`);
      await this._cargar(true);
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  async _comando(uid, cmd) {
    try {
      const r = await fetch(`/api/nodos/${uid}/comando`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Falló");
      this._toast(`Comando "${cmd}" enviado a ${uid}`);
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  // ── Reemplazo ─────────────────────────────────────────────

  _abrirReemplazo(uidViejo) {
    const viejo = this.nodos.find(n => n.uid === uidViejo);
    if (!viejo) return;

    // Candidatos: nodos online o sin_registrar, no ignorados, distintos al viejo
    const candidatos = this.nodos.filter(n =>
      n.uid !== uidViejo &&
      !n.ignorado &&
      (n.estado === "sin_registrar" || n.online)
    );

    const overlay = document.createElement("div");
    overlay.className = "cfg-prompt-overlay";
    overlay.innerHTML = `
      <div class="cfg-prompt" style="min-width: 460px;">
        <h3><i class="fas fa-right-left"></i> Reemplazar Nodo</h3>

        <div style="margin-bottom: 14px; padding: 12px; background: var(--ap-bg);
                    border-radius: 6px; border-left: 3px solid var(--ap-yellow);">
          <div style="font-size: 11px; color: var(--ap-text-muted); text-transform: uppercase;">Nodo viejo</div>
          <div style="font-weight: 700; font-size: 14px; margin-top: 4px;">
            ${this._esc(uidViejo)} ${viejo.alias ? `<span style="color: var(--ap-text-muted); font-weight: 400;">— ${this._esc(viejo.alias)}</span>` : ""}
          </div>
          <div style="font-size: 11px; color: var(--ap-text-muted); margin-top: 2px;">
            FW ${this._esc(viejo.firmware || "?")} · ${(viejo.perfiles_asignado || []).length} perfil(es)
          </div>
        </div>

        <label style="display: block; font-size: 11px; text-transform: uppercase;
                      color: var(--ap-text-muted); margin-bottom: 6px; font-weight: 700;">
          Reemplazar por:
        </label>
        <select id="rep-nuevo" style="width: 100%; background: var(--ap-bg);
                  border: 1px solid var(--ap-border); color: var(--ap-text);
                  padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-bottom: 16px;">
          ${candidatos.length === 0
            ? `<option value="">— No hay nodos disponibles —</option>`
            : candidatos.map(c => `
                <option value="${this._esc(c.uid)}">
                  ${this._esc(c.uid)}${c.alias ? ` — ${this._esc(c.alias)}` : ""} · FW ${this._esc(c.firmware)} · ${c.online ? "online" : "offline"}
                </option>
              `).join("")}
        </select>

        <div style="margin-bottom: 16px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 6px 0;">
            <input type="checkbox" id="rep-alias" checked />
            <span>Heredar alias del viejo${viejo.alias ? ` ("${this._esc(viejo.alias)}")` : ""}</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 6px 0;">
            <input type="checkbox" id="rep-notas" checked />
            <span>Heredar notas del viejo</span>
          </label>
        </div>

        <p style="color: var(--ap-text-muted); font-size: 12px; margin: 0 0 16px 0;
                  padding: 10px; background: var(--ap-bg); border-radius: 6px;">
          <i class="fas fa-info-circle"></i>
          El UID viejo se marca como <strong>ignorado</strong> y se reemplaza en
          todos los perfiles. Los perfiles bloqueados no se modifican.
        </p>

        <div class="actions">
          <button class="btn btn-ghost" id="rep-cancel">Cancelar</button>
          <button class="btn btn-primary" id="rep-ok" ${candidatos.length === 0 ? "disabled" : ""}>
            <i class="fas fa-check"></i> Confirmar Reemplazo
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector("#rep-cancel").onclick = close;
    overlay.querySelector("#rep-ok").onclick = async () => {
      const uidNuevo     = overlay.querySelector("#rep-nuevo").value;
      const heredarAlias = overlay.querySelector("#rep-alias").checked;
      const heredarNotas = overlay.querySelector("#rep-notas").checked;

      if (!uidNuevo) {
        this._toast("Seleccioná un nodo nuevo", "warn");
        return;
      }

      try {
        const r = await fetch(`/api/nodos/${uidViejo}/reemplazar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uidNuevo, heredarAlias, heredarNotas }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || "Falló el reemplazo");

        close();
        this._toast(
          `Reemplazo OK: ${data.sensoresMigrados} sensores migrados en ${data.perfilesAfectados.length} perfil(es)`
        );
        await this._cargar(true);
      } catch (e) {
        this._toast(e.message, "error");
      }
    };
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
            <button class="btn btn-danger" id="cf-ok"><i class="fas fa-trash"></i> Borrar</button>
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

window.TabNodos = TabNodos;
