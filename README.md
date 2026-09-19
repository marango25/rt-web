# RT-Web — TunerPro RT propio, web-first

Editor de XDF/tablas + logging en tiempo real vía ESP8266 (WiFi) hablando ALDL (GM OBD1).

## Estructura

```
rt-web/
├── src/                          # Web app (vanilla JS, sin build step)
│   ├── index.html
│   ├── style.css
│   ├── xdf-parser.js             # Parser de XDF/ADX (formato XML de TunerPro)
│   ├── ws-client.js              # Cliente WebSocket hacia el ESP8266
│   ├── sim-source.js             # "Modo simulado": datos falsos realistas sin hardware
│   ├── db.js                     # Sesiones guardadas en IndexedDB (autoguardado)
│   ├── surface3d.js              # Vista 3D de tablas (Three.js, se carga con import() dinámico)
│   ├── main.js                   # UI: tablas, parámetros en vivo, replay, comparador de bins
│   └── vendor/                   # Three.js + OrbitControls vendorizados (sin CDN, MIT license)
├── firmware/
│   └── esp8266_aldl_bridge/
│       ├── esp8266_aldl_bridge.ino   # Firmware: ALDL 160/8192 baud (autodetectado) + WebSocket
│       └── secrets.h.example         # Copia a secrets.h con el AP_SSID/AP_PASS del ESP8266 (gitignored)
└── defs/
    ├── example.adx                   # Ejemplo INVENTADO (mismo mapeo que el Sonoma, para demo)
    ├── example.xdf                   # Tabla de ejemplo INVENTADA, para probar el overlay/vista 3D
    ├── example_calibration.bin       # Binario demo que le da valores reales a example.xdf
    └── gmc_sonoma_1993_a040.adx      # Definición REAL para ECM 1228062 / ALDL "A040"
                                       # (GMC Sonoma 1993 2.8L TBI), convertida a mano
                                       # desde un .ads de la comunidad. Ver comentarios
                                       # en el propio archivo para qué falta y por qué.
```

## Cómo correrlo ahora (sin hardware, "Modo simulado")

1. Corre un servidor estático simple dentro de `src/` (necesario: la app usa ES modules +
   import maps, que la mayoría de navegadores bloquean al abrir `index.html` directo con
   doble clic vía `file://`):

   ```bash
   cd src && python3 -m http.server 8099
   ```

   y abre `http://localhost:8099/index.html`.
2. Carga una definición desde "Cargar definición": puedes cargar `defs/example.adx`
   (parámetros en vivo) y `defs/example.xdf` (tabla) juntos — no se pisan.
3. Click en "Modo simulado" para generar datos falsos oscilantes sin necesitar el ESP8266.
4. Prueba el resto: click en una tarjeta para ampliar su gráfica, "Ver en 3D" en la tabla,
   carga `defs/example_calibration.bin` en el campo de binario para ver valores reales en
   la tabla, o descarga el CSV y pruébalo en el replay.

## Cómo sigue (con tu ESP8266)

El ESP8266 transmite **su propia red WiFi** (modo Access Point) en vez de unirse
a la de tu casa — así no depende de tener un WiFi conocido a la mano, sirve
igual en la calle, en el trabajo o donde sea que estés probando el vehículo.

1. Copia `firmware/esp8266_aldl_bridge/secrets.h.example` a `secrets.h` (mismo directorio)
   y pon ahí el `AP_SSID`/`AP_PASS` que quieras para esa red — ese archivo está en
   `.gitignore`, nunca se sube. `AP_PASS` necesita mínimo 8 caracteres.
2. Abre `esp8266_aldl_bridge.ino` en Arduino IDE / PlatformIO y ajusta el pin del
   nivel-shifter ALDL si hace falta (ver comentarios en el archivo).
3. Flashea al ESP8266. Al bootear, imprime por Serial (115200 baud) el nombre de
   la red y su IP (normalmente `192.168.4.1`, fija).
4. Desde tu celular/laptop, conéctate a esa red WiFi como cualquier otra.
5. En la web app, pon esa IP (o `rtweb.local`, si te funciona el mDNS) en el
   campo de conexión y da "Conectar".
6. Los frames crudos que llegan por WebSocket se decodifican con la definición
   `.adx` cargada, y se grafican en vivo. El firmware autodetecta 160 vs 8192 baud
   (ver `CLAUDE.md` para el detalle de qué tan validado está cada modo).

## Por qué no está publicado como Artifact de claude.ai

Un WebSocket hacia un dispositivo en tu red local (ej. `192.168.1.50`) está bloqueado
por la política de seguridad de las páginas publicadas en claude.ai. Por eso este
proyecto vive como archivos reales que tú hosteas: local, desde un Raspberry Pi, o
incluso que el propio ESP8266 lo sirva.

## Estado actual / próximos pasos honestos

- [x] Parser XDF/ADX (tablas 2D, metadata de PIDs)
- [x] UI de tabla editable básica + parámetros en vivo con gráficas y alertas
- [x] Cliente WebSocket + protocolo de mensajes JSON
- [x] Firmware base: bit-banging ALDL 160 baud + servidor WebSocket
- [x] Modo simulado (datos falsos realistas) para probar la UI sin hardware
- [x] Sesiones guardadas en IndexedDB + replay/comparación de logs CSV con zoom
- [x] Vista 3D de superficie (Three.js) para tablas XDF
- [x] Autodetección de protocolo (160/8192 baud) en el firmware — 160 confirmado con
      hardware real, 8192 solo detecta actividad UART válida, sin validar contra una ECU real
- [x] Checksum / comparador de binarios
- [x] Overlay del log en vivo sobre las tablas (resalta la celda donde opera el motor)
- [ ] Calibración real con un `.xdf` verdadero del 1228062/A040 (necesita reverse-engineering
      o encontrar uno ya hecho en la comunidad — ver `CLAUDE.md`)

## Licencia

Copyright (C) 2026 Miguel Arango

GPLv3 — ver [LICENSE](LICENSE). En corto: puedes usar, copiar, modificar y distribuir este
proyecto libremente, pero cualquier versión modificada que distribuyas debe seguir siendo
código abierto bajo la misma licencia.

Three.js y OrbitControls (`src/vendor/`) son de terceros, licencia MIT — sus avisos de
copyright quedan intactos en los propios archivos vendorizados.
