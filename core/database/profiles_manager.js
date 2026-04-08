const fs = require("fs");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "../../data/implementos");
const SETTINGS_FILE = path.join(__dirname, "../../data/settings.json");

if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// ── Obtener perfil por nombre ──
const getActiveProfile = (profileName) => {
  const filePath = path.join(PROFILES_DIR, `${profileName}.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return null;
};

// ── Listar nombres simples ──
const listProfiles = () => {
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
};

// ── Listar con metadata (para el tab Perfiles) ──
const listProfilesDetailed = () => {
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((f) => {
      const filePath = path.join(PROFILES_DIR, f);
      try {
        const stats = fs.statSync(filePath);
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

        // Contar surcos de siembra (semilla + ferti)
        const sensores = data.mapeo_sensores || [];
        const surcos = sensores.filter(
          (s) => s.is_active !== false && 
          (s.tipo === "semilla" || s.tipo === "ferti_linea" || s.tipo === "ferti_costado")
        ).length;

        // Contar trenes
        const trenes = [...new Set(
          sensores
            .filter((s) => s.is_active !== false && s.tipo === "semilla")
            .map((s) => s.tren || 1)
        )].length;

        return {
          id: f.replace(".json", ""),
          nombre: data.nombre || f.replace(".json", ""),
          surcos,
          trenes,
          fecha: stats.mtime.toISOString(),
          locked: !!data._locked,
          totalSensores: sensores.filter((s) => s.is_active !== false).length,
        };
      } catch (e) {
        return {
          id: f.replace(".json", ""),
          nombre: f.replace(".json", ""),
          surcos: 0,
          trenes: 0,
          fecha: null,
          locked: false,
          totalSensores: 0,
        };
      }
    })
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
};

// ── Duplicar perfil ──
const duplicateProfile = (sourceId, newName) => {
  const sourcePath = path.join(PROFILES_DIR, `${sourceId}.json`);
  if (!fs.existsSync(sourcePath)) return null;

  const data = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const newId = newName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  const newPath = path.join(PROFILES_DIR, `${newId}.json`);
  if (fs.existsSync(newPath)) return null; // Ya existe

  data.id = newId;
  data.nombre = newName;
  delete data._locked; // La copia no hereda el bloqueo

  fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
  return newId;
};

// ── Borrar perfil ──
const deleteProfile = (profileId) => {
  const filePath = path.join(PROFILES_DIR, `${profileId}.json`);
  if (!fs.existsSync(filePath)) return false;

  // No borrar si está bloqueado
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (data._locked) return false;
  } catch (e) {}

  // No borrar el perfil activo
  if (getLastProfileName() === profileId) return false;

  fs.unlinkSync(filePath);
  return true;
};

// ── Bloquear/desbloquear perfil ──
const toggleLockProfile = (profileId) => {
  const filePath = path.join(PROFILES_DIR, `${profileId}.json`);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  data._locked = !data._locked;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data._locked;
};

// ── Crear perfil vacío ──
const createEmptyProfile = (nombre) => {
  const id = nombre
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  const filePath = path.join(PROFILES_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) return null;

  const data = {
    id,
    nombre,
    setup: {
      distancia_entre_surcos: 0.525,
      densidad_objetivo: 5.2,
      objetivos_tren: {},
      tolerancia_desvio: 20,
      rpm_min: 2000,
      rpm_max: 5000,
      tolvas: 2,
      velocidad_max: 8.5,
      alarma_tiempo_seg: 2,
    },
    mapeo_sensores: [],
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return id;
};

// ── Memoria: último perfil usado ──
const getLastProfileName = () => {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      return settings.last_profile || "tanzi_default";
    } catch (e) {
      return "tanzi_default";
    }
  }
  return "tanzi_default";
};

const setLastProfileName = (profileName) => {
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    } catch (e) {
      settings = {};
    }
  }
  settings.last_profile = profileName;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
};

module.exports = {
  getActiveProfile,
  listProfiles,
  listProfilesDetailed,
  duplicateProfile,
  deleteProfile,
  toggleLockProfile,
  createEmptyProfile,
  getLastProfileName,
  setLastProfileName,
};
