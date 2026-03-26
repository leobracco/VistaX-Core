// ══════════════════════════════════════════════════════════
// REEMPLAZA el bloque OTA completo en public/js/config_modal.js
// ══════════════════════════════════════════════════════════

// ── Abrir modal ───────────────────────────────────────────
function abrirModalOTA() {
  const overlay = document.getElementById("modal-ota-overlay");
  if (!overlay) return;

  document.getElementById("ota-uid-display").textContent = nodoActual || "—";
  document.getElementById("ota-status").style.display    = "none";
  document.getElementById("cmd-status").style.display    = "none";
  document.getElementById("ota-upload-status").textContent = "";
  document.getElementById("btn-enviar-ota").disabled     = false;
  document.getElementById("btn-enviar-ota").textContent  = "⬆ Enviar OTA al nodo";

  overlay.style.display = "flex";

  // Cargar estado y firmwares en paralelo
  cargarEstadoNodo();
  cargarFirmwares();
}

// ── Cerrar modal ──────────────────────────────────────────
function cerrarModalOTA() {
  const overlay = document.getElementById("modal-ota-overlay");
  if (overlay) overlay.style.display = "none";
}

// ══════════════════════════════════════════════════════════
// ESTADO DEL NODO
// ══════════════════════════════════════════════════════════

async function cargarEstadoNodo() {
  _resetearPanelEstado();
  try {
    const res  = await fetch("/api/config/nodos/estado");
    const data = await res.json();
    const nodo = data.nodos?.[nodoActual];
    if (nodo) {
      _renderEstado(nodo);
    } else {
      document.getElementById("ns-online").textContent  = "Sin datos";
      document.getElementById("ns-online").style.color  = "#555";
    }
  } catch (e) {
    document.getElementById("ns-online").textContent = "Error";
    document.getElementById("ns-online").style.color = "#ff1744";
  }
}

function solicitarEstadoNodo() {
  // Pide al nodo que publique su estado y espera la respuesta
  enviarComando("estado", false);
  setTimeout(cargarEstadoNodo, 1500); // esperar respuesta MQTT
}

function _resetearPanelEstado() {
  ["ns-online","ns-version","ns-ip","ns-rssi","ns-uptime","ns-heap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = "—"; el.style.color = "#555"; }
  });
}

function _renderEstado(nodo) {
  const onlineEl = document.getElementById("ns-online");
  if (nodo.online) {
    onlineEl.textContent = "🟢 Online";
    onlineEl.style.color = "var(--accent)";
  } else {
    const segs = Math.round((Date.now() - nodo.lastSeen) / 1000);
    onlineEl.textContent = `🔴 Offline (${segs}s)`;
    onlineEl.style.color = "#ff1744";
  }

  const vEl = document.getElementById("ns-version");
  vEl.textContent = nodo.version || "?";
  vEl.style.color = "#fff";

  const ipEl = document.getElementById("ns-ip");
  ipEl.textContent = nodo.ip || "?";
  ipEl.style.color = "#fff";

  // RSSI con color por señal
  const rssiEl = document.getElementById("ns-rssi");
  if (nodo.rssi != null) {
    const rssi = nodo.rssi;
    rssiEl.textContent = `${rssi} dBm`;
    rssiEl.style.color = rssi >= -60 ? "var(--accent)" : rssi >= -75 ? "#ffea00" : "#ff1744";
  }

  const upEl = document.getElementById("ns-uptime");
  if (nodo.uptime_s != null) {
    const h = Math.floor(nodo.uptime_s / 3600);
    const m = Math.floor((nodo.uptime_s % 3600) / 60);
    const s = nodo.uptime_s % 60;
    upEl.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    upEl.style.color = "#fff";
  }

  const heapEl = document.getElementById("ns-heap");
  if (nodo.heap) {
    heapEl.textContent = `${Math.round(nodo.heap / 1024)} KB`;
    heapEl.style.color = nodo.heap > 100000 ? "var(--accent)" : "#ffea00";
  }
}

// ══════════════════════════════════════════════════════════
// COMANDOS REMOTOS
// ══════════════════════════════════════════════════════════

