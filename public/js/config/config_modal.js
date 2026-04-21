// ============================================================
// VistaX — config_modal.js  (v3.0)
//
// Orquestador del modal de configuración (página /config).
// Reglas de oro:
//   1. SIEMPRE fetch fresco al abrir — nunca window.APP_CONFIG
//   2. Cada tab se renderiza lazy (solo cuando se selecciona)
//   3. Los tabs se destruyen y limpian listeners al cerrar el modal
//   4. El perfil activo es la fuente única de verdad de los tabs
// ============================================================

class ConfigModal {
  constructor() {
    this.perfil    = null;
    this.activoId  = null;
    this.tabs      = {};        // instancias activas { nombreTab: instancia }
    this.tabActual = null;

    // Registro de tabs disponibles. A medida que se vayan implementando,
    // se quita "disabled" en el EJS y se agrega la clase aquí.
    this.tabRegistry = {
      perfiles:  window.TabPerfiles,
      nodos:     window.TabNodos,     // Commit 2
      trenes:    window.TabTrenes,    // Commit 3
      sensores:  window.TabSensores,  // Commit 4
      monitoreo: window.TabMonitoreo, // Commit 5
      pantalla:  window.TabPantalla,  // Commit 6
      mapeo:     window.TabMapeo,     // Commit 7
    };
  }

  // ── Ciclo de vida ─────────────────────────────────────────

  async abrir() {
    try {
      await this.recargarPerfil();
      this.actualizarPerfilActivo();
      this._wireSidebar();
      this._mostrarTab("perfiles"); // tab por defecto
    } catch (e) {
      console.error("[ConfigModal] Error al abrir:", e);
      this._renderError(e.message);
    }
  }
  async guardarPerfil() {
    if (!this.perfil) throw new Error("No hay perfil cargado");
 
    // Merge: partimos del perfil actual y aplicamos cada slice
    const merged = JSON.parse(JSON.stringify(this.perfil));
 
    for (const [nombre, tab] of Object.entries(this.tabs)) {
      if (typeof tab.recolectar !== "function") continue;
      const slice = tab.recolectar();
      if (slice && typeof slice === "object") {
        Object.assign(merged, slice);
      }
    }
 
    const r = await fetch("/api/config/maquinas/guardar", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(merged),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "Error al guardar perfil");
 
    // Recargar el perfil fresco del backend para que todos los tabs
    // siguientes lo vean actualizado
    await this.recargarPerfil();
    this.actualizarPerfilActivo();
 
    return data;
  }
  /**
   * Recarga el perfil activo desde el backend.
   * Esto es lo que mata el bug viejo de APP_CONFIG stale.
   */
  async recargarPerfil() {
    // 1. Obtener id del perfil activo
    const rList = await fetch("/api/config/perfiles");
    const dList = await rList.json();
    if (!dList.ok) throw new Error("No se pudo listar perfiles");
    this.activoId = dList.activo;

    if (!this.activoId) {
      this.perfil = null;
      return;
    }

    // 2. Fetch del perfil completo
    const rPerfil = await fetch(`/api/config/maquinas/${this.activoId}`);
    if (!rPerfil.ok) throw new Error("No se pudo cargar el perfil activo");
    this.perfil = await rPerfil.json();

    console.log(`[ConfigModal] Perfil cargado: ${this.activoId}`,
                this.perfil?.nombre || "");
  }

  cerrar() {
    Object.values(this.tabs).forEach(t => t.destroy?.());
    this.tabs = {};
  }

  // ── Sidebar y navegación ──────────────────────────────────

_wireSidebar() {
  const sidebar = document.getElementById("cfg-sidebar");
  sidebar.querySelectorAll(".cfg-tab").forEach(el => {
    el.addEventListener("click", () => {
      if (el.classList.contains("disabled")) {
        this.toast("Esta sección está en construcción", "warn");
        return;
      }
      const tabName = el.dataset.tab;
      if (!tabName) return;  // ← NUEVO: items sin data-tab manejan su propio onclick
      this._mostrarTab(tabName);
    });
  });
}

  _mostrarTab(nombre) {
    const TabClass = this.tabRegistry[nombre];
    if (!TabClass) {
      console.warn(`[ConfigModal] Tab "${nombre}" no registrado`);
      return;
    }

    // Marcar visualmente el tab activo en la sidebar
    document.querySelectorAll(".cfg-tab").forEach(el => {
      el.classList.toggle("active", el.dataset.tab === nombre);
    });

    // Destruir el tab anterior (libera listeners de socket)
    if (this.tabActual && this.tabs[this.tabActual]) {
      this.tabs[this.tabActual].destroy?.();
      delete this.tabs[this.tabActual];
    }

    // Instanciar el nuevo tab con el perfil FRESCO
    const tab = new TabClass({
      perfil: this.perfil,
      api:    this._buildApiHelper(),
      io:     window.io ? window.io() : null,
      parent: this,
    });
    this.tabs[nombre] = tab;
    this.tabActual    = nombre;

    // Renderizar
    const content = document.getElementById("cfg-content");
    content.innerHTML = "";
    tab.render(content);
  }

  // ── UI helpers ────────────────────────────────────────────

  actualizarPerfilActivo() {
    const el = document.getElementById("cfg-perfil-activo");
    if (!el) return;
    el.textContent = this.perfil?.nombre || this.activoId || "Sin perfil";
  }

  toast(mensaje, tipo = "ok") {
    const cont = document.getElementById("toast-container");
    if (!cont) return;

    const icon = {
      ok:    "fa-check-circle",
      error: "fa-circle-exclamation",
      warn:  "fa-triangle-exclamation",
    }[tipo] || "fa-check-circle";

    const el = document.createElement("div");
    el.className = `toast ${tipo === "ok" ? "" : tipo}`;
    el.innerHTML = `<i class="fas ${icon}"></i>${this._esc(mensaje)}`;
    cont.appendChild(el);

    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.2s";
      setTimeout(() => el.remove(), 200);
    }, 3000);
  }

  _renderError(msg) {
    const content = document.getElementById("cfg-content");
    content.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-triangle-exclamation" style="color: var(--ap-red);"></i>
        <div class="title">Error al cargar configuración</div>
        <div>${this._esc(msg)}</div>
        <button class="btn btn-primary" style="margin-top: 20px;"
                onclick="window.cfgModal.abrir()">
          <i class="fas fa-rotate-right"></i> Reintentar
        </button>
      </div>
    `;
  }

  _buildApiHelper() {
    // Wrapper mínimo para que los tabs no repitan boilerplate de fetch
    return {
      get: async (url) => {
        const r = await fetch(url);
        return r.json();
      },
      post: async (url, body) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return r.json();
      },
      patch: async (url, body) => {
        const r = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return r.json();
      },
      del: async (url) => {
        const r = await fetch(url, { method: "DELETE" });
        return r.json();
      },
    };
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}

window.ConfigModal = ConfigModal;

// Cleanup al cerrar la ventana
window.addEventListener("beforeunload", () => {
  window.cfgModal?.cerrar();
});
