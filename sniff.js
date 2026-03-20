const mqtt = require("mqtt");

// Conectamos al broker local
const client = mqtt.connect("mqtt://127.0.0.1");

client.on("connect", () => {
  console.log("\n=========================================");
  console.log("🕵️‍♂️ ESPÍA MQTT INICIADO");
  console.log("=========================================");
  console.log("Escuchando todo lo que envía el ESP32...\n");

  // Nos suscribimos a los dos tópicos principales del nodo
  client.subscribe("vistax/nodos/telemetria");
  client.subscribe("vistax/nodos/registro");
});

client.on("message", (topic, message) => {
  const hora = new Date().toLocaleTimeString();
  console.log(`[${hora}] 📡 Tópico: \x1b[36m${topic}\x1b[0m`);

  try {
    // Intentamos mostrar el JSON de forma bonita
    const payload = JSON.parse(message.toString());
    console.dir(payload, { depth: null, colors: true });
  } catch (e) {
    // Si no es JSON, lo mostramos como texto normal
    console.log(`📦 Payload (Texto): ${message.toString()}`);
  }
  console.log("-----------------------------------------\n");
});

client.on("error", (err) => {
  console.error("❌ Error de conexión MQTT:", err);
});
