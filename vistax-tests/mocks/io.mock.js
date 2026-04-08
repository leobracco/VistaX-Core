/**
 * mocks/io.mock.js
 * Mock de Socket.IO server para tests unitarios.
 * Captura todos los eventos emitidos para hacer assertions.
 */

function createIoMock() {
  const emitted = [];

  const io = {
    emit: jest.fn((event, data) => {
      emitted.push({ event, data });
    }),
    on: jest.fn(),
    _emitted: emitted,
    /** Helper: retorna los datos del último evento con ese nombre */
    lastOf(eventName) {
      const found = [...emitted].reverse().find(e => e.event === eventName);
      return found ? found.data : null;
    },
    /** Helper: retorna todos los eventos emitidos con ese nombre */
    allOf(eventName) {
      return emitted.filter(e => e.event === eventName).map(e => e.data);
    },
    /** Limpia el historial entre tests */
    clear() {
      emitted.length = 0;
      io.emit.mockClear();
    },
  };

  return io;
}

/**
 * Mock del cliente MQTT.
 * Permite simular mensajes entrantes y capturar publicaciones.
 */
function createMqttMock() {
  const subscribers = {};
  const published = [];

  const client = {
    connected: true,
    subscribe: jest.fn((topics) => {
      const topicList = Array.isArray(topics) ? topics : [topics];
      topicList.forEach(t => { if (!subscribers[t]) subscribers[t] = []; });
    }),
    publish: jest.fn((topic, msg) => {
      published.push({ topic, msg: typeof msg === 'string' ? msg : JSON.stringify(msg) });
      return true;
    }),
    on: jest.fn((event, cb) => {
      if (!subscribers[event]) subscribers[event] = [];
      subscribers[event].push(cb);
    }),
    /** Simula la llegada de un mensaje MQTT */
    simulateMessage(topic, payload) {
      const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const handlers = subscribers['message'] || [];
      handlers.forEach(h => h(topic, Buffer.from(msg)));
    },
    /** Simula la conexión exitosa */
    simulateConnect() {
      const handlers = subscribers['connect'] || [];
      handlers.forEach(h => h());
    },
    _published: published,
    _subscribers: subscribers,
    clear() {
      published.length = 0;
      client.subscribe.mockClear();
      client.publish.mockClear();
    },
  };

  return client;
}

module.exports = { createIoMock, createMqttMock };