async function enviarComando(cmd, mostrarConfirm = true) {
  if (!nodoActual) {
    _cmdStatus("error", "⚠ Sin nodo seleccionado");
    return;
  }

  try {
    const res  = await fetch("/api/config/nodos/comando", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ uid: nodoActual, cmd }),
    });
    const data = await res.json();

    if (data.ok) {
      const msgs = {
        estado:     "📊 Solicitando estado al nodo...",
        reiniciar:  "🔄 Comando enviado — el nodo se reinicia en ~2 seg",
        borrar_wifi:"🗑 Comando enviado — el nodo borrará su WiFi y se reiniciará",
      };
      _cmdStatus("ok", msgs[cmd] || `✅ Comando ${cmd} enviado`);

      // Si pidió estado, refrescar el panel después de un momento
      if (cmd === "estado") setTimeout(cargarEstadoNodo, 1500);
    } else {
      _cmdStatus("error", `❌ ${data.error}`);
    }
  } catch (e) {
    _cmdStatus("error", `❌ Error de red: ${e.message}`);
  }
}

function confirmarBorrarWifi() {
  const confirmado = confirm(
    `⚠ BORRAR WIFI del nodo ${nodoActual}\n\n` +
    `El nodo perderá su configuración WiFi y abrirá un punto de acceso para reconfigurar.\n` +
    `Necesitarás conectarte a él con el celular para volver a asignarle la red.\n\n` +
    `¿Confirmás?`
  );
  if (confirmado) enviarComando("borrar_wifi");
}

function _cmdStatus(tipo, msg) {
  const el = document.getElementById("cmd-status");
  if (!el) return;
  const estilos = {
    ok:    "background:rgba(0,230,118,0.08);border:1px solid #00e676;color:#00e676",
    error: "background:rgba(255,23,68,0.08);border:1px solid #ff1744;color:#ff1744",
  };
  el.style.cssText = `display:block;padding:8px 12px;border-radius:4px;font-size:11px;text-align:center;${estilos[tipo]}`;
  el.textContent   = msg;
  setTimeout(() => { el.style.display = "none"; }, 4000);
}

// ══════════════════════════════════════════════════════════
// FIRMWARE: LISTADO, SUBIDA, ELIMINACIÓN
// ══════════════════════════════════════════════════════════

async function cargarFirmwares() {
  const select  = document.getElementById("ota-firmware-select");
  const infoDiv = document.getElementById("ota-firmware-info");
  select.innerHTML = '<option value="">Cargando...</option>';
  infoDiv.textContent = "";

  try {
    const res  = await fetch("/api/firmware");
    const data = await res.json();

    if (!data.ok || data.firmwares.length === 0) {
      select.innerHTML = '<option value="">— Sin firmwares disponibles —</option>';
      infoDiv.textContent = "Subí un VX-*.bin para habilitar el envío.";
      infoDiv.style.color = "#555";
      return;
    }

    select.innerHTML = data.firmwares.map(f => {
      const kb   = (f.size / 1024).toFixed(1);
      const date = new Date(f.fecha).toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit", year:"numeric" });
      return `<option value="${f.filename}" data-version="${f.version}" data-size="${kb}" data-date="${date}">
        ${f.filename} — ${kb} KB
      </option>`;
    }).join("");

    actualizarInfoFirmware();
    select.onchange = actualizarInfoFirmware;
  } catch (e) {
    select.innerHTML = '<option value="">Error cargando lista</option>';
    infoDiv.style.color = "#ff1744";
    infoDiv.textContent = "No se pudo conectar.";
  }
}

function actualizarInfoFirmware() {
  const select  = document.getElementById("ota-firmware-select");
  const infoDiv = document.getElementById("ota-firmware-info");
  const opt     = select.options[select.selectedIndex];
  if (!opt?.value) { infoDiv.textContent = ""; return; }
  infoDiv.textContent = `Versión: ${opt.dataset.version}  ·  ${opt.dataset.size} KB  ·  Subido: ${opt.dataset.date}`;
  infoDiv.style.color = "#555";
}

function handleFirmwareDrop(event) {
  event.preventDefault();
  const dz = document.getElementById("ota-dropzone");
  dz.style.borderColor = "#333";
  dz.style.background  = "transparent";
  const file = event.dataTransfer.files[0];
  if (file) subirFirmware(file);
}

