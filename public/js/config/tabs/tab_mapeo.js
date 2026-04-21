// ============================================================
// VistaX — tab_mapeo.js  (v3.0)
//
// Tab "Mapeo Visual": vista SVG de la sembradora vista desde atrás.
//
// Convención visual:
//   - Mirando desde atrás del tractor hacia adelante
//   - Tren con orden=1 → fila INFERIOR (más cerca del operario)
//   - Tren con orden=2 → fila SUPERIOR (más adelante)
//   - Surco 1 → a la izquierda
//   - Numeración de izquierda a derecha
//
// Sub-vistas (modos de coloreo):
//   1. Por estado    — verde=asignado, gris=vacío
//   2. Por nodo      — un color por UID de nodo
//   3. Por tipo      — color según tipo de sensor
//
// Sensores no-siembra (tolvas/turbinas/ejes/etc):
//   - Banda horizontal arriba del dibujo, un icono cada uno
//
// Solo lectura: tap en surco abre popup con detalle pero no edita.
// La edición sigue en el Tab Sensores.
// ============================================================

// Catálogo de tipos (debe matchear con tab_sensores.js)
const MAPEO_TIPOS = {
  semilla:            { label: "Semilla",            icon: "fa-seedling",     color: "#84cc16", cat: "siembra" },
  ferti_linea:        { label: "Fertilizante línea", icon: "fa-droplet",      color: "#3b82f6", cat: "siembra" },
  ferti_costado:      { label: "Fertilizante costado", icon: "fa-droplet",    color: "#06b6d4", cat: "siembra" },
  rotacion_eje:       { label: "Rotación de eje",    icon: "fa-arrows-spin",  color: "#a855f7", cat: "otros" },
  turbina:            { label: "Turbina",            icon: "fa-fan",          color: "#f59e0b", cat: "otros" },
  tolva_vacia:        { label: "Tolva vacía",        icon: "fa-box-open",     color: "#ef4444", cat: "otros" },
  tolva_llena:        { label: "Tolva llena",        icon: "fa-box",          color: "#10b981", cat: "otros" },
  bajada_herramienta: { label: "Bajada herramienta", icon: "fa-down-long",    color: "#8b5cf6", cat: "otros" },
  presion:            { label: "Presión",            icon: "fa-gauge",        color: "#ec4899", cat: "otros" },
  final_carrera:      { label: "Final de carrera",   icon: "fa-circle-dot",   color: "#64748b", cat: "otros" },
};

// Paleta de colores para el modo "por nodo" (cíclica)
const PALETA_NODOS = [
  "#84cc16", "#3b82f6", "#f59e0b", "#a855f7",
  "#ec4899", "#06b6d4", "#10b981", "#ef4444",
  "#8b5cf6", "#f97316",
];

class TabMapeo extends TabBase {
  constructor(opts) {
    super(opts);
    this.modo = "estado"; // estado | nodo | tipo
    this._coloresPorNodo = null;
  }

