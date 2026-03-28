// simulador_vistax.js
//
// 43 surcos (2 trenes) + turbina + 2 ejes + 2 tolvas
// 7 cables por nodo → 8 nodos en total
// La velocidad viene del CoreX (aog/machine/speed) — no se simula acá.
//
// Ejecutar: node simulador_vistax.js

require("dotenv").config();
const mqtt = require("mqtt");

const BROKER = process.env.MQTT_BROKER || "mqtt://127.0.0.1";
const client  = mqtt.connect(BROKER);

// ══════════════════════════════════════════════════════════
// NODOS — 7 cables cada uno
//
// Tren 1 (surcos 1-22):
//   A1 → cables 1-7 = surcos 1-7
//   A2 → cables 1-7 = surcos 8-14
//   A3 → cables 1-7 = surcos 15-21
//   A4 → cable  1   = surco 22  (cables 2-7 libres)
//
// Tren 2 (surcos 1-21):
//   B1 → cables 1-7 = surcos 1-7
//   B2 → cables 1-7 = surcos 8-14
//   B3 → cables 1-7 = surcos 15-21
//
// Especiales:
//   C1 → cable 1: turbina
//         cable 2: eje rotación delantero
//         cable 3: eje rotación trasero
//         cable 4: tolva izquierda
//         cable 5: tolva derecha
//         cables 6-7: libres
// ══════════════════════════════════════════════════════════
const NODOS = [
  // ── Tren 1 ──────────────────────────────────────────────
  { uid:"VX-S3-A1", tren:1, semilla:[
    {cable:1,surco:1},{cable:2,surco:2},{cable:3,surco:3},{cable:4,surco:4},
    {cable:5,surco:5},{cable:6,surco:6},{cable:7,surco:7},
  ]},
  { uid:"VX-S3-A2", tren:1, semilla:[
    {cable:1,surco:8},{cable:2,surco:9},{cable:3,surco:10},{cable:4,surco:11},
    {cable:5,surco:12},{cable:6,surco:13},{cable:7,surco:14},
  ]},
  { uid:"VX-S3-A3", tren:1, semilla:[
    {cable:1,surco:15},{cable:2,surco:16},{cable:3,surco:17},{cable:4,surco:18},
    {cable:5,surco:19},{cable:6,surco:20},{cable:7,surco:21},
  ]},
  { uid:"VX-S3-A4", tren:1, semilla:[
    {cable:1,surco:22}, // cables 2-7 libres
  ]},

  // ── Tren 2 ──────────────────────────────────────────────
  { uid:"VX-S3-B1", tren:2, semilla:[
    {cable:1,surco:1},{cable:2,surco:2},{cable:3,surco:3},{cable:4,surco:4},
    {cable:5,surco:5},{cable:6,surco:6},{cable:7,surco:7},
  ]},
  { uid:"VX-S3-B2", tren:2, semilla:[
    {cable:1,surco:8},{cable:2,surco:9},{cable:3,surco:10},{cable:4,surco:11},
    {cable:5,surco:12},{cable:6,surco:13},{cable:7,surco:14},
  ]},
  { uid:"VX-S3-B3", tren:2, semilla:[
    {cable:1,surco:15},{cable:2,surco:16},{cable:3,surco:17},{cable:4,surco:18},
    {cable:5,surco:19},{cable:6,surco:20},{cable:7,surco:21},
  ]},

  // ── Especiales ──────────────────────────────────────────
  { uid:"VX-S3-C1", especiales:[
    {cable:1, tipo:"turbina",      nombre:"Turbina dist."},
    {cable:2, tipo:"rotacion_eje", nombre:"Eje delantero"},
    {cable:3, tipo:"rotacion_eje", nombre:"Eje trasero"},
    {cable:4, tipo:"tolva_vacia",  nombre:"Tolva izq."},
    {cable:5, tipo:"tolva_vacia",  nombre:"Tolva der."},
  ]},
];

// ══════════════════════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════════════════════
let vel       = 0;         // km/h — llega del bridge
let sembrando = false;
let tick      = 0;
const OBJ     = 16;        // semillas/metro objetivo

let fallasSurcos = new Set(); // "tren-surco"
let tolvaVacia   = {4:false, 5:false}; // cable → vacía?

// ══════════════════════════════════════════════════════════
// MQTT
// ══════════════════════════════════════════════════════════
client.on("connect", () => {
  client.subscribe("aog/machine/speed");
  console.log(`\x1b[36m[SIM]\x1b[0m Conectado → ${BROKER}`);
  console.log(`[SIM] 8 nodos · 7 cables/nodo · 43 surcos · escuchando aog/machine/speed\n`);

  // Registrar nodos con pequeño delay entre cada uno
  NODOS.forEach((nodo, i) => {
    setTimeout(() => registrarNodo(nodo), i * 120);
  });

  // Loop de telemetría
  setTimeout(() => setInterval(loop, 500), 1500);
});