async function subirFirmware(file) {
  if (!file) return;
  const statusDiv    = document.getElementById("ota-upload-status");
  const progressWrap = document.getElementById("ota-progress-bar-wrap");
  const progressBar  = document.getElementById("ota-progress-bar");

  if (!file.name.endsWith(".bin")) {
    statusDiv.textContent = "❌ Solo .bin"; statusDiv.style.color = "#ff1744"; return;
  }
  if (!file.name.startsWith("VX-")) {
    statusDiv.textContent = "❌ Nombre debe empezar con VX-"; statusDiv.style.color = "#ff1744"; return;
  }
  if (file.size > 4 * 1024 * 1024) {
    statusDiv.textContent = "❌ Máximo 4MB"; statusDiv.style.color = "#ff1744"; return;
  }

  statusDiv.textContent = `Subiendo ${file.name}...`;
  statusDiv.style.color = "#ffea00";
  progressWrap.style.display = "block";
  progressBar.style.width    = "0%";

  const formData = new FormData();
  formData.append("firmware", file);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progressBar.style.width = Math.round((e.loaded/e.total)*100) + "%";
    };
    xhr.onload = async () => {
      progressWrap.style.display = "none";
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.ok) {
          statusDiv.textContent = `✅ ${data.filename} subido`;
          statusDiv.style.color = "var(--accent)";
          await cargarFirmwares();
          const sel = document.getElementById("ota-firmware-select");
          for (const opt of sel.options) {
            if (opt.value === data.filename) { sel.value = data.filename; break; }
          }
          actualizarInfoFirmware();
        } else {
          statusDiv.textContent = `❌ ${data.error}`;
          statusDiv.style.color = "#ff1744";
        }
      } catch { statusDiv.textContent = "❌ Error inesperado"; statusDiv.style.color = "#ff1744"; }
      resolve();
    };
    xhr.onerror = () => {
      progressWrap.style.display = "none";
      statusDiv.textContent = "❌ Error de red";
      statusDiv.style.color = "#ff1744";
      resolve();
    };
    xhr.open("POST", "/api/firmware/upload");
    xhr.send(formData);
  });
}

async function eliminarFirmwareSeleccionado() {
  const select   = document.getElementById("ota-firmware-select");
  const filename = select.value;
  if (!filename) return;
  if (!confirm(`¿Eliminar ${filename}?`)) return;
  try {
    const res  = await fetch(`/api/firmware/${filename}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) await cargarFirmwares();
    else alert("Error: " + data.error);
  } catch (e) { alert("Error de red: " + e.message); }
}

// ══════════════════════════════════════════════════════════
// ENVÍO OTA
// ══════════════════════════════════════════════════════════

async function enviarComandoOTA() {
  const uid      = nodoActual;
  const filename = document.getElementById("ota-firmware-select").value;
  const btn      = document.getElementById("btn-enviar-ota");

  if (!uid)      { _otaStatus("error", "⚠ Sin nodo seleccionado"); return; }
  if (!filename) { _otaStatus("error", "⚠ Seleccioná un firmware"); return; }

  btn.disabled    = true;
  btn.textContent = "Enviando...";
  _otaStatus("info", "📡 Publicando comando OTA...");

  try {
    const res  = await fetch("/api/config/nodos/comando-ota", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ uid, filename }),
    });
    const data = await res.json();

    if (data.ok) {
      _otaStatus("ok", `✅ OTA enviado al nodo ${uid}\nVersión: ${data.version}\nReiniciando en ~30 seg...`);
      btn.textContent = "✅ Enviado";
      setTimeout(cerrarModalOTA, 4000);
    } else {
      _otaStatus("error", `❌ ${data.error}`);
      btn.disabled    = false;
      btn.textContent = "⬆ Enviar OTA al nodo";
    }
  } catch (e) {
    _otaStatus("error", `❌ Error de red: ${e.message}`);
    btn.disabled    = false;
    btn.textContent = "⬆ Enviar OTA al nodo";
  }
}

function _otaStatus(tipo, msg) {
  const el = document.getElementById("ota-status");
  if (!el) return;
  const estilos = {
    ok:    "background:rgba(0,230,118,0.08);border:1px solid #00e676;color:#00e676",
    error: "background:rgba(255,23,68,0.08);border:1px solid #ff1744;color:#ff1744",
    info:  "background:rgba(255,234,0,0.06);border:1px solid rgba(255,234,0,0.3);color:#ffea00",
  };
  el.style.cssText = `display:block;padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:12px;text-align:center;white-space:pre-line;line-height:1.6;${estilos[tipo]}`;
  el.textContent   = msg;
}

// ── Socket.IO: actualizar estado en vivo si el modal está abierto ──
if (typeof socket !== "undefined") {
  socket.on("nodo_estado", (nodo) => {
    const overlay = document.getElementById("modal-ota-overlay");
    if (overlay?.style.display === "flex" && nodo.uid === nodoActual) {
      _renderEstado(nodo);
    }
  });
}

// ── Escape para cerrar ────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const overlay = document.getElementById("modal-ota-overlay");
    if (overlay?.style.display === "flex") cerrarModalOTA();
  }
});
