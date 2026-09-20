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
- `src/ws-client.js` — cliente WebSocket con reconexión automática (modo WiFi).
- `src/serial-client.js` — modo USB: lee los frames por Web Serial (Chrome/Edge,
  solo en `http://localhost` o https) parseando las líneas `Frame ALDL (160 baud): XX XX ...`
  que el firmware YA imprime por serial (115200) - no requirió cambios de firmware, y
  también entiende el formato viejo sin `(160 baud)`. Llama a `onFrame(bytes, t, proto)`
  igual que `ws-client.js`; en `main.js` WiFi, USB y simulado se excluyen entre sí.
  Existe para que la computadora no pierda internet (con el ESP8266 en modo AP, conectarse
  por WiFi a su red la deja sin internet, y sin Claude en vivo durante la prueba).
  Probado con un `navigator.serial` falso + frames reales de `sin_iac.csv`; NO probado
  aún con un ESP8266 real conectado por USB.
- `src/protocol-profile.js` + `src/firmware-link.js` (v2) — **perfil de protocolo como
  dato**. El ADX puede traer un bloque opcional `<PROTOCOL baud="160" framebytes="20"
  promidindex="1" promid="02 27"/>` (ver `defs/gmc_sonoma_1993_a040.adx`) con lo que en v1
  estaba compilado en el firmware para el Sonoma. Al conectar (WiFi o USB) la web hace un
  apretón de manos con el firmware: `hello` -> perfil -> confirmación, y muestra el
  resultado en la barra lateral. **Sin bloque, o con un firmware v1 que no contesta el
  hello (tras 3 s), se comporta exactamente como v1** (valores fijos del Sonoma); solo
  avisa en rojo si la definición pide un perfil que un firmware v1 no puede aplicar.
  Protocolo, en JSON (un mensaje por WebSocket, o una línea por Serial en modo USB): ver el
  encabezado de `firmware-link.js` y la sección "PERFIL DE PROTOCOLO" del `.ino`.
- `test/` (v2) — pruebas de esa lógica: `node --test` desde la raíz (Node 22.7+, sin
  dependencias). Cubren lo puro (sin DOM); `parseADX` y el cableado en `main.js` se
  verificaron aparte en un navegador real. El firmware compila con el `arduino-cli` que trae
  el Arduino IDE (`--fqbn esp8266:esp8266:nodemcuv2`, con un `secrets.h` de ejemplo) y su
  lógica se probó en el host; **no se ha probado en la placa**. **Ojo:** un temporizador sin envolver (`this.clearTimer(...)` con `clearTimeout`
  directo) pasa en node y falla en el navegador con "Illegal invocation".
- `src/main.js` + `index.html` + `style.css` — UI: cargar definición,
  tabla estática (XDF) o tarjetas de valores en vivo (ADX).
- `firmware/esp8266_aldl_bridge/esp8266_aldl_bridge.ino` — firmware de referencia: bit-banging
  ALDL a 160/8192 baud autodetectado (timing en `ALDL_BIT_US`, probablemente
  necesite ajuste fino con hardware real), servidor WebSocket async, mDNS
  (`rtweb.local`). El ESP8266 transmite **su propia red WiFi** (modo Access
  Point, `WiFi.softAP` con `AP_SSID`/`AP_PASS` de `secrets.h`) en vez de
  unirse a una existente - no depende de tener el WiFi de casa o un hotspot
  a la mano, sirve igual en la calle (cambio hecho a petición del usuario,
  después de que tuvo que reflashear en la calle con su hotspot del celular).
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

(Actualización 2026-09-19: lo de arriba es historial; el montaje ya está armado y
lee el camión con la v1.0.0. El cableado real está en la sección siguiente.)

## Conexión electrónica (resumen; esquema y verificaciones en `docs/electronica.md`)

Montaje casero de **solo lectura** con un NodeMCU ESP8266 (ESP-12E) en protoboard,
según el "Diagrama ALDL NodeMCU" del usuario (2026-09-19):

- **Dato:** pin E del ALDL (en algunos conectores, el M; ~5 V) → 1 kΩ → nodo → **D2 =
  GPIO4** (`ALDL_PIN 4` en el firmware); del nodo, 2.2 kΩ a GND. Da ~3.44 V en D2.
  Nunca el pin de datos directo al GPIO: el ESP8266 no tolera 5 V. En paralelo con la
  2.2 kΩ va un condensador cerámico de **4.7 nF** ("472") anti-ruido: sirve de 1 a 10 nF,
  **nunca 100 nF** (deja poco margen frente al pulso corto de ~370 µs del ALDL).
- **Tierra común:** pin A del ALDL ↔ GND del NodeMCU.
- **10 kΩ entre el pin B (diagnóstico) y el pin A:** según el diagrama, es lo que
  hace que la ECM transmita el flujo de datos. El ESP8266 **no** se conecta al pin B
  (ECM A9, blanco/negro); ahí solo va la resistencia. En el ECM, el dato es A8 (naranja).
