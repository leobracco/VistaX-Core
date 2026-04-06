#!/usr/bin/env node
// ============================================================
// sim_esp32.js — Simulador de nodos ESP32 para VistaX
// Publica telemetría MQTT fake para testing sin hardware
//
// Uso: node tools/sim_esp32.js [--speed 6.5] [--fallas 2]
// Requiere: npm install mqtt (ya está en el proyecto)
// ============================================================

const mqtt = require('mqtt');
const path = require('path');

// Config
const BROKER = 'mqtt://127.0.0.1:1883';
const TOPIC_TELEMETRIA = 'vistax/nodos/telemetria';
const TOPIC_SPEED = 'aog/machine/speed';
const TOPIC_SECTIONS = 'sections/state';
const INTERVALO_MS = 250;

// Args
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? parseFloat(args[idx + 1]) : def;
}
const velocidad = getArg('speed', 6.5);
const numFallas = getArg('fallas', 0);

// Cargar implemento real
const implemento = require(path.join(__dirname, '..', 'data', 'implementos', 'tanzi_43_semilla.json'));
const sensores = implemento.mapeo_sensores.filter(s => s.is_active !== false);
const uids = [...new Set(sensores.map(s => s.uid))];

console.log(`[SIM] Implemento: ${implemento.nombre}`);
console.log(`[SIM] Nodos: ${uids.length} | Sensores: ${sensores.length}`);
console.log(`[SIM] Velocidad: ${velocidad} km/h | Fallas simuladas: ${numFallas}`);
console.log(`[SIM] Broker: ${BROKER}`);
console.log(`[SIM] Intervalo: ${INTERVALO_MS}ms`);
console.log('');

const client = mqtt.connect(BROKER, { clientId: 'sim_esp32_' + Date.now() });

// Elegir surcos con falla aleatoria
let fallasBajadas = new Set();
if (numFallas > 0) {
  const semillas = sensores.filter(s => s.tipo === 'semilla');
  const shuffled = semillas.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(numFallas, shuffled.length); i++) {
    fallasBajadas.add(shuffled[i].bajada + '-' + (shuffled[i].tren || 1));
  }
  console.log(`[SIM] Surcos con falla: ${[...fallasBajadas].join(', ')}`);
}

client.on('connect', () => {
  console.log('[SIM] Conectado al broker MQTT');
  console.log('[SIM] Publicando telemetría... (Ctrl+C para detener)\n');

  // Publicar velocidad cada 500ms
  setInterval(() => {
    const vel = velocidad + (Math.random() - 0.5) * 0.4;
    client.publish(TOPIC_SPEED, vel.toFixed(2));
  }, 500);

  // Publicar secciones (todas activas) cada 2s
  setInterval(() => {
    const t1 = sensores.filter(s => (s.tren || 1) === 1 && s.tipo === 'semilla').map(() => 1);
    const t2 = sensores.filter(s => (s.tren || 1) === 2 && s.tipo === 'semilla').map(() => 1);
    client.publish(TOPIC_SECTIONS, JSON.stringify({ t1, t2 }));
  }, 2000);

  // Publicar telemetría por nodo cada INTERVALO_MS
  setInterval(() => {
    uids.forEach(uid => {
      const nodoSensores = sensores.filter(s => s.uid === uid);
      const payload = {
        uid: uid,
        sensores: nodoSensores.map(s => {
          const esFalla = fallasBajadas.has(s.bajada + '-' + (s.tren || 1));
          const esSemilla = s.tipo === 'semilla';
          const esFerti = s.tipo && s.tipo.includes('ferti');

          let valor = 0;
          let raw = 0;

          if (esFalla) {
            valor = 0;
            raw = 0;
          } else if (esSemilla) {
            // Simular flujo de semilla realista (~12-20 pulsos/seg)
            const objetivo = implemento.setup.densidad_objetivo || 16;
            const velMs = velocidad / 3.6;
            const flujoBase = objetivo * velMs;
            valor = flujoBase + (Math.random() - 0.5) * flujoBase * 0.15;
            raw = Math.round(valor * INTERVALO_MS / 1000);
          } else if (esFerti) {
            valor = 5 + Math.random() * 3;
            raw = Math.round(valor * INTERVALO_MS / 1000);
          } else {
            // Sensores especiales (RPM, tolva, etc)
            valor = 3000 + Math.random() * 500;
            raw = 0;
          }

          return {
            cable: s.cable,
            valor: parseFloat(valor.toFixed(2)),
            raw: raw
          };
        })
      };

      client.publish(TOPIC_TELEMETRIA, JSON.stringify(payload));
    });
  }, INTERVALO_MS);
});

client.on('error', (err) => {
  console.error('[SIM] Error MQTT:', err.message);
});

process.on('SIGINT', () => {
  console.log('\n[SIM] Deteniendo simulador...');
  client.end();
  process.exit(0);
});
