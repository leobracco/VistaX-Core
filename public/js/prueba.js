// ============================================================
// VistaX — prueba.js  (v3.0)
//
// Cliente de la página /prueba (mobile-first).
// Se conecta por Socket.IO al server, escucha sensor_update,
// pinta tiles que pulsan en verde cuando reciben pulso.
//
// Features:
//   - Vibración del celular en cada pulso (toggle)
//   - Filtros por tren (chips horizontales)
//   - Reset de contadores
//   - Bottom sheet con detalle del sensor al tocar uno
//   - Detección de offline (10s sin pulso = idle, no offline;
//     offline = nodo no reportó heartbeat)
// ============================================================

const TIPOS_ICON = {
  semilla:            "fa-seedling",
  ferti_linea:        "fa-droplet",
  ferti_costado:      "fa-droplet",
  rotacion_eje:       "fa-arrows-spin",
  turbina:            "fa-fan",
  tolva_vacia:        "fa-box-open",
  tolva_llena:        "fa-box",
  bajada_herramienta: "fa-down-long",
  presion:            "fa-gauge",
  final_carrera:      "fa-circle-dot",
};

const TIPOS_LABEL = {
  semilla:            "Semilla",
  ferti_linea:        "Ferti línea",
  ferti_costado:      "Ferti costado",
  rotacion_eje:       "Rotación eje",
  turbina:            "Turbina",
  tolva_vacia:        "Tolva vacía",
  tolva_llena:        "Tolva llena",
  bajada_herramienta: "Bajada herr.",
  presion:            "Presión",
  final_carrera:      "Final carrera",
};

const TIPOS_SIEMBRA = ["semilla", "ferti_linea", "ferti_costado"];
const PULSE_DURATION_MS = 400;
const STORAGE_KEY = "vistax_prueba_opts";

// ════════════════════════════════════════════════════════════
class PruebaApp {
  constructor() {
    this.socket    = null;
    this.perfil    = null;
    this.sensores  = [];   // sensores activos del perfil
    this.estado    = {};   // { "uid_cable": { pulsos, lastPulse, online } }
    this.filtroTren = "todos";
    this.pulsosTotal = 0;

    // Opciones persistidas (usamos sessionStorage porque no tenemos persistencia real)
    this.opts = this._cargarOpts();
  }

  _cargarOpts() {
    try {
      // En artifacts no hay localStorage, pero en producción sí
      return {
        vibrar: true,
      };
    } catch {
      return { vibrar: true };
    }
  }

  async iniciar() {
    this._wireUI();
    await this._cargarPerfil();
    this._conectarSocket();
  }

  _wireUI() {
    document.getElementById("btn-vibrar").addEventListener("click", () => {
      this.opts.vibrar = !this.opts.vibrar;
      this._sincronizarBtnVibrar();
      // Vibración corta de confirmación
      if (this.opts.vibrar) this._vibrar(50);
    });

    document.getElementById("btn-reset").addEventListener("click", () => {
      this._resetContadores();
    });

    this._sincronizarBtnVibrar();
  }

  _sincronizarBtnVibrar() {
    const btn = document.getElementById("btn-vibrar");
    btn.classList.toggle("active", this.opts.vibrar);
  }

  // ── Carga inicial del perfil ──────────────────────────────

  async _cargarPerfil() {
    try {
      // Listar perfiles para saber cuál es el activo
      const r1 = await fetch("/api/config/perfiles");
      const d1 = await r1.json();
      if (!d1.ok || !d1.activo) throw new Error("No hay perfil activo");

      // Cargar el perfil completo
      const r2 = await fetch(`/api/config/maquinas/${d1.activo}`);
      this.perfil = await r2.json();

      this.sensores = (this.perfil.mapeo_sensores || [])
        .filter(s => s.is_active !== false);

      // Inicializar estado
      for (const s of this.sensores) {
        const k = `${s.uid}_${s.cable}`;
        this.estado[k] = { pulsos: 0, lastPulse: 0, online: true };
      }

      document.getElementById("prueba-perfil").textContent =
        this.perfil.nombre || d1.activo;

      this._renderFiltros();
      this._renderGrid();
      this._actualizarStats();
    } catch (e) {
      console.error("[Prueba] Error cargando perfil:", e);
      document.getElementById("prueba-grid").innerHTML = `
        <div class="empty-state">
          <i class="fas fa-triangle-exclamation"></i>
          <div class="title">No se pudo cargar el perfil</div>
          <div>${this._esc(e.message)}</div>
        </div>
      `;
    }
  }