client.on("message", (topic, msg) => {
  if (topic !== "aog/machine/speed") return;
  vel       = parseFloat(msg.toString()) || 0;
  sembrando = vel > 1.0;
});

client.on("error", e => console.error(`\x1b[31m[SIM]\x1b[0m ${e.message}`));

// ══════════════════════════════════════════════════════════
// REGISTRO
// ══════════════════════════════════════════════════════════
function registrarNodo(nodo) {
  client.publish("vistax/nodos/registro", JSON.stringify({
    uid:              nodo.uid,
    firmware:         "SIM-v1.0",
    capacidad_cables: 7,
  }));
  console.log(`\x1b[90m[SIM]\x1b[0m ↗ ${nodo.uid}`);
}

// ══════════════════════════════════════════════════════════
// CÁLCULOS
// ══════════════════════════════════════════════════════════
function calcPPS(surco, tren) {
  if (!sembrando) return 0;
  if (fallasSurcos.has(`${tren}-${surco}`)) return 0;
  const velMs = vel / 3.6;
  return OBJ * velMs * (0.92 + Math.random() * 0.16);
}

function calcTurbina() {
  if (!sembrando) return 0;
  return Math.round(920 + vel * 28 + (Math.random() - 0.5) * 35);
}

function calcEje() {
  if (!sembrando) return 0;
  return Math.round(190 + vel * 14 + (Math.random() - 0.5) * 18);
}

// ══════════════════════════════════════════════════════════
// PUBLICAR TELEMETRÍA
// ══════════════════════════════════════════════════════════
function publicarNodo(nodo) {
  const sensores = [];

  (nodo.semilla || []).forEach(({cable, surco}) => {
    const pps = calcPPS(surco, nodo.tren);
    sensores.push({
      cable,
      valor: parseFloat(pps.toFixed(2)),
      raw:   sembrando ? Math.round(pps * 0.5 + Math.random() * 2) : 0,
    });
  });

  (nodo.especiales || []).forEach(({cable, tipo}) => {
    let valor = 0, raw = 0;
    if (tipo === "turbina")      { valor = calcTurbina(); raw = valor > 0 ? Math.round(valor/60) : 0; }
    if (tipo === "rotacion_eje") { valor = calcEje();     raw = valor > 0 ? 1 : 0; }
    if (tipo === "tolva_vacia")  { valor = tolvaVacia[cable] ? 1 : 0; raw = valor; }
    sensores.push({ cable, valor, raw });
  });

  if (sensores.length)
    client.publish("vistax/nodos/telemetria", JSON.stringify({ uid: nodo.uid, sensores }));
}

// ══════════════════════════════════════════════════════════
// LOOP
// ══════════════════════════════════════════════════════════
function loop() {
  tick++;

  // Sortear fallas cada ~20s
  if (tick % 40 === 0) {
    fallasSurcos.clear();
    if (Math.random() < 0.25) {
      const tren = Math.random() < 0.5 ? 1 : 2;
      const max  = tren === 1 ? 22 : 21;
      fallasSurcos.add(`${tren}-${Math.ceil(Math.random() * max)}`);
      if (Math.random() < 0.4)
        fallasSurcos.add(`${tren}-${Math.ceil(Math.random() * max)}`);
      if (fallasSurcos.size)
        console.log(`\x1b[31m[SIM]\x1b[0m ⚠ Falla: ${[...fallasSurcos].join(", ")}`);
    }
  }

  // Tolvas vacías
  if (tick % 100 === 0) tolvaVacia[4] = Math.random() < 0.12;
  if (tick % 130 === 0) tolvaVacia[5] = Math.random() < 0.08;

  // Publicar todos
  NODOS.forEach(publicarNodo);

  // Log cada 10s
  if (tick % 20 === 0) {
    const s = sembrando
      ? `\x1b[32mSEMBRANDO\x1b[0m ${vel.toFixed(1)} km/h`
      : `\x1b[33mPARADO\x1b[0m (esperando velocidad del bridge)`;
    const f  = fallasSurcos.size ? ` · Fallas: ${[...fallasSurcos].join(",")}` : "";
    const tv = (tolvaVacia[4] ? " · TOLVA IZQ VACÍA" : "") +
               (tolvaVacia[5] ? " · TOLVA DER VACÍA" : "");
    console.log(`[SIM] ${s}${f}${tv}`);
  }
}
