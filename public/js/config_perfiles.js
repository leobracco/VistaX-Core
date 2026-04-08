// ============================================================
// config_perfiles.js — Lógica del tab Perfiles
// Se carga junto con config_modal.js
// ============================================================

let _perfilesData = [];
let _perfilActivo = "";

async function cargarPerfiles() {
  const lista = document.getElementById("perfiles-lista");
  if (!lista) return;
  lista.innerHTML = '<div style="color:#555;font-size:12px;text-align:center;padding:20px">Cargando...</div>';

  try {
    const res = await fetch("/api/config/perfiles");
    const data = await res.json();

    if (!data.ok) throw new Error(data.error);

    _perfilesData = data.perfiles;
    _perfilActivo = data.activo;

    // Actualizar select del sidebar
    const sel = document.getElementById("select-maquina-archivo");
    if (sel) {
      sel.innerHTML = _perfilesData
        .map(p => `<option value="${p.id}" ${p.id === _perfilActivo ? "selected" : ""}>${p.id}.json</option>`)
        .join("");
    }

    _renderPerfiles();
  } catch (e) {
    lista.innerHTML = `<div style="color:#ff1744;font-size:12px;text-align:center;padding:20px">Error: ${e.message}</div>`;
  }
}

function _renderPerfiles() {
  const lista = document.getElementById("perfiles-lista");
  if (!lista) return;
  lista.innerHTML = "";

  if (!_perfilesData.length) {
    lista.innerHTML = '<div style="color:#555;font-size:12px;text-align:center;padding:20px">Sin perfiles. Creá uno nuevo.</div>';
    return;
  }

  _perfilesData.forEach(p => {
    const isActivo = p.id === _perfilActivo;
    const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }) : "—";

    const card = document.createElement("div");
    card.style.cssText = `
      background:${isActivo ? "rgba(0,230,118,0.04)" : "#111"};
      border:1px solid ${isActivo ? "#1a5c35" : "#222"};
      border-radius:6px; padding:12px 16px;
      display:flex; align-items:center; gap:12px;
      transition:border-color 0.15s;
    `;

    // Indicador activo
    const dot = `<div style="width:8px;height:8px;border-radius:50%;background:${isActivo ? "var(--accent)" : "#333"};flex-shrink:0" title="${isActivo ? "Perfil activo" : ""}"></div>`;

    // Info
    const info = `
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;color:${isActivo ? "var(--accent)" : "#ccc"};display:flex;align-items:center;gap:6px">
          ${p.nombre}
          ${p.locked ? '<i class="fas fa-lock" style="font-size:9px;color:#555" title="Bloqueado"></i>' : ""}
        </div>
        <div style="font-size:10px;color:#555;margin-top:2px">
          ${p.surcos} surcos · ${p.trenes} tren${p.trenes !== 1 ? "es" : ""} · ${fecha}
        </div>
      </div>
    `;

    // Botones
    let botones = "";

    if (!isActivo) {
      botones += `<button onclick="activarPerfil('${p.id}')" title="Activar"
        style="padding:5px 10px;background:#0d2b1a;border:1px solid #1a5c35;color:var(--accent);border-radius:4px;cursor:pointer;font-size:11px;font-weight:700"
        onmouseover="this.style.background='#14402a'" onmouseout="this.style.background='#0d2b1a'">
        <i class="fas fa-check"></i> Activar</button>`;
    }

    botones += `<button onclick="duplicarPerfil('${p.id}','${p.nombre}')" title="Duplicar"
      style="padding:5px 8px;background:#111;border:1px solid #333;color:#888;border-radius:4px;cursor:pointer;font-size:11px"
      onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#888'">
      <i class="fas fa-copy"></i></button>`;

    botones += `<button onclick="toggleLockPerfil('${p.id}')" title="${p.locked ? "Desbloquear" : "Bloquear"}"
      style="padding:5px 8px;background:#111;border:1px solid #333;color:${p.locked ? "#ffb300" : "#555"};border-radius:4px;cursor:pointer;font-size:11px"
      onmouseover="this.style.color='#ffb300'" onmouseout="this.style.color='${p.locked ? "#ffb300" : "#555"}'">
      <i class="fas fa-${p.locked ? "lock" : "lock-open"}"></i></button>`;

    if (!isActivo && !p.locked) {
      botones += `<button onclick="borrarPerfil('${p.id}','${p.nombre}')" title="Borrar"
        style="padding:5px 8px;background:#111;border:1px solid #333;color:#555;border-radius:4px;cursor:pointer;font-size:11px"
        onmouseover="this.style.color='#ff1744'" onmouseout="this.style.color='#555'">
        <i class="fas fa-trash"></i></button>`;
    }

    card.innerHTML = `${dot}${info}<div style="display:flex;gap:6px;flex-shrink:0">${botones}</div>`;
    lista.appendChild(card);
  });
}

async function activarPerfil(id) {
  try {
    const res = await fetch("/api/config/perfiles/activar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (data.ok) {
      // Recargar toda la página para aplicar el nuevo perfil
      alert(`Perfil "${id}" activado. La página se recargará.`);
      location.reload();
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    alert("Error de conexión");
  }
}

async function crearNuevoPerfil() {
  const nombre = prompt("Nombre del nuevo perfil:");
  if (!nombre || !nombre.trim()) return;

  try {
    const res = await fetch("/api/config/perfiles/nuevo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: nombre.trim() }),
    });
    const data = await res.json();
    if (data.ok) {
      await cargarPerfiles();
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    alert("Error de conexión");
  }
}

async function duplicarPerfil(sourceId, sourceName) {
  const nombre = prompt(`Nombre para la copia de "${sourceName}":`, sourceName + " (copia)");
  if (!nombre || !nombre.trim()) return;

  try {
    const res = await fetch("/api/config/perfiles/duplicar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, nombre: nombre.trim() }),
    });
    const data = await res.json();
    if (data.ok) {
      await cargarPerfiles();
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    alert("Error de conexión");
  }
}

async function borrarPerfil(id, nombre) {
  if (!confirm(`¿Borrar el perfil "${nombre}"?\n\nEsta acción no se puede deshacer.`)) return;

  try {
    const res = await fetch(`/api/config/perfiles/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      await cargarPerfiles();
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    alert("Error de conexión");
  }
}

async function toggleLockPerfil(id) {
  try {
    const res = await fetch("/api/config/perfiles/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (data.ok) {
      await cargarPerfiles();
    } else {
      alert("Error: " + data.error);
    }
  } catch (e) {
    alert("Error de conexión");
  }
}
