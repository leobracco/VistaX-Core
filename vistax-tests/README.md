# VistaX — Suite de Tests

Tests completos para cada paso del flujo de uso de la plataforma VistaX.

## Estructura

```
vistax-tests/
├── package.json
├── README.md
├── mocks/
│   ├── config.mock.js        # Config de implemento, payloads MQTT de ejemplo
│   └── io.mock.js            # Mock de Socket.IO server y cliente MQTT
└── tests/
    ├── unit/
    │   ├── 01_densidad_alertas.test.js   # Cálculo spm, alertas, desvío
    │   ├── 02_map_recorder.test.js       # Ciclo de vida del lote, GPS
    │   ├── 03_mqtt_pipeline.test.js      # Procesamiento de mensajes MQTT
    │   ├── 04_lote_triggers.test.js      # Triggers 1-4 de inicio de lote
    │   └── 05_config_modal.test.js       # Validación y serialización de config
    ├── integration/
    │   ├── 06_api_rest.test.js           # Endpoints REST con supertest
    │   └── 07_socketio_eventos.test.js   # Eventos Socket.IO extremo-a-extremo
    └── e2e/
        └── 08_flujo_completo.test.js     # Flujo completo ESP32 → UI
```

## Instalación

Copiar la carpeta `vistax-tests/` dentro del proyecto VistaX:

```
VistaX/
├── core/
├── routes/
├── views/
├── public/
└── vistax-tests/   ← acá
```

Instalar dependencias:

```bash
cd vistax-tests
npm install
```

## Ejecutar tests

```bash
# Todos los tests
npm test

# Solo unitarios (más rápidos, sin red)
npm run test:unit

# Solo integración (levanta servidor Express real)
npm run test:integration

# Solo E2E (flujo completo)
npm run test:e2e

# Con cobertura
npm run test:coverage

# Modo watch durante desarrollo
npm run test:watch
```

## Qué cubre cada paso

### PASO 1 — `01_densidad_alertas.test.js`
Lógica central de negocio (sin dependencias de red):
- `calcularSpm()`: conversión flujo s/s → semillas/metro
- `evaluarSensor()`: estado ok / tapado / desvio / cortado / parado
- Objetivo de densidad por tren (tren 1 = 16 s/m, tren 2 = 18 s/m)
- Tolerancia de desvío configurable (default 20%)
- Soft-delete: `is_active:false` excluido de cálculos

### PASO 2 — `02_map_recorder.test.js`
Módulo `core/logic/map_recorder.js`:
- `iniciarLote()` / `cerrarLote()`
- `actualizarGPS()` con filtro de distancia mínima (0.8m)
- `getGeoJSONLive()` retorna FeatureCollection válida
- Estadísticas: hectáreas, distancia, spm promedio

### PASO 3 — `03_mqtt_pipeline.test.js`
Pipeline de procesamiento de mensajes MQTT:
- `aog/machine/speed` → actualiza velocidad global
- `vistax/nodos/telemetria` → emite sensor_update por cable
- `sections/state` → aplica cortes de sección de AOG
- `vistax/nodos/registro` → detecta nodos nuevos
- Sensores `is_active:false` completamente ignorados
- Sección cortada → `seccion_cortada:true`, `alerta:false`

### PASO 4 — `04_lote_triggers.test.js`
Cuatro triggers de inicio de lote:
- **T1 Manual**: `iniciarLote()` directo desde UI
- **T2 AOG Bridge**: `painting:true` en `aog/field/status`
- **T3 Semilla**: N bajadas con pulsos durante X segundos
- **T4 Implemento**: `bajada_herramienta > 0`
- `posponer()` bloquea por 3 minutos
- Si hay lote activo → triggers 2/3/4 no se disparan

### PASO 5 — `05_config_modal.test.js`
Gestión de la configuración del implemento:
- `generarNombresAutomaticos()`: etiquetas por tipo y orden de bajada
- `validarDuplicados()`: tipo+bajada únicos (excluyendo soft-delete)
- `trenesExistentes()`: detecta todos los trenes usados
- Serialización JSON: is_active, objetivos_tren se preservan

### PASO 6 — `06_api_rest.test.js`
Endpoints REST con servidor Express real:

| Método | Endpoint | Qué verifica |
|--------|----------|-------------|
| GET | `/api/mapa/lote-activo` | 200 con activo:false sin lote |
| POST | `/api/mapa/iniciar` | 200 con lote creado; 400 sin nombre/cultivo |
| POST | `/api/mapa/cerrar` | 200 lote cerrado; 400 sin lote activo |
| GET | `/api/mapa/geojson/live` | FeatureCollection válida |
| GET | `/api/mapa/historial` | Array de lotes |
| GET | `/api/config/maquinas` | Lista de implementos |
| POST | `/api/config/maquinas/guardar` | Archivo persistido correctamente |
| GET | `/api/config/maquinas/:id` | Config por ID; 404 si no existe |

### PASO 7 — `07_socketio_eventos.test.js`
Socket.IO con servidor y cliente reales:
- `sensor_update` llega con todos los campos
- `global_update` llega con velocidad
- `lote_update` al iniciar (`activo:true`) y cerrar (`activo:false`)
- `sections_update` al cambiar secciones AOG
- `new_node_detected` para UID desconocido
- Múltiples clientes reciben el mismo evento simultáneamente

### PASO 8 — `08_flujo_completo.test.js`
E2E: ESP32 → MQTT → Node.js → Socket.IO → Cliente

| Escenario | Descripción |
|-----------|-------------|
| A | Arranque normal: nodo publica → UI recibe sensor_update |
| B | Inicio de lote + GPS → mapa en vivo recibe puntos |
| C | Falla de surco: flujo=0 + vel>1.5 → alerta propagada |
| D | Sección cortada por AOG → no genera alerta |
| E | Cierre de lote → lote_update activo:false |
| F | Nodo nuevo → new_node_detected en UI |
| G | Stress: 100 mensajes sin pérdida significativa |

## Dependencias de test

| Paquete | Uso |
|---------|-----|
| `jest` | Test runner principal |
| `supertest` | Tests de API REST sin levantar servidor real |
| `socket.io-client` | Cliente Socket.IO para tests de integración |
| `socket.io` | Servidor Socket.IO en tests (replica server.js) |
| `express` | Servidor web en tests de integración y E2E |

## Notas de arquitectura

Los tests están diseñados para correr **sin MQTT broker real** ni **ESP32 físico**. Todo el hardware se simula:

- `createMqttMock()` simula mensajes entrantes con `simulateMessage(topic, payload)`
- `createIoMock()` captura todos los `io.emit()` para hacer assertions
- Los recorders de map_recorder usan directorios temporales (`os.tmpdir()`)
- El pipeline MQTT se prueba como función pura sin conexión de red

Si el módulo real `core/logic/map_recorder.js` existe en el path relativo, los tests lo usan directamente. Si no, corre una implementación mínima inline que replica el comportamiento esperado.

## Convenciones

- `jest.fn()` para todos los mocks de funciones externas
- `beforeEach` cierra siempre el lote activo para evitar contaminación entre tests
- `afterAll` limpia archivos temporales con `fs.rmSync()`
- Timeouts de 15 segundos (configurado en `package.json`)
- Tests numerados para ejecutarse en orden lógico de flujo