  async render(container) {
    this.container = container;

    container.innerHTML = `
      <div class="tab-header">
        <h2>
          <i class="fas fa-map"></i>
          Mapeo Visual
          <span class="tab-subtitle">
            Vista de la sembradora desde atrás del tractor — solo lectura
          </span>
        </h2>
        <div class="header-actions">
          <button class="btn" id="btn-mapeo-print">
            <i class="fas fa-print"></i> Imprimir
          </button>
        </div>
      </div>

      <div class="mapeo-controles">
        <div class="mapeo-modo-switch">
          <span class="modo-label">Colorear por:</span>
          <button class="modo-btn active" data-modo="estado">
            <i class="fas fa-check-circle"></i> Estado
          </button>
          <button class="modo-btn" data-modo="nodo">
            <i class="fas fa-microchip"></i> Nodo
          </button>
          <button class="modo-btn" data-modo="tipo">
            <i class="fas fa-tags"></i> Tipo
          </button>
        </div>
        <div class="mapeo-leyenda" id="mapeo-leyenda"></div>
      </div>

      <div class="mapeo-canvas-wrap">
        <div class="mapeo-orientacion">
          <div class="orientacion-flecha"><i class="fas fa-arrow-up"></i> ADELANTE</div>
        </div>
        <div id="mapeo-canvas"></div>
        <div class="mapeo-orientacion">
          <div class="orientacion-operario">
            <i class="fas fa-eye"></i> VISTA DEL OPERARIO (DESDE ATRÁS)
          </div>
        </div>
      </div>
    `;

    container.querySelector("#btn-mapeo-print")
      .addEventListener("click", () => this._imprimir());

    container.querySelectorAll(".modo-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this.modo = btn.dataset.modo;
        container.querySelectorAll(".modo-btn").forEach(b =>
          b.classList.toggle("active", b === btn)
        );
        this._renderCanvas();
        this._renderLeyenda();
      });
    });

    this._renderCanvas();
    this._renderLeyenda();
  }

  // ── Cálculo de estructura ─────────────────────────────────

  _calcularRangos() {
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

    const rangos = [];
    let sig = 1;
    for (const t of arr) {
      rangos.push({
        ...t,
        inicio: sig,
        fin: sig + t.surcos - 1,
      });
      sig += t.surcos;
    }
    return rangos;
  }

  _coloresParaNodos() {
    if (this._coloresPorNodo) return this._coloresPorNodo;
    const sensores = this.perfil?.mapeo_sensores || [];
    const uidsUnicos = [...new Set(sensores.map(s => s.uid))].sort();
    this._coloresPorNodo = {};
    uidsUnicos.forEach((uid, i) => {
      this._coloresPorNodo[uid] = PALETA_NODOS[i % PALETA_NODOS.length];
    });
    return this._coloresPorNodo;
  }

  _sensorEnSurco(trenId, bajada) {
    return (this.perfil?.mapeo_sensores || []).find(s =>
      s.is_active !== false &&
      String(s.tren) === String(trenId) &&
      parseInt(s.bajada) === bajada &&
      MAPEO_TIPOS[s.tipo]?.cat === "siembra"
    );
  }

  _sensoresOtros() {
    return (this.perfil?.mapeo_sensores || []).filter(s =>
      s.is_active !== false &&
      MAPEO_TIPOS[s.tipo]?.cat === "otros"
    );
  }

  // ── Render principal ──────────────────────────────────────

  _renderCanvas() {
    const cont = this.container.querySelector("#mapeo-canvas");
    const rangos = this._calcularRangos();

    if (!rangos || rangos.length === 0) {
      cont.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-train"></i>
          <div class="title">Sin trenes definidos</div>
          <div>Definí trenes en el tab <strong>Trenes</strong> y asigná sensores en <strong>Sensores</strong> para ver el mapeo</div>
        </div>
      `;
      return;
    }

    const otros = this._sensoresOtros();

    // Dimensiones
    const slotSize = 44;
    const slotGap  = 6;
    const trenPadX = 16;
    const trenPadY = 14;
    const trenGap  = 12;
    const headerH  = 28;     // alto del nombre del tren
    const numH     = 16;     // alto del label de número de surco

    const maxSurcos = Math.max(...rangos.map(r => r.surcos));
    const trenW = trenPadX * 2 + maxSurcos * slotSize + (maxSurcos - 1) * slotGap;
    const trenH = trenPadY * 2 + headerH + slotSize + numH;

    const otrosH = otros.length > 0 ? 80 : 0;
    const totalH = otrosH + (trenH + trenGap) * rangos.length + 20;

    // El SVG se dibuja con el orden visual ya invertido:
    //   - El tren con orden mayor va arriba (más adelante)
    //   - El tren con orden menor va abajo (más cerca del operario)
    const rangosVisuales = [...rangos].reverse(); // visual top-down

    // Construir SVG
    let svg = `<svg viewBox="0 0 ${trenW + 40} ${totalH}" xmlns="http://www.w3.org/2000/svg" class="mapeo-svg">`;

    // Banda de "otros sensores" arriba
    if (otros.length > 0) {
      svg += this._renderBandaOtros(otros, trenW + 40);
    }

    // Trenes (arriba hacia abajo en orden visual)
    let yActual = otrosH;
    for (const r of rangosVisuales) {
      svg += this._renderTren(r, 20, yActual, trenW, trenH, slotSize, slotGap, trenPadX, trenPadY, headerH);
      yActual += trenH + trenGap;
    }

    svg += `</svg>`;
    cont.innerHTML = svg;

    // Wire de tap en slots
    cont.querySelectorAll(".slot-mapeo").forEach(slot => {
      slot.addEventListener("click", () => {
        const tren   = slot.getAttribute("data-tren");
        const bajada = parseInt(slot.getAttribute("data-bajada"));
        this._abrirDetalleSurco(tren, bajada);
      });
    });
    cont.querySelectorAll(".otro-mapeo").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-idx"));
        const sensor = otros[idx];
        if (sensor) this._abrirDetalleSensor(sensor);
      });
    });
  }

  _renderTren(r, x, y, w, h, slotSize, slotGap, padX, padY, headerH) {
    let s = `<g transform="translate(${x}, ${y})">`;

    // Caja del tren (rect con fondo)
    s += `
      <rect x="0" y="0" width="${w}" height="${h}" rx="10"
            fill="var(--ap-bg-2)" stroke="var(--ap-border)" stroke-width="1.5" />
    `;

    // Header del tren (nombre + rango)
    s += `
      <text x="${padX}" y="${padY + 14}"
            font-family="var(--font-sans)" font-size="13" font-weight="800"
            fill="var(--ap-text)" text-transform="uppercase"
            letter-spacing="0.5">
        ${this._esc(r.nombre)}
      </text>
      <text x="${w - padX}" y="${padY + 14}"
            font-family="var(--font-mono)" font-size="11" font-weight="700"
            fill="var(--ap-green)" text-anchor="end">
        ${r.inicio} – ${r.fin}  ·  ${r.surcos} surcos
      </text>
    `;

    // Slots de surcos
    const yBase = padY + headerH;
    for (let i = 0; i < r.surcos; i++) {
      const bajada = r.inicio + i;
      const sensor = this._sensorEnSurco(r.id, bajada);
      const slotX = padX + i * (slotSize + slotGap);

      const visual = this._estiloSlot(sensor);

      // Cuadrado del surco
      s += `
        <g class="slot-mapeo" data-tren="${this._esc(r.id)}" data-bajada="${bajada}"
           style="cursor: pointer;">
          <rect x="${slotX}" y="${yBase}" width="${slotSize}" height="${slotSize}" rx="6"
                fill="${visual.fill}" stroke="${visual.stroke}" stroke-width="${visual.strokeWidth}"
                stroke-dasharray="${visual.dash || "none"}" />
      `;

      // Icono dentro del slot (si tiene sensor)
      if (sensor && visual.iconUni) {
        s += `
          <text x="${slotX + slotSize / 2}" y="${yBase + slotSize / 2 + 5}"
                font-family="Font Awesome 6 Free" font-weight="900" font-size="14"
                fill="${visual.iconColor}" text-anchor="middle">
            ${visual.iconUni}
          </text>
        `;
      }

      s += `</g>`;

      // Número del surco debajo
      s += `
        <text x="${slotX + slotSize / 2}" y="${yBase + slotSize + 12}"
              font-family="var(--font-mono)" font-size="10" font-weight="700"
              fill="var(--ap-text-muted)" text-anchor="middle">
          ${bajada}
        </text>
      `;
    }

    s += `</g>`;
    return s;
  }

  _renderBandaOtros(otros, anchoTotal) {
    const iconSize = 56;
    const iconGap  = 12;
    const yBanda   = 16;

    let s = `
      <text x="20" y="12" font-family="var(--font-sans)" font-size="10"
            font-weight="700" fill="var(--ap-text-dim)" text-transform="uppercase"
            letter-spacing="0.5">
        SENSORES AUXILIARES
      </text>
    `;

    let xActual = 20;
    otros.forEach((sensor, idx) => {
      const tipoCfg = MAPEO_TIPOS[sensor.tipo] || { color: "#888", icon: "fa-question" };
      const iconUni = this._iconoUnicode(tipoCfg.icon);

      s += `
        <g class="otro-mapeo" data-idx="${idx}" style="cursor: pointer;"
           transform="translate(${xActual}, ${yBanda})">
          <rect x="0" y="0" width="${iconSize}" height="${iconSize}" rx="8"
                fill="var(--ap-bg-2)" stroke="${tipoCfg.color}" stroke-width="2" />
          <text x="${iconSize/2}" y="${iconSize/2 + 4}"
                font-family="Font Awesome 6 Free" font-weight="900" font-size="20"
                fill="${tipoCfg.color}" text-anchor="middle">
            ${iconUni}
          </text>
          <text x="${iconSize/2}" y="${iconSize + 12}"
                font-family="var(--font-mono)" font-size="9" font-weight="700"
                fill="var(--ap-text-muted)" text-anchor="middle">
            ${this._esc(sensor.uid.slice(-4))}c${sensor.cable}
          </text>
        </g>
      `;
      xActual += iconSize + iconGap;
    });

    return s;
  }

  // ── Estilos según modo de coloreo ─────────────────────────

  _estiloSlot(sensor) {
    if (!sensor) {
      return {
        fill: "rgba(36, 49, 68, 0.4)",
        stroke: "var(--ap-border)",
        strokeWidth: 1.5,
        dash: "4,3",
      };
    }

    const tipoCfg = MAPEO_TIPOS[sensor.tipo] || {};
    let fill, stroke, iconColor;

    if (this.modo === "estado") {
      fill = "rgba(132, 204, 22, 0.18)";
      stroke = "#84cc16";
      iconColor = "#84cc16";
    } else if (this.modo === "nodo") {
      const colores = this._coloresParaNodos();
      const c = colores[sensor.uid] || "#888";
      fill = this._hexToRgba(c, 0.18);
      stroke = c;
      iconColor = c;
    } else if (this.modo === "tipo") {
      const c = tipoCfg.color || "#888";
      fill = this._hexToRgba(c, 0.18);
      stroke = c;
      iconColor = c;
    }

    return {
      fill, stroke, strokeWidth: 2,
      iconColor,
      iconUni: this._iconoUnicode(tipoCfg.icon),
    };
  }

  _hexToRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Mapeo manual de iconos Font Awesome a unicode (subset que usa este tab)
  _iconoUnicode(faClass) {
    const map = {
      "fa-seedling":     "\uf4d8",
      "fa-droplet":      "\uf043",
      "fa-arrows-spin":  "\ue4bb",
      "fa-fan":          "\uf863",
      "fa-box-open":     "\uf49e",
      "fa-box":          "\uf466",
      "fa-down-long":    "\uf309",
      "fa-gauge":        "\uf624",
      "fa-circle-dot":   "\uf192",
      "fa-question":     "\u003f",
    };
    return map[faClass] || "\uf128"; // fa-question por defecto
  }

  // ── Leyenda ───────────────────────────────────────────────

  _renderLeyenda() {
    const cont = this.container.querySelector("#mapeo-leyenda");
    let html = "";

    if (this.modo === "estado") {
      html = `
        <span class="leyenda-item">
          <span class="leyenda-dot" style="background: rgba(132,204,22,0.18); border-color: #84cc16;"></span>
          Asignado
        </span>
        <span class="leyenda-item">
          <span class="leyenda-dot empty"></span>
          Vacío
        </span>
      `;
    } else if (this.modo === "nodo") {
      const colores = this._coloresParaNodos();
      html = Object.entries(colores).map(([uid, color]) => `
        <span class="leyenda-item">
          <span class="leyenda-dot" style="background: ${this._hexToRgba(color, 0.2)}; border-color: ${color};"></span>
          ${this._esc(uid.slice(-6))}
        </span>
      `).join("");
      if (Object.keys(colores).length === 0) {
        html = `<span class="leyenda-vacia">No hay sensores asignados</span>`;
      }
    } else if (this.modo === "tipo") {
      const tiposUsados = new Set();
      (this.perfil?.mapeo_sensores || []).forEach(s => {
        if (s.is_active !== false) tiposUsados.add(s.tipo);
      });
      html = [...tiposUsados].map(t => {
        const cfg = MAPEO_TIPOS[t] || {};
        return `
          <span class="leyenda-item">
            <span class="leyenda-dot" style="background: ${this._hexToRgba(cfg.color || "#888", 0.2)}; border-color: ${cfg.color || "#888"};"></span>
            ${this._esc(cfg.label || t)}
          </span>
        `;
      }).join("");
      if (tiposUsados.size === 0) {
        html = `<span class="leyenda-vacia">No hay sensores asignados</span>`;
      }
    }

    cont.innerHTML = html;
  }

  // ── Detalle (popup al tocar slot/icono) ───────────────────

  _abrirDetalleSurco(trenId, bajada) {
    const sensor = this._sensorEnSurco(trenId, bajada);
    const tren = this._calcularRangos()?.find(r => String(r.id) === String(trenId));

    const overlay = document.createElement("div");
    overlay.className = "cfg-prompt-overlay";

    if (!sensor) {
      overlay.innerHTML = `
        <div class="cfg-prompt" style="min-width: 360px;">
          <h3><i class="fas fa-circle-dot"></i> Surco ${bajada}</h3>
          <p style="color: var(--ap-text-muted); margin: 0 0 16px 0;">
            ${this._esc(tren?.nombre || `Tren ${trenId}`)} — Sin sensor asignado
          </p>
          <div class="info-box">
            <i class="fas fa-arrow-right"></i>
            <span>Para asignar un sensor a este surco, andá al tab <strong>Sensores</strong></span>
          </div>
          <div class="actions">
            <div style="flex:1"></div>
            <button class="btn btn-primary" id="d-ok">Cerrar</button>
          </div>
        </div>
      `;
    } else {
      const tipoCfg = MAPEO_TIPOS[sensor.tipo] || {};
      overlay.innerHTML = `
        <div class="cfg-prompt" style="min-width: 380px;">
          <h3>
            <i class="fas ${tipoCfg.icon}" style="color: ${tipoCfg.color}"></i>
            Surco ${bajada}
          </h3>
          <div class="detalle-grid">
            <div class="detalle-row"><span>Tren</span><strong>${this._esc(tren?.nombre || trenId)}</strong></div>
            <div class="detalle-row"><span>Tipo</span><strong>${this._esc(tipoCfg.label || sensor.tipo)}</strong></div>
            <div class="detalle-row"><span>Nodo</span><strong style="font-family: var(--font-mono);">${this._esc(sensor.uid)}</strong></div>
            <div class="detalle-row"><span>Cable</span><strong style="font-family: var(--font-mono); color: var(--ap-green);">c${sensor.cable}</strong></div>
            ${sensor.nombre ? `<div class="detalle-row"><span>Nombre</span><strong>${this._esc(sensor.nombre)}</strong></div>` : ""}
            ${sensor.logica_invertida ? `<div class="detalle-row"><span>Lógica</span><strong style="color: var(--ap-yellow);">Invertida</strong></div>` : ""}
          </div>
          <div class="actions">
            <div style="flex:1"></div>
            <button class="btn btn-primary" id="d-ok">Cerrar</button>
          </div>
        </div>
      `;
    }

    document.body.appendChild(overlay);
    overlay.querySelector("#d-ok").onclick = () => overlay.remove();
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  }

  _abrirDetalleSensor(sensor) {
    const tipoCfg = MAPEO_TIPOS[sensor.tipo] || {};
    const overlay = document.createElement("div");
    overlay.className = "cfg-prompt-overlay";
    overlay.innerHTML = `
      <div class="cfg-prompt" style="min-width: 380px;">
        <h3>
          <i class="fas ${tipoCfg.icon}" style="color: ${tipoCfg.color}"></i>
          ${this._esc(tipoCfg.label || sensor.tipo)}
        </h3>
        <div class="detalle-grid">
          <div class="detalle-row"><span>Nodo</span><strong style="font-family: var(--font-mono);">${this._esc(sensor.uid)}</strong></div>
          <div class="detalle-row"><span>Cable</span><strong style="font-family: var(--font-mono); color: var(--ap-green);">c${sensor.cable}</strong></div>
          ${sensor.nombre ? `<div class="detalle-row"><span>Nombre</span><strong>${this._esc(sensor.nombre)}</strong></div>` : ""}
          ${sensor.logica_invertida ? `<div class="detalle-row"><span>Lógica</span><strong style="color: var(--ap-yellow);">Invertida</strong></div>` : ""}
        </div>
        <div class="actions">
          <div style="flex:1"></div>
          <button class="btn btn-primary" id="d-ok">Cerrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#d-ok").onclick = () => overlay.remove();
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Imprimir ──────────────────────────────────────────────

  _imprimir() {
    const svg = this.container.querySelector("#mapeo-canvas").innerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    win.document.write(`
      <!DOCTYPE html>
      <html><head>
        <title>Mapeo Visual — ${this._esc(this.perfil?.nombre || "Perfil")}</title>
        <style>
          body { background: #fff; padding: 20px; font-family: sans-serif; }
          h1 { font-size: 18px; }
          svg { width: 100%; max-width: 1200px; }
        </style>
      </head><body>
        <h1>Mapeo Visual — ${this._esc(this.perfil?.nombre || "Perfil")}</h1>
        ${svg}
        <script>window.onload = () => setTimeout(() => window.print(), 200);<\/script>
      </body></html>
    `);
    win.document.close();
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}

window.TabMapeo = TabMapeo;
