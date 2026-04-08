// ============================================================
// VistaX — nodos_inventario.js
// JS del tab "Nodos" en el modal de configuración
// ============================================================

(function() {
  let nodosCache = [];
  let filtroActivo = "todos";
  let busquedaActiva = "";

  // ── Carga inicial y refresco ────────────────────────────
  window.recargarNodosInventario = async function() {
    try {
      const res = await fetch("/api/nodos");
      const data = await res.json();
      if (data.ok) {
        nodosCache = data.nodos;
        renderizarNodos();
      }
    } catch (e) {
      console.error("Error cargando inventario de nodos:", e);
    }
  };

  // ── Renderizado de la tabla ─────────────────────────────
  function renderizarNodos() {
    const tbody = document.getElementById("nodos-inventario-tbody");
    if (!tbody) return;

    let filtrados = nodosCache;
    if (filtroActivo !== "todos") {
      filtrados = filtrados.filter(n => n.estado === filtroActivo);
    }
    if (busquedaActiva) {
      const q = busquedaActiva.toLowerCase();
      filtrados = filtrados.filter(n =>
        n.uid.toLowerCase().includes(q) ||
        (n.alias || "").toLowerCase().includes(q)
      );
    }

    if (filtrados.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#555; padding:30px">
        No hay nodos que coincidan con el filtro
      </td></tr>`;
      return;
    }

    tbody.innerHTML = filtrados.map(n => filaNodo(n)).join("");
  }

  function filaNodo(n) {
    const dotColor = {
      registrado:    "#3a3",
      sin_registrar: "#dc3",
      offline:       "#888",
      ignorado:      "#444",
      error:         "#d33",
    }[n.estado] || "#555";

    const tiempoTexto = formatearTiempo(n.segundos_desde_visto);
    const rssiBadge = n.rssi !== null
      ? `<span style="color:${rssiColor(n.rssi)}">${n.rssi} dBm</span>`
      : "—";
    const perfilesTexto = n.perfiles_asignado.length > 0
      ? n.perfiles_asignado.join(", ")
      : `<span style="color:#555">—</span>`;
    const aliasHtml = n.alias
      ? `<div style="font-size:11px;color:#888">${escapeHtml(n.alias)}</div>`
      : "";

    return `
      <tr data-uid="${n.uid}">
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor}"
              title="${n.estado}"></span></td>
        <td>
          <div style="font-weight:600;color:#ddd">${n.uid}</div>
          ${aliasHtml}
        </td>
        <td><span style="font-family:monospace;color:#888">${n.firmware || "?"}</span></td>
        <td>${rssiBadge}</td>
        <td><span style="font-family:monospace;font-size:11px;color:#888">${n.ip || "?"}</span></td>
        <td style="font-size:11px">${perfilesTexto}</td>
        <td><span style="font-size:11px;color:#888">${tiempoTexto}</span></td>
        <td style="text-align:center">
          <div class="nodo-actions" style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
            <button class="btn-icon" title="Detalle / Editar" onclick="abrirDetalleNodo('${n.uid}')">
              <i class="fas fa-eye"></i>
            </button>
            ${n.perfiles_asignado.length > 0
              ? `<button class="btn-icon" title="Ir al perfil" onclick="irAPerfilDeNodo('${n.uid}', '${n.perfiles_asignado[0]}')">
                  <i class="fas fa-edit"></i>
                </button>`
              : ""}
            <button class="btn-icon" title="Reiniciar" onclick="comandoNodo('${n.uid}', 'reiniciar')">
              <i class="fas fa-redo"></i>
            </button>
            <button class="btn-icon btn-icon-warn" title="${n.ignorado ? 'Designorar' : 'Ignorar'}"
                    onclick="toggleIgnorarNodo('${n.uid}', ${!n.ignorado})">
              <i class="fas fa-${n.ignorado ? 'eye' : 'ban'}"></i>
            </button>
            <button class="btn-icon btn-icon-danger" title="Borrar" onclick="borrarNodo('${n.uid}')">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  // ── Helpers de formato ──────────────────────────────────
  function formatearTiempo(segs) {
    if (!segs || segs < 0) return "—";
    if (segs < 60)    return `hace ${segs}s`;
    if (segs < 3600)  return `hace ${Math.floor(segs/60)}m`;
    if (segs < 86400) return `hace ${Math.floor(segs/3600)}h`;
    return `hace ${Math.floor(segs/86400)}d`;
  }

  function rssiColor(rssi) {
    if (rssi >= -65) return "#3a3";
    if (rssi >= -78) return "#dc3";
    return "#d33";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ── Acciones por nodo ───────────────────────────────────
  window.abrirDetalleNodo = async function(uid) {
    const res = await fetch(`/api/nodos/${uid}`);
    const data = await res.json();
    if (!data.ok) return alert("No se pudo cargar el nodo");

    const n = data.nodo;
    const body = document.getElementById("modal-nodo-detalle-body");
    body.innerHTML = `
      <div style="display:grid;gap:12px;color:#bbb;font-size:13px;">
        <div><strong style="color:#888">UID:</strong> <code>${n.uid}</code></div>

        <div>
          <label style="display:block;color:#888;font-size:11px;text-transform:uppercase;margin-bottom:4px">Alias</label>
          <input type="text" id="nodo-edit-alias" value="${escapeHtml(n.alias || '')}"
                 placeholder="Ej: Cabecera Izquierda"
                 style="width:100%;padding:8px;background:#0a0a0a;border:1px solid #2a2a2a;color:#ddd;border-radius:4px"/>
        </div>

        <div>
          <label style="display:block;color:#888;font-size:11px;text-transform:uppercase;margin-bottom:4px">Notas</label>
          <textarea id="nodo-edit-notas" rows="3"
                    style="width:100%;padding:8px;background:#0a0a0a;border:1px solid #2a2a2a;color:#ddd;border-radius:4px;font-family:inherit;resize:vertical">${escapeHtml(n.notas || '')}</textarea>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px">
          <div><strong style="color:#888">Estado:</strong> ${n.estado}</div>
          <div><strong style="color:#888">Firmware:</strong> ${n.firmware}</div>
          <div><strong style="color:#888">IP:</strong> ${n.ip}</div>
          <div><strong style="color:#888">RSSI:</strong> ${n.rssi || '?'} dBm</div>
          <div><strong style="color:#888">Cables:</strong> ${n.capacidad_cables}</div>
          <div><strong style="color:#888">Perfiles:</strong> ${n.perfiles_asignado.join(', ') || '—'}</div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button class="btn-cancel" onclick="cerrarModalNodoDetalle()">Cancelar</button>
          <button class="btn-action-add" onclick="guardarDetalleNodo('${n.uid}')">Guardar</button>
        </div>
      </div>
    `;
    document.getElementById("modal-nodo-detalle").style.display = "flex";
  };

  window.cerrarModalNodoDetalle = function() {
    document.getElementById("modal-nodo-detalle").style.display = "none";
  };

  window.guardarDetalleNodo = async function(uid) {
    const alias = document.getElementById("nodo-edit-alias").value;
    const notas = document.getElementById("nodo-edit-notas").value;

    await fetch(`/api/nodos/${uid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias, notas }),
    });
    cerrarModalNodoDetalle();
    recargarNodosInventario();
  };

  window.borrarNodo = async function(uid) {
    if (!confirm(`¿Borrar el nodo ${uid}?\n\nVa a quitarlo de TODOS los perfiles que lo contengan y del inventario.`)) return;

    const res = await fetch(`/api/nodos/${uid}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      recargarNodosInventario();
      console.log(`Nodo ${uid} borrado. Afectó perfiles: ${data.perfilesAfectados?.join(', ') || 'ninguno'}`);
    } else {
      alert("Error: " + (data.error || "desconocido"));
    }
  };

  window.toggleIgnorarNodo = async function(uid, ignorado) {
    await fetch(`/api/nodos/${uid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignorado }),
    });
    recargarNodosInventario();
  };

  window.comandoNodo = async function(uid, cmd) {
    if (cmd === "borrar_wifi" && !confirm(`¿Borrar credenciales WiFi de ${uid}?\n\nVa a perder la conexión hasta que lo reconfigures.`)) return;
    if (cmd === "reiniciar" && !confirm(`¿Reiniciar ${uid}?`)) return;

    const res = await fetch(`/api/nodos/${uid}/comando`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd }),
    });
    const data = await res.json();
    if (!data.ok) alert("Error: " + (data.error || "desconocido"));
  };

  window.irAPerfilDeNodo = function(uid, perfilId) {
    // Activar el perfil y saltar al tab Sensores con foco en el nodo
    if (typeof activarPerfil === "function") {
      activarPerfil(perfilId).then(() => {
        if (typeof switchTab === "function") switchTab("sensores");
        // Si el select de filtro de nodo existe, ponerlo en este UID
        setTimeout(() => {
          const sel = document.getElementById("select-nodo-filter");
          if (sel) {
            sel.value = uid;
            if (typeof cambiarNodo === "function") cambiarNodo();
          }
        }, 200);
      });
    } else {
      alert("Función activarPerfil no disponible");
    }
  };

  // ── Filtros y búsqueda ──────────────────────────────────
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".filtro-pill");
    if (!btn) return;
    document.querySelectorAll(".filtro-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    filtroActivo = btn.dataset.filtro;
    renderizarNodos();
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "nodos-buscar") {
      busquedaActiva = e.target.value.trim();
      renderizarNodos();
    }
  });

  // ── Auto-refresco cuando cambia el inventario en backend ──
  if (window.socket) {
    window.socket.on("nodos_inventario_changed", () => {
      // Solo recargar si el tab está visible
      const tab = document.getElementById("tab-nodos");
      if (tab && tab.style.display !== "none") {
        recargarNodosInventario();
      }
    });
  }

  // Carga inicial al cambiar al tab
  const observer = new MutationObserver(() => {
    const tab = document.getElementById("tab-nodos");
    if (tab && tab.style.display !== "none" && nodosCache.length === 0) {
      recargarNodosInventario();
    }
  });
  setTimeout(() => {
    const tab = document.getElementById("tab-nodos");
    if (tab) observer.observe(tab, { attributes: true, attributeFilter: ["style"] });
  }, 1000);

  // Refresco periódico cuando el tab está abierto (cada 10s)
  setInterval(() => {
    const tab = document.getElementById("tab-nodos");
    if (tab && tab.style.display !== "none") {
      recargarNodosInventario();
    }
  }, 10000);
})();