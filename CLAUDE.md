# Contexto del proyecto — léeme primero

Este archivo es para ti, Claude (en Claude Code). El usuario viene de una
conversación en claude.ai donde se definió este proyecto desde cero. Aquí
está el resumen completo para que retomes sin que el usuario tenga que
re-explicar todo.

## Qué es esto

Un "TunerPro RT" propio, web-first: editor de definiciones + logging en
tiempo real de una ECU GM OBD1 (protocolo ALDL), usando un ESP8266 como
puente WiFi entre el bus ALDL del vehículo y una web app.

## Decisiones ya tomadas (no las reabras sin razón)

1. **Formato de definiciones: XDF/ADX reales de TunerPro, no un formato propio.**
   Son XML, están bien documentados por la comunidad (tunerpro.net,
   ALDLdroid, foros GMT400/thirdgen/beretta.net), y así heredamos toda la
   biblioteca ya existente en vez de crear la nuestra desde cero.

2. **El ESP8266 es "tonto a propósito":** solo hace bit-banging del protocolo
   ALDL y manda bytes crudos por WebSocket (`{"t": millis, "raw": [...]}`).
   Toda la inteligencia de "qué significa cada byte" vive en la web app,
   aplicando la definición `.adx` cargada. Esto es análogo a cómo XDF nunca
   toca el binario de la ECU directamente.

3. **NO se publica como Artifact de claude.ai.** Un WebSocket hacia una IP
   de red local (el ESP8266) es bloqueado por el CSP de las páginas
   publicadas ahí. Este proyecto vive como archivos reales que el usuario
   hostea (localmente, Raspberry Pi, o el propio ESP8266 sirviendo el HTML).

4. **Protocolo objetivo: GM ALDL, 160 baud primero** (8192 baud después).
   El vehículo/ECU específico del usuario todavía no se ha confirmado —
   pregúntale si aún no lo sabes, porque afecta el mapa de bytes real en
   el `.adx` (los valores en `defs/example.adx` son de ejemplo/inventados,
   NO son datos reales de ninguna ECU).

## Estado del código (ya escrito, no reescribir desde cero)

- `src/xdf-parser.js` — parsers de XDF y ADX, con evaluador de ecuaciones
  lineales simples (`X*a+b`, etc). Soporta lo común, no todos los casos.
- `src/ws-client.js` — cliente WebSocket con reconexión automática.
- `src/main.js` + `index.html` + `style.css` — UI: cargar definición,
  tabla estática (XDF) o tarjetas de valores en vivo (ADX).
- `firmware/esp8266_aldl_bridge/esp8266_aldl_bridge.ino` — firmware de referencia: bit-banging
  ALDL a 160 baud (timing en `ALDL_BIT_US`, probablemente necesite ajuste
  fino con hardware real), servidor WebSocket async, mDNS (`rtweb.local`).
  **Advertencia de hardware ya está en el propio archivo:** no conectar el
  pin ALDL directo al GPIO sin buffer/nivel-shifter.

## Estado del hardware (a 2026-09-15)

Level-shifter armado, ESP8266 flasheado y probado por WiFi/WebSocket (falta
reflashear con la corrección de bit-banging de esta sesión). Vehículo/ECU
confirmado: **GMC Sonoma 1993, 2.8L TBI, 5 vel. manual, 4x2, A/C** — ECM
**1228062**, definición ALDL **"A040"**, 160 baud, dato por pin A8/naranja
(ECM) = pin E (conector ALDL). Definición real ya convertida a
`defs/gmc_sonoma_1993_a040.adx` (ver ese archivo para detalle de qué falta:
flags de 1 bit, PROM ID de 16 bits). Falta cablear el naranja al nivel-shifter
y conectar con la llave en "on" para probar contra el auto real.

## Pendiente (backlog real, en orden sugerido)

1. ~~Modo simulado en la web app~~ — HECHO: `src/sim-source.js` genera
   frames falsos oscilantes (onda seno por byte) y se conecta al mismo
   pipeline `onFrame` que usa `ws-client.js`, vía el botón "Modo simulado"
   en la sidebar. No pisa la conexión real (cada uno detiene al otro).
2. Vista de superficie 3D (Three.js) para tablas XDF.
3. Autodetección de protocolo (160 vs 8192 baud) en el firmware.
4. Checksum / comparador de binarios (funcionalidad de TunerPro aún no
   portada).
5. ~~Overlay del log en vivo sobre las tablas del XDF~~ — HECHO: cargar un
   .xdf y un .adx a la vez ya no se pisan (`loadedTables`/`loadedParams`
   conviven); `renderMain()` en `src/main.js` dibuja ambos y resalta en cada
   tabla la celda donde está operando el motor ahora mismo, emparejando el
   título de cada eje con un parámetro en vivo por nombre (auto-match, con
   selects manuales de respaldo si adivina mal). Cargar un `.bin` (nuevo
   input opcional) muestra valores reales de celda en vez de solo offsets.
   Ver `defs/example.xdf` + `defs/example_calibration.bin` para una demo
   completa vía "Modo simulado". Aplica solo a la vista en vivo/simulada,
   no a replay de CSV.
6. Calibración real: esto requiere que el usuario tenga el hardware armado
   y probando contra su ECU. Espera iterar el timing/framing de ALDL varias
   veces basado en lo que el usuario reporte del hardware real.

## Cómo seguir

Pregunta al usuario en qué punto está (¿ya armó el level-shifter? ¿ya
flasheó el ESP8266? ¿qué vehículo/ECU específico?) antes de asumir el
siguiente paso. No re-litigar las decisiones de la sección anterior salvo
que el usuario explícitamente pida cambiarlas.