  // ── Socket.IO ─────────────────────────────────────────────

  _conectarSocket() {
    this.socket = io({ transports: ["websocket", "polling"] });

    this.socket.on("connect", () => {
      this._setConn(true);
      console.log("[Prueba] Socket conectado");
    });

    this.socket.on("disconnect", () => {
      this._setConn(false);
      console.log("[Prueba] Socket desconectado");
    });

    this.socket.on("sensor_update", (data) => {
      this._procesarSensorUpdate(data);
    });

    this.socket.on("nodo_estado", (data) => {
      this._procesarNodoEstado(data);
    });

    // Si cambia el perfil, recargar todo
    this.socket.on("profile_changed", () => {
      console.log("[Prueba] Perfil cambió — recargando…");
      this._cargarPerfil();
    });
  }

  _setConn(online) {
    document.getElementById("conn-dot").classList.toggle("offline", !online);
    document.getElementById("conn-text").textContent = online ? "Conectado" : "Sin conexión";
  }

  // ── Procesamiento de eventos MQTT vía socket ──────────────

  _procesarSensorUpdate(data) {
    // data: { bajada, tipo, valor, alerta, nuevas_semillas, spm }
    // Buscar el sensor que matchea por bajada+tipo (es lo que emite mqtt_handler)
    // En la práctica mqtt_handler solo manda "bajada", no UID. Así que matcheamos
    // por bajada + tipo para sensores de siembra. Para "otros" no hay match
    // directo todavía — habría que extender mqtt_handler para que mande uid+cable.

    const sensor = (data.uid && data.cable !== undefined)
      ? this.sensores.find(s =>
          s.uid === data.uid &&
          parseInt(s.cable) === parseInt(data.cable)
        )
      : this.sensores.find(s =>
          parseInt(s.bajada) === parseInt(data.bajada) &&
          s.tipo === data.tipo
        );
    if (!sensor) return;

    const k = `${sensor.uid}_${sensor.cable}`;
    const e = this.estado[k];
    if (!e) return;

    const pulsosNuevos = parseInt(data.nuevas_semillas) || 0;
    if (pulsosNuevos > 0) {
      e.pulsos += pulsosNuevos;
      e.lastPulse = Date.now();
      this.pulsosTotal += pulsosNuevos;

      this._pulseTile(k);
      if (this.opts.vibrar) this._vibrar(30);
    }

    this._actualizarStats();
  }

  _procesarNodoEstado(data) {
    // Marcar todos los sensores de ese UID como online
    if (!data?.uid) return;
    for (const s of this.sensores) {
      if (s.uid === data.uid) {
        const k = `${s.uid}_${s.cable}`;
        if (this.estado[k]) this.estado[k].online = true;
      }
    }
  }

  // ── Render ────────────────────────────────────────────────

