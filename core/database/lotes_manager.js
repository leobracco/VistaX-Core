const fs = require("fs");
const path = require("path");

const LOTES_DIR = path.join(__dirname, "../../data/lotes");

if (!fs.existsSync(LOTES_DIR)) {
  fs.mkdirSync(LOTES_DIR, { recursive: true });
}

const guardarPuntoLote = (loteId, datos) => {
  const filePath = path.join(LOTES_DIR, `${loteId}.json`);
  let loteData = { puntos: [], estadisticas: {} };

  if (fs.existsSync(filePath)) {
    loteData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  // Mantener límite de 100 lotes (borrar el más viejo si es necesario)
  const lotesExistentes = fs.readdirSync(LOTES_DIR);
  if (lotesExistentes.length > 100 && !fs.existsSync(filePath)) {
    const masViejo = lotesExistentes.sort()[0];
    fs.unlinkSync(path.join(LOTES_DIR, masViejo));
  }

  loteData.puntos.push({
    ts: Date.now(),
    ...datos, // Aqui guardamos lat, lon, vel y el estado de cada surco
  });

  fs.writeFileSync(filePath, JSON.stringify(loteData, null, 2));
};

module.exports = { guardarPuntoLote };
