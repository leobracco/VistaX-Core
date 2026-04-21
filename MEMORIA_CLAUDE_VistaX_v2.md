# VistaX — Memoria de Proyecto para Claude (Actualizada Abril 2026)

## Quién soy y qué hago

Soy **Leonardo Bracco** (GitHub: leobracco), desarrollador solo en **Agro Parallel**. Trabajo sobre una suite de productos de agricultura de precisión. Empujo a main sin PRs. Prefiero Spanish para UI/código. Trabajo en Windows. Server lanzado con PM2 (`ecosystem.config.js`).

---

## Ecosistema (3 productos + 1 broker)

```
VistaX-Node (firmware ESP32-S3)
       │  MQTT vistax/nodos/telemetria cada 500ms
       ▼
    BrokerX (Aedes, Node.js)
    ├── Puerto 1883 → MQTT TCP (nodos, CoreX, VistaX)
    └── Puerto 3000 → WebSocket (browser)
       ▲                           ▲
       │ MQTT TCP :1883            │ MQTT TCP :1883
       │                           │
    VistaX                       CoreX
 (Node.js + EJS)         (AOG UDP ↔ MQTT bridge)
  :3001 / Socket.IO         server.js
       │
       │ Socket.IO
       ▼
  WPF + WebView2 (PC cabina)
  o celular (ruta /prueba)
```

### BrokerX
- Broker MQTT basado en **Aedes** (migrado desde Mosca)
- Puerto 1883: MQTT sobre TCP (protocolo binario, para Node.js y ESP32)
- Puerto 3000: MQTT sobre WebSocket (para browsers)
- **Son el mismo broker** — mensajes publicados en un transporte son visibles en el otro
- Ruta: `C:\BrokerX\`
- IMPORTANTE: `mqtt://` = TCP, `ws://` = WebSocket. No mezclar protocolos con puertos

### CoreX
- Bridge que traduce paquetes UDP de AgOpenGPS a MQTT
- Ruta: `C:\CoreX\server.js`
- Conecta a `mqtt://127.0.0.1:1883`
- Publica: velocidad, posición GPS (lat, lon, heading, vel), secciones, estado de campo
- PGN 254 → velocidad, PGN 100 → posición GPS, PGN 229 → secciones
- PGN 253 → envía work switch a AOG cada 200ms

