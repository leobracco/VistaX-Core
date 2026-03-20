// Función para abrir y cargar datos
async function abrirModal() {
  document.getElementById("modal-config").style.display = "flex";
  // Podrías pedir la config actual al servidor
  const response = await fetch("/api/config/maquinas/tanzi_default");
  const config = await response.json();

  document.getElementById("cfg-nombre").value = config.nombre;
  // ... cargar otros campos y generar las filas de mapeo
}

function agregarFilaMapeo(datos = {}) {
  const container = document.getElementById("mapeo-list");
  const row = document.createElement("div");
  row.className = "mapeo-row";
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.marginBottom = "10px";

  // Manejo de valores: Si viene vacío, lo dejamos vacío (no forzamos a 1)
  const uidVal = datos.uid || "";
  const pinVal = datos.pin !== undefined ? datos.pin : "";
  const bajadaVal = datos.bajada !== undefined ? datos.bajada : "";

  // Ponemos UID y Pin como 'readonly' para no editarlos por error
  row.innerHTML = `
        <input type="text" placeholder="UID Nodo" value="${uidVal}" class="m-uid" readonly style="background-color: #e9ecef; border: 1px solid #ccc;">
        <input type="number" placeholder="Pin" value="${pinVal}" class="m-pin" readonly style="background-color: #e9ecef; border: 1px solid #ccc; width: 70px;">
        <input type="number" placeholder="Nº Bajada" value="${bajadaVal}" class="m-bajada" required style="border: 2px solid #0d6efd;">
        <select class="m-tipo">
            <option value="semilla" ${datos.tipo === "semilla" ? "selected" : ""}>Semilla</option>
            <option value="ferti_linea" ${datos.tipo === "ferti_linea" ? "selected" : ""}>Ferti Línea</option>
            <option value="ferti_costado" ${datos.tipo === "ferti_costado" ? "selected" : ""}>Ferti Costado</option>
        </select>
        <button type="button" onclick="this.parentElement.remove()" class="text-danger" style="border:none; background:transparent;"><i class="fas fa-trash"></i></button>
    `;
  container.appendChild(row);
}

async function guardarConfiguracion() {
  const mapeo = [];
  document.querySelectorAll(".mapeo-row").forEach((row) => {
    mapeo.push({
      uid: row.querySelector(".m-uid").value,
      pin: parseInt(row.querySelector(".m-pin").value),
      bajada: parseInt(row.querySelector(".m-bajada").value),
      tipo: row.querySelector(".m-tipo").value,
    });
  });

  const nuevaConfig = {
    nombre: document.getElementById("cfg-nombre").value,
    setup: {
      distancia_entre_surcos: parseFloat(
        document.getElementById("cfg-distancia").value,
      ),
      peso_mil_semillas: parseFloat(document.getElementById("cfg-p1000").value),
    },
    mapeo_sensores: mapeo,
  };

  const response = await fetch("/api/config/maquinas/guardar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nuevaConfig),
  });

  if (response.ok) {
    alert("Configuración aplicada. Reiniciando monitoreo...");
    location.reload();
  }
}

// ==========================================
// RUTINA PARA PREPARAR UN NODO NUEVO EN LA UI
// ==========================================
window.prepararNuevoNodo = async function (nodoData) {
  // 1. Abrimos el modal de configuración de la máquina
  if (typeof abrirModal === "function") {
    try {
      await abrirModal();
    } catch (e) {
      abrirModal();
    }
  }

  // 2. Damos un respiro (500ms) para que el modal renderice los sensores viejos primero
  setTimeout(() => {
    // 3. Generamos las filas nuevas
    for (let i = 0; i < nodoData.capacidad_cables; i++) {
      agregarFilaMapeo({
        uid: nodoData.uid,
        pin: i,
        bajada: "", // Vacío para obligar al usuario a escribirlo
        tipo: "semilla",
      });
    }

    // 4. Scrolleamos al fondo para ver los nuevos
    const container = document.getElementById("mapeo-list");
    if (container) {
      container.scrollTop = container.scrollHeight;

      // 5. Hacemos FOCUS mágico en el primer input vacío para que tipées directo
      const inputsBajada = container.querySelectorAll(".m-bajada");
      if (inputsBajada.length > 0) {
        const primerInputNuevo =
          inputsBajada[inputsBajada.length - nodoData.capacidad_cables];
        if (primerInputNuevo) primerInputNuevo.focus();
      }
    }
  }, 500);
};