- **Alimentación:** micro-USB desde un cargador de encendedor 12 V → 5 V (o el USB
  de la computadora en modo USB).
- **Sin camino de transmisión hacia la ECM.** Cualquier cosa que exija enviarle
  peticiones (p. ej. Mode 1 a 8192 baud) necesita hardware nuevo que no existe todavía.
- **Diagramas:** `docs/img/esquema-aldl.svg` y `docs/img/protoboard-aldl.svg`, extraídos
  del "Diagrama ALDL NodeMCU" del usuario (versión con condensador, 2026-09-19); el
  detalle y el montaje están en `docs/electronica.md`.
- **Sin confirmar:** voltaje medido en D2 con el motor en marcha, y si el condensador, el
  cable trenzado y la tierra corta que ya trae el diagrama están instalados en el camión.
  No des por hecho ninguno de los dos.

## Resultado real (2026-09-19)

El sistema ya cumplió su propósito: los registros del Sonoma ayudaron a encontrar un
problema que no se veía a simple vista. En ralentí caliente sin A/C el sensor O2 (1 hilo,
sin calefactor) casi no se mueve (~50 mV de variación) y la ECM está en lazo cerrado solo
~10 % del tiempo; en las sesiones largas, con el escape caliente, el sensor oscila (120 a
866 mV) y el lazo cerrado sube a 71–96 %. Es una **hipótesis respaldada por datos, sin
confirmar**: falta cambiar el sensor por uno calefactado y repetir las capturas, y eso se
trata aparte del desarrollo. Detalle para humanos en el README ("Primer caso real").

## Pendiente (backlog real, en orden sugerido)

1. ~~Modo simulado en la web app~~ — HECHO: `src/sim-source.js` genera
   frames falsos oscilantes (onda seno por byte) y se conecta al mismo
   pipeline `onFrame` que usa `ws-client.js`, vía el botón "Modo simulado"
   en la sidebar. No pisa la conexión real (cada uno detiene al otro).
2. ~~Vista de superficie 3D (Three.js) para tablas XDF~~ — HECHO: botón "Ver
   en 3D" en cada tabla (`buildTablesHtml()` en `src/main.js`) abre un panel
   fijo fuera de `el.main` (mismo patrón que el tooltip/banner - una escena
   WebGL no se puede reconstruir en cada re-render de `renderMain()` sin
   perder la cámara) con la superficie orbitable, coloreada por altura, más
   el mismo marcador de "posición actual" que el overlay 2D. Lógica en
   `src/surface3d.js`, cargado con `import()` dinámico solo al abrirse (para
   no pagar la descarga de Three.js en sesiones que nunca tocan tablas).
   **Three.js está vendorizado localmente** en `src/vendor/` (no CDN, para
   que funcione sin internet) y resuelto vía import map en `index.html` -
   son ~700KB entre el core y OrbitControls. Si algún día hosteas la app
   directo desde el ESP8266 (en vez de una laptop/Raspberry Pi), ojo con el
   espacio de flash disponible para SPIFFS/LittleFS; probado con
   `defs/example.xdf` + `example_calibration.bin` vía "Modo simulado".
3. ~~Autodetección de protocolo (160 vs 8192 baud) en el firmware~~ — HECHO:
   `esp8266_aldl_bridge.ino` prueba 160 baud primero (confirmado en el
   Sonoma) y, tras `ALDL_PROTO_FAILURES_BEFORE_SWITCH` intentos fallidos
   seguidos, alterna a intentar 8192 baud (`readAldlFrame8192`, UART
   estándar 8N1 por bit, distinto al esquema de ancho de pulso de 160 baud).
   **Importante:** el modo 8192 solo detecta actividad con forma de UART
   válida y manda bytes crudos con `"proto":"8192"` en el JSON - NO tiene
   frame/PROM ID/checksum validado (nunca se probó contra una ECU real que
   lo use), a diferencia de 160 baud que sí está confirmado. La web app
   (`ws-client.js`/`main.js`) ya lee ese campo y muestra una alerta roja si
   llegan frames en modo 8192, para no confundirlos con datos reales del
   Sonoma.
4. ~~Checksum / comparador de binarios~~ — HECHO: sección nueva en la
   sidebar ("Comparar binarios (.bin)", Binario A/B) que activa una vista
   dedicada (`viewMode = "bindiff"` en `src/main.js`, mismo patrón que
   replay). Muestra checksums genéricos (suma 8 bits, suma 16 bits, CRC32 -
   **no** el checksum interno real del 1228062, que no está documentado
   acá) y, si difieren, la lista byte a byte de diferencias con el offset;
   si hay una tabla `.xdf` cargada, anota en qué celda cae cada diferencia
   (probado con `defs/example.xdf` + una copia mutada de
   `example_calibration.bin`: ubicó las 2 celdas modificadas correctamente).
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
