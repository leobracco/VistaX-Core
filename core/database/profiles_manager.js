const fs = require("fs");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "../../data/implementos");
const SETTINGS_FILE = path.join(__dirname, "../../data/settings.json");

// Crear directorio si no existe
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Función para obtener la configuración de un archivo JSON
const getActiveProfile = (profileName) => {
  const filePath = path.join(PROFILES_DIR, `${profileName}.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return null;
};

// Función para listar todos los implementos disponibles
const listProfiles = () => {
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
};

// --- FUNCIONES DE MEMORIA ---

const getLastProfileName = () => {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      return settings.last_profile || "tanzi_default";
    } catch (e) {
      return "tanzi_default";
    }
  }
  return "tanzi_default"; // Fallback por defecto
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

// ¡ESTA LÍNEA ES LA QUE TE TIRABA EL ERROR SI FALTABA ALGO!
module.exports = {
  getActiveProfile,
  listProfiles,
  getLastProfileName,
  setLastProfileName,
};
