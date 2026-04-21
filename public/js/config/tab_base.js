// ============================================================
// VistaX — tab_base.js  (v3.0)
//
// Clase abstracta que heredan todos los tabs del modal de
// configuración. Define el contrato común:
//
//   render(container)   → pinta el HTML del tab
//   recolectar()        → devuelve el slice del perfil que modifica (o null)
//   validar()           → { ok: bool, errores: [string] }
//   destroy()           → limpia listeners, sockets, timers
//
// Cada tab recibe en el constructor:
//   - perfil  : el JSON del perfil ACTIVO (siempre fresco del backend)
//   - api     : helpers para llamar /api (fetch wrapper)
//   - io      : socket.io client (compartido)
//   - parent  : referencia al ConfigModal orquestador (para toasts, recargas)
// ============================================================

class TabBase {
  constructor({ perfil, api, io, parent }) {
    this.perfil    = perfil;
    this.api       = api;
    this.io        = io;
    this.parent    = parent;
    this.container = null;
    this._listeners = []; // [{ target, event, handler }]
  }

  /**
   * Pinta el HTML del tab dentro del container dado.
   * Las subclases lo implementan.
   */
  render(container) {
    this.container = container;
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-screwdriver-wrench"></i>
        <div class="title">Tab sin implementar</div>
        <div>Esta sección está en construcción.</div>
      </div>
    `;
  }

  /**
   * Devuelve el slice del perfil que este tab modifica,
   * o null si no participa en el guardado global.
   * Ejemplo:
   *   return { mapeo_sensores: [...] }
   *   return { trenes: {...} }
   */
  recolectar() {
    return null;
  }

  /**
   * Valida el estado actual del tab antes de guardar.
   */
  validar() {
    return { ok: true, errores: [] };
  }

  /**
   * Limpia listeners, sockets y timers cuando el modal se cierra
   * o cuando el tab se reemplaza.
   */
  destroy() {
    this._listeners.forEach(({ target, event, handler }) => {
      target.removeEventListener?.(event, handler);
      target.off?.(event, handler);
    });
    this._listeners = [];
  }

  // ── Helpers protegidos ────────────────────────────────────

  /**
   * Helper para registrar listeners que se limpian solos en destroy().
   */
  _on(target, event, handler) {
    if (target.addEventListener) target.addEventListener(event, handler);
    else if (target.on) target.on(event, handler);
    this._listeners.push({ target, event, handler });
  }

  /**
   * Atajo para mostrar un toast desde el tab.
   */
  _toast(msg, tipo = "ok") {
    this.parent?.toast(msg, tipo);
  }

  /**
   * Recarga el perfil desde el backend y vuelve a renderizar el tab.
   * Útil cuando una acción del tab cambia el perfil en el server
   * (ej: activar otro perfil, crear uno nuevo).
   */
  async _recargarPerfil() {
    if (this.parent?.recargarPerfil) {
      await this.parent.recargarPerfil();
      this.perfil = this.parent.perfil;
      this.render(this.container);
    }
  }
}

window.TabBase = TabBase;