### VistaX
- Servidor Node.js + Express + Socket.IO + EJS + CouchDB
- Ruta: `C:\VistaX-Core\`
- Puerto: 3001
- **CRÍTICO**: `mqtt_handler.js` debe conectar con `process.env.MQTT_BROKER || "mqtt://127.0.0.1:1883"` — NO hardcodear `mqtt://127.0.0.1` sin puerto
- Shell desktop: WPF + WebView2 (C#)

### VistaX-Node (firmware ESP32-S3)
- UID derivado del MAC: `VX-XXXXXXXXXXXX` (ej: `VX-9C82E5A1DF7C`)
- **Cables numerados desde 1** (firmware) — perfil los guarda **desde 0** (0-based)
- Publica a `vistax/nodos/telemetria` (NO a `/pulsos` que no existe)
- Formato: `{ uid, sensores: [{cable: 1-7, raw, valor}] }`
- Heartbeat cada 10s a `vistax/nodos/heartbeat` con RSSI fresco
- Estado STATE cada 10s aunque no haya cambios
- WiFiManager con portal cautivo temático Agro Parallel
- Reconexión inteligente: 10 fallos MQTT → abre portal cautivo

---

## Tópicos MQTT (referencia rápida)

| Tópico | Publica | Contenido |
|---|---|---|
| `vistax/nodos/telemetria` | Node | Pulsos cada 500ms (cable 1-based) |
| `vistax/nodos/heartbeat` | Node | Keepalive con rssi, ip cada 10s |
| `vistax/nodos/registro` | Node | Anuncio inicial al conectarse |
| `vistax/nodos/ack` | Node | Respuesta a comandos |
| `vistax/nodos/{uid}/cables/config` | VistaX | Config pulse/state (retained) |
| `vistax/nodos/comando/{uid}` | VistaX | reiniciar, borrar_wifi, OTA |
| `aog/machine/speed` | CoreX | String plano "7.5" (km/h) |
| `aog/machine/position` | CoreX | JSON {lat, lon, heading, vel, gps_ts} |
| `sections/state` | CoreX | {t1: [...], t2: [...]} (secciones AOG) |
| `aog/field/status` | CoreX | {painting, fieldName, accion, ts} |

---

## Estructura de perfil de implemento

Archivo: `data/implementos/{id}.json`

```json
{
  "id": "tanzi_43",
  "nombre": "Tanzi 43",
  "trenes": {
    "1": { "surcos": 21, "orden": 1, "nombre": "Tren 1" },
    "2": { "surcos": 22, "orden": 2, "nombre": "Tren 2" }
  },
  "mapeo_sensores": [
    { "uid": "VX-9C82E5A1DF7C", "cable": 0, "tipo": "semilla", "tren": "1", "bajada": 1, "is_active": true }
  ],
  "setup": {
    "modo_monitoreo": "semilla",
    "surcos_minimos_monitoreo": 3,
    "alarma_tiempo_seg": 2,
    "densidad_objetivo": 5.2,
    "tolerancia_desvio": 20,
    "velocidad_max": 8.5,
    "distancia_entre_surcos": 0.525,
    "lotes_auto_purge_dias": 90
  }
}
```

### Reglas clave del perfil
- **Cable firmware vs perfil**: firmware envía cable 1-7, perfil guarda 0-6. El `find()` en mqtt_handler hace `cableFisico - 1` para matchear
- **Duplicados**: puede haber registros duplicados de mismo uid+cable (uno activo, uno inactivo). El `find()` filtra `is_active === false` primero para siempre tomar el activo
- **Trenes**: `orden=1` → fila inferior visual (más cerca del operario mirando de atrás). Surco 1 a la izquierda
- **Soft-delete**: `is_active: false`, nunca borrar físicamente del array

---

## mqtt_handler.js (v6.3+ — estado actual)

### Sistema de monitoreo activo/inactivo
- **Modo "aog"**: activo cuando CoreX publica `painting: true` en `aog/field/status`
- **Modo "semilla"**: activo cuando N surcos reportaron pulsos en los últimos 3 segundos (ventana configurable)
- Cambio inmediato (sin histéresis de tiempo adicional)
- Emite `monitoreo_estado` por Socket.IO → bar.js pinta badge verde/gris
- **Siempre se ven los pulsos** (visualización verde) — solo las ALARMAS se silencian en stand-by

### Alarma con delay (ciclos consecutivos en cero)
- Un `Map<keyAlarma, contador>` trackea ciclos consecutivos con `raw=0` por surco
- `alarma_tiempo_seg` del perfil ÷ 0.5 = ciclos necesarios (ej: 2s = 4 ciclos)
- Si el surco reporta raw>0, el contador se resetea inmediatamente
- Desvío de dosis (poca semilla pero no cero) sigue siendo inmediato
- Campo: `setup.alarma_tiempo_seg` (default 2)

### Velocidad de AOG
- Se lee de DOS fuentes como fallback:
  - `aog/machine/speed` → string plano, `parseFloat(message.toString())`
  - `aog/machine/position` → JSON con campo `vel`, `parseFloat(payload.vel)`
- CoreX debe publicar `vel` dentro del payload de posición (se agregó)

### Lectura de perfil
- Recarga cada 5 segundos con `setInterval(recargarConfig, 5000)`
- NUNCA usar `window.APP_CONFIG` en el server (eso es frontend)
- Fetch fresco del backend en cada apertura del modal config

---

## bar.js (v3.2 — estado actual)

### Overlay de activación de audio
- Banner "TOCÁ PARA ACTIVAR" fullscreen al abrir `/bar`
- Primer touch/click/key → desbloquea audio con play/pause silencioso → desaparece con animación
- Si hay fallas pendientes al cerrar overlay, alarma suena inmediatamente
- Cada sesión nueva (recarga de página) vuelve a mostrar el overlay

### Estado sin-dato (azul apagado)
- Tubos arrancan con clase `sin-dato` (azul `#2d4a5a`)
- Timer cada 1s evalúa: si no hubo reporte en 10s → `sin-dato`
- **IMPORTANTE**: `ultimoPulsoVisual[b]` se actualiza siempre que el nodo reporta (raw=0 también), NO solo cuando raw>0. Si solo se actualizara con raw>0, los tubos titilan entre azul y normal
- Excepciones: no toca tubos con falla, cortado, omitido o en medio de pulse

### Pulso visual
- Flash verde SIEMPRE que `rawPulsos > 0`, independiente de velocidad, monitoreo, SPM
- Con monitoreo activo → `pulse-mon` (verde brillante `#00e676` con glow)
- En stand-by → `pulse-standby` (verde atenuado 60% opacidad)
- Duración: 500ms (`PULSE_VISUAL_MS`)

### Badge de monitoreo
- `mon-badge` en el header con estados `activo` (verde) y `standby` (gris)
- Se actualiza vía Socket.IO evento `monitoreo_estado`
- Estado inicial emitido al conectar socket nuevo

---

## Sistema de grabación georreferenciada (MVP 1)

### Arquitectura: NDJSON append-only
- Fuente de verdad: `eventos.ndjson` (1 línea por sensor/cable con raw>0 o cambio de estado)
- GPS submuestreado: `gps.ndjson` (1 posición/segundo para auditoría)
- Vista web: `parcial.geojson` (ventana móvil 5 min, regenerado cada 30s, descartable)
- Al cerrar lote: `final_puntos.geojson` + `final_puntos.zip` (shapefile) + `resumen.json`

### Módulos en core/geo/
```
core/geo/
  ├── gps_buffer.js         Buffer circular GPS (100 posiciones, interpolación binaria)
  ├── lote_recorder.js      NDJSON append-only + parcial + flush cada 2s
  ├── map_exporter.js       GeoJSON final + shapefile al cerrar lote
  └── lote_purge.js         Auto-borrado por antigüedad (configurable, default 90 días)
```

### Formato de línea NDJSON
```json
{"seq":1,"ts":1713300000123,"uid":"VX-9C82E5A1DF7C","cable":0,"bajada":1,"tipo":"semilla","raw":3,"lat":-33.12001,"lon":-60.45031,"vel":7.2,"hdg":92.8,"spm":14.7,"gps_q":57}
```

### Cambio de estado (raw > 0 → raw = 0)
- Cuando un surco pasa de sembrar a no sembrar, se escribe UNA línea con raw=0
- Marca el punto exacto donde dejó de caer semilla (inicio de zona de falla)
- NO se escriben millones de ceros continuos

### Interpolación GPS
- Buffer circular de 100 posiciones (10s a 10Hz)
- Búsqueda binaria para interpolar lat/lon/heading/vel al timestamp del pulso
- Tolerancia: <250ms bueno, <1000ms aceptable, >2000ms descarta
- `gps_q` = distancia en ms al GPS más cercano

### Volumen estimado
- 43 surcos × 2 ciclos/seg × 160 bytes ≈ 555 MB/jornada (14h)
- 96 surcos a 12 km/h ≈ 1.24 GB/jornada
- Solo escribir raw > 0 y cambios de estado reduce 15-20%

### Recuperación al reiniciar
- Busca lotes sin `fin` en metadata.json
- Valida NDJSON (descarta última línea corrupta)
- Recupera último `seq`
- Reabre stream en modo append

### Dependencias
```
npm install shp-write archiver
```

---

## PM2 y arranque automático

### Estructura
```
C:\AgroParallel\
  ├── ecosystem.config.js     Config PM2 para 3 servicios
  ├── LAUNCHER.bat             Arranque secuencial (Startup de Windows)
  ├── .pm2\                    PM2 home (setear PM2_HOME)
  └── logs\                    Logs de PM2
```

### ecosystem.config.js
- BrokerX: `C:\BrokerX\index.js`
- CoreX: `C:\CoreX\index.js` con `MQTT_BROKER: "mqtt://127.0.0.1:1883"`
- VistaX: `C:\VistaX-Core\server.js` con `MQTT_BROKER: "mqtt://127.0.0.1:1883"`, `PORT: 3001`

### LAUNCHER.bat — secuencia de arranque
```
1. Iniciar BrilloWidget (oculta pantalla mientras carga)
2. Esperar red: ping 192.168.5.1 en loop
3. PM2 start BrokerX → esperar que puerto 1883 esté LISTENING
4. PM2 start CoreX → esperar 5s
5. PM2 start VistaX → esperar que localhost:3001 responda
6. Iniciar AgOpenGPS
```

### Notas PM2 en Windows
- `pm2-windows-service` tiene problemas de permisos EPERM con named pipes → NO USAR
- En su lugar: LAUNCHER.bat en carpeta Startup de Windows
- Siempre usar `call pm2` en .bat (sin `call`, el bat se detiene después del primer pm2)
- Setear `PM2_HOME=C:\AgroParallel\.pm2` antes de cada comando pm2
- Variable global: `setx PM2_HOME "C:\AgroParallel\.pm2" /M`

---

## Paleta Agro Parallel (CSS)

```css
--ap-bg:        #0f1620;
--ap-bg-2:      #1a2332;
--ap-bg-3:      #243144;
--ap-border:    #2d3a4f;
--ap-text:      #e8eef5;
--ap-text-muted:#8a9bb0;
--ap-green:     #84cc16;     /* verde Agro Parallel (branding) */
--ap-green-hi:  #00e676;     /* verde brillante (tubos activos en bar, visibilidad cabina) */
--ap-red:       #ef4444;
--ap-yellow:    #f59e0b;
--ap-blue:      #3b82f6;
```

Bar usa verde brillante `#00e676` para tubos activos (visibilidad a distancia en cabina).

---

## Archivos de audio

Ruta: `public/audio/` (y copia en `public/sounds/` para compatibilidad)

| Archivo | Uso | Duración |
|---|---|---|
| `alarma.mp3` / `alarma1.mp3` | Tubo tapado (loop) | 2s |
| `alerta_grave.mp3` | Nodo offline, AOG perdido | 2s |
| `alerta_media.mp3` | Desvío de dosis | 1s |
| `beep_corto.mp3` | Inicio/cierre de lote | 0.3s |

`bar.js` actualmente usa `/sounds/alarma1.mp3`. El sistema jerárquico del Tab Pantalla usa `/audio/`.

---

## Interfaz de configuración (/config) — 8 tabs completados

| Tab | Archivo | Funcionalidad |
|---|---|---|
| Perfiles | `tab_perfiles.js` | CRUD, activar, duplicar, bloquear |
| Nodos | `tab_nodos.js` | Inventario ESP32, reemplazo con migración |
| Trenes | `tab_trenes.js` | Estructura física, detección huérfanos |
| Sensores | `tab_sensores.js` | Asignación cables→surcos, wizard autonumeración, override sonido |
| Monitoreo | `tab_monitoreo.js` | modo_monitoreo, umbrales, velocidades |
| Pantalla | `tab_pantalla.js` | Sonidos jerárquicos (master→tipo→sensor) |
| Mapeo Visual | `tab_mapeo.js` | SVG read-only, 3 modos de coloreo |
| Prueba | Ruta `/prueba` | Mobile-first, vibración háptica |

---

## Bugs históricos resueltos (NO REPETIR)

1. **Stale config**: modal viejo leía `window.APP_CONFIG` → siempre fetch fresco del backend
2. **Cable 1-based vs 0-based**: firmware envía 1-7, perfil guarda 0-6. Handler hace `cableFisico - 1`
3. **Duplicados en find()**: si hay registros duplicados de uid+cable, filtrar `is_active === false` PRIMERO en el find
4. **Alarma por 1 ciclo**: un solo raw=0 disparaba alarma → ahora espera `alarma_tiempo_seg` ciclos consecutivos
5. **Titileo sin-dato**: `ultimoPulsoVisual` solo se actualizaba con raw>0 → actualizar SIEMPRE que el nodo reporta
6. **Audio autoplay Chrome**: bloquea play() sin gesto → overlay "Tocá para activar" al cargar bar
7. **Dos brokers**: Mosquitto en 1883 + Aedes en 3000 → unificar en Aedes solo, todo al 1883
8. **pm2-windows-service EPERM**: permisos de named pipes → usar LAUNCHER.bat en Startup
9. **`call pm2` en .bat**: sin `call`, el bat se detenía después del primer pm2
10. **CoreX sin vel en position**: topic `aog/machine/position` no incluía velocidad → agregado `vel: velocidadActual`
11. **`.env` expuesto en git**: `git filter-repo` + rotación de credenciales

---

## Nodos conocidos en el sistema

| UID | Rol en tanzi_43 |
|---|---|
| VX-9C82E5A1DF7C | Tren 1, surcos 1-7 (cables 0-6) |
| VX-C8A0F116A398 | Tren 1, surcos 8-14 |
| VX-545EDE4EB580 | Tren 1, surcos 15-21 |
| VX-9459DE4EB580 | Tren 2, surcos 38-43 (cables 0-5). Cable 6 sin mapeo activo |
| VX-D4DA4DBA2010 | Tren 2, surcos 23-29 |
| VX-54374DBA2010 | Tren 2, surcos 22, 30-35 |
| VX-DC9FE616A398 | Tren 2, surcos 36-37 + turbina + ejes + tolva |

---

## Pendientes conocidos

1. **AOG se cierra al iniciar** si VistaX no está listo — el LAUNCHER.bat con espera secuencial debería resolverlo. Si no, buscar archivo VistaX.json en carpeta de AOG con flag de auto-inicio
2. **Velocidad no llega a VistaX** — verificar que mqtt_handler use `process.env.MQTT_BROKER` y que CoreX incluya `vel` en el payload de posición
3. **Cascada de sonidos jerárquica** en bar.js (master → tipo → sensor) — hoy suena alarma1.mp3 genérico para todo
4. **Integración OrbitX cloud** (dashboard remoto, `orbitx.agroparallel.com`, PM2 :5005)
5. **MVP 2 del geo**: segmentos por surco/bajada al cerrar lote
6. **MVP 3 del geo**: celdas/grilla para mapa agronómico de densidad
7. **Tab Monitoreo**: labels de UI deberían decir "Piloto Agro Parallel" en vez de "AOG"

---

## Principios irrompibles

1. **Parches quirúrgicos, NO rewrites.** Si rompe lo que anda, se descarta.
2. **Cero hardcoded.** Todo parametrizable por perfil.
3. **Fresh config en modal.** Siempre fetch del backend. Nunca `window.APP_CONFIG`.
4. **Logs prefijados** por componente y versión: `[Bar v3.2]`, `[VistaX MQTT]`, `[LoteRecorder]`.
5. **Commits scopeados** por feature. Describir antes de implementar.
6. **UI táctil.** Targets mínimos 44px, preferible 60-90px en mobile.
7. **Cable translation**: firmware 1-based, perfil 0-based, handler traduce.
8. **Audio unlock**: siempre banner o gesto previo. Chrome no perdona.
9. **BroadcastChannel** preferido sobre Socket.IO round-trips para browser ↔ browser.
10. **Validar contra reglas agronómicas reales**, no solo técnicas.

---

## Cómo querés que Claude se comporte

- Tono directo, sin adulación. Pushback cuando algo no tiene sentido.
- Respuestas concisas, sin preámbulos ni cierres vacíos.
- Si la solicitud es ambigua, preguntar antes de tirar código.
- Proponer primero el plan (qué archivos, qué parches), esperar OK, después entregar.
- No asumir nada sobre el estado del código que no esté confirmado en el chat actual.
- Usar las convenciones del proyecto (nombres de variables existentes, estructura de carpetas).
- Parches con búsqueda y reemplazo exacto, no archivos completos salvo que sea necesario.