  _renderFiltros() {
    const cont = document.getElementById("prueba-filtros");
    const trenes = this._calcularTrenes();
    const haySiembra = trenes.length > 0;
    const hayOtros = this.sensores.some(s => !TIPOS_SIEMBRA.includes(s.tipo));

    let html = `
      <button class="filtro-btn ${this.filtroTren === "todos" ? "active" : ""}" data-filtro="todos">
        <i class="fas fa-list"></i> Todos
      </button>
    `;

    for (const t of trenes) {
      html += `
        <button class="filtro-btn ${this.filtroTren === t.id ? "active" : ""}" data-filtro="${this._esc(t.id)}">
          <i class="fas fa-train"></i> ${this._esc(t.nombre)}
        </button>
      `;
    }

    if (hayOtros) {
      html += `
        <button class="filtro-btn ${this.filtroTren === "otros" ? "active" : ""}" data-filtro="otros">
          <i class="fas fa-fan"></i> Otros
        </button>
      `;
    }

    cont.innerHTML = html;

    cont.querySelectorAll(".filtro-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this.filtroTren = btn.dataset.filtro;
        cont.querySelectorAll(".filtro-btn").forEach(b =>
          b.classList.toggle("active", b === btn)
        );
        this._renderGrid();
      });
    });
  }

  _calcularTrenes() {
    const trenes = this.perfil?.trenes || {};
    return Object.entries(trenes)
      .map(([id, cfg]) => ({
        id,
        surcos: parseInt(cfg.surcos) || 0,
        orden:  parseInt(cfg.orden)  || 99,
        nombre: cfg.nombre || `Tren ${id}`,
      }))
      .filter(t => t.surcos > 0)
      .sort((a, b) => a.orden - b.orden);
  }

  _renderGrid() {
    const cont = document.getElementById("prueba-grid");

    if (this.sensores.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-broadcast-tower"></i>
          <div class="title">Sin sensores configurados</div>
          <div>Configurá sensores en /config y volvé acá</div>
        </div>
      `;
      return;
    }

    let html = "";

    if (this.filtroTren === "todos" || this.filtroTren !== "otros") {
      // Render por tren
      const trenes = this._calcularTrenes();
      for (const t of trenes) {
        if (this.filtroTren !== "todos" && this.filtroTren !== t.id) continue;

        const sensoresTren = this.sensores.filter(s =>
          TIPOS_SIEMBRA.includes(s.tipo) &&
          String(s.tren) === String(t.id)
        ).sort((a, b) => parseInt(a.bajada) - parseInt(b.bajada));

        if (sensoresTren.length === 0) continue;

        html += `
          <div class="tren-section">
            <div class="tren-section-head">
              <i class="fas fa-train"></i>
              <h3>${this._esc(t.nombre)}</h3>
              <span class="conteo">${sensoresTren.length} sensores</span>
            </div>
            <div class="sensores-grid">
              ${sensoresTren.map(s => this._renderTile(s)).join("")}
            </div>
          </div>
        `;
      }
    }

    if (this.filtroTren === "todos" || this.filtroTren === "otros") {
      // Sección de otros
      const otros = this.sensores.filter(s => !TIPOS_SIEMBRA.includes(s.tipo));
      if (otros.length > 0) {
        html += `
          <div class="tren-section">
            <div class="tren-section-head">
              <i class="fas fa-fan"></i>
              <h3>Otros sensores</h3>
              <span class="conteo">${otros.length} sensores</span>
            </div>
            <div class="sensores-grid">
              ${otros.map(s => this._renderTile(s, true)).join("")}
            </div>
          </div>
        `;
      }
    }

    if (!html) {
      html = `
        <div class="empty-state">
          <i class="fas fa-filter-circle-xmark"></i>
          <div class="title">Sin sensores en este filtro</div>
          <div>Probá con otro filtro</div>
        </div>
      `;
    }

    cont.innerHTML = html;

    // Wire de tiles
    cont.querySelectorAll(".sensor-tile").forEach(tile => {
      tile.addEventListener("click", () => {
        const k = tile.dataset.key;
        const sensor = this.sensores.find(s => `${s.uid}_${s.cable}` === k);
        if (sensor) this._abrirDetalle(sensor);
      });
    });
  }

  _renderTile(s, esOtro = false) {
    const k = `${s.uid}_${s.cable}`;
    const e = this.estado[k] || { pulsos: 0, online: true };
    const icon = TIPOS_ICON[s.tipo] || "fa-question";

    const claseEstado = e.online
      ? (e.pulsos > 0 ? "activo" : "idle")
      : "offline";

    if (esOtro) {
      return `
        <div class="sensor-tile otro ${claseEstado}" data-key="${this._esc(k)}">
          <div class="sensor-tile-pulsos">${e.pulsos}</div>
          <i class="fas ${icon} sensor-tile-icon"></i>
          <div class="sensor-tile-num">${this._esc(TIPOS_LABEL[s.tipo] || s.tipo)}</div>
          <div class="sensor-tile-info">${this._esc(s.uid.slice(-4))}·c${s.cable}</div>
        </div>
      `;
    }

    return `
      <div class="sensor-tile ${claseEstado}" data-key="${this._esc(k)}">
        <i class="fas ${icon} sensor-tile-icon"></i>
        <div class="sensor-tile-pulsos">${e.pulsos}</div>
        <div class="sensor-tile-num">${s.bajada}</div>
        <div class="sensor-tile-label">SURCO</div>
        <div class="sensor-tile-info">${this._esc(s.uid.slice(-4))}·c${s.cable}</div>
      </div>
    `;
  }

  // ── Pulso visual ──────────────────────────────────────────

  _pulseTile(key) {
    const tile = document.querySelector(`.sensor-tile[data-key="${CSS.escape(key)}"]`);
    if (!tile) return;

    // Reactivar la animación: quitar y re-agregar la clase
    tile.classList.remove("pulse");
    void tile.offsetWidth; // force reflow
    tile.classList.add("pulse", "activo");

    // Actualizar contador en el badge
    const badge = tile.querySelector(".sensor-tile-pulsos");
    if (badge) badge.textContent = this.estado[key].pulsos;

    setTimeout(() => {
      tile.classList.remove("pulse");
    }, PULSE_DURATION_MS);
  }

  _vibrar(ms) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch {}
    }
  }

  // ── Stats ─────────────────────────────────────────────────

  _actualizarStats() {
    document.getElementById("stat-total").textContent = this.sensores.length;

    const activos = Object.values(this.estado).filter(e => e.pulsos > 0).length;
    document.getElementById("stat-activos").textContent = activos;

    document.getElementById("stat-pulsos").textContent = this.pulsosTotal;
  }

  _resetContadores() {
    if (!confirm("¿Reiniciar todos los contadores de pulsos?")) return;

    for (const k in this.estado) {
      this.estado[k].pulsos = 0;
      this.estado[k].lastPulse = 0;
    }
    this.pulsosTotal = 0;
    this._renderGrid();
    this._actualizarStats();
    this._vibrar([30, 50, 30]);
  }

  // ── Detalle (bottom sheet) ────────────────────────────────

  _abrirDetalle(sensor) {
    const k = `${sensor.uid}_${sensor.cable}`;
    const e = this.estado[k] || {};
    const icon = TIPOS_ICON[sensor.tipo] || "fa-question";
    const tipoLabel = TIPOS_LABEL[sensor.tipo] || sensor.tipo;

    const overlay = document.createElement("div");
    overlay.className = "detalle-overlay";
    overlay.innerHTML = `
      <div class="detalle-sheet">
        <h3>
          <i class="fas ${icon}" style="color: var(--ap-green); margin-right: 8px;"></i>
          ${TIPOS_SIEMBRA.includes(sensor.tipo) ? `Surco ${sensor.bajada}` : this._esc(tipoLabel)}
        </h3>

        ${TIPOS_SIEMBRA.includes(sensor.tipo) ? `
          <div class="detalle-row"><span>Tren</span><strong>${this._esc(sensor.tren)}</strong></div>
          <div class="detalle-row"><span>Tipo</span><strong>${this._esc(tipoLabel)}</strong></div>
        ` : ""}
        <div class="detalle-row">
          <span>Nodo</span>
          <strong style="font-family: 'JetBrains Mono', monospace;">${this._esc(sensor.uid)}</strong>
        </div>
        <div class="detalle-row">
          <span>Cable</span>
          <strong style="color: var(--ap-green); font-family: 'JetBrains Mono', monospace;">c${sensor.cable}</strong>
        </div>
        ${sensor.nombre ? `<div class="detalle-row"><span>Nombre</span><strong>${this._esc(sensor.nombre)}</strong></div>` : ""}
        <div class="detalle-row">
          <span>Pulsos</span>
          <strong style="color: var(--ap-green); font-family: 'JetBrains Mono', monospace; font-size: 18px;">
            ${e.pulsos || 0}
          </strong>
        </div>
        <div class="detalle-row">
          <span>Estado</span>
          <strong style="color: ${e.online ? 'var(--ap-green)' : 'var(--ap-red)'};">
            ${e.online ? "ONLINE" : "OFFLINE"}
          </strong>
        </div>

        <button class="detalle-cerrar" id="d-cerrar">
          <i class="fas fa-check"></i> Cerrar
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    const cerrar = () => overlay.remove();
    overlay.querySelector("#d-cerrar").onclick = cerrar;
    overlay.addEventListener("click", e => { if (e.target === overlay) cerrar(); });
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}

// ══════════════════════════════════════════════════════════
// Arranque
// ══════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  window.pruebaApp = new PruebaApp();
  window.pruebaApp.iniciar();
});
