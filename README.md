# RT-Web — TunerPro RT propio, web-first

Editor de XDF/tablas + logging en tiempo real vía ESP8266 (WiFi) hablando ALDL (GM OBD1).

## Estructura

```
rt-web/
├── src/                 # Web app (vanilla JS, sin build step)
│   ├── index.html
│   ├── style.css
│   ├── xdf-parser.js    # Parser de XDF/ADX (formato XML de TunerPro)
│   ├── ws-client.js     # Cliente WebSocket hacia el ESP8266
│   └── main.js          # UI: cargar XDF, tabla editable, log en vivo
├── firmware/
│   └── esp8266_aldl_bridge/
│       └── esp8266_aldl_bridge.ino   # Firmware: habla ALDL 160 baud, expone WebSocket
└── defs/
    ├── example.adx                  # Ejemplo INVENTADO (4 parámetros de muestra, para probar el parser)
    └── gmc_sonoma_1993_a040.adx     # Definición REAL para ECM 1228062 / ALDL "A040"
                                      # (GMC Sonoma 1993 2.8L TBI), convertida a mano
                                      # desde un .ads de la comunidad. Ver comentarios
                                      # en el propio archivo para qué falta (flags de
                                      # 1 bit, PROM ID de 16 bits) y por qué.
```

## Cómo correrlo ahora (Fase 1, sin hardware)

1. Abre `src/index.html` directamente en el navegador (doble clic) — no necesita servidor.
   - Nota: por seguridad de los navegadores, `fetch` de archivos locales puede fallar;
     si pasa, corre un server simple: `python3 -m http.server 8080` dentro de `src/` y
     abre `http://localhost:8080`.
2. Carga un `.xdf` o `.adx` desde el botón "Cargar definición". Puedes probar con
   `defs/example.adx` incluido.
3. Verás la tabla parseada. La parte de "conectar" (WebSocket) mostrará
   "desconectado" hasta que tengas el ESP8266 corriendo el firmware — es normal.

## Cómo sigue (Fase 2, con tu ESP8266)

1. Abre `firmware/esp8266_aldl_bridge/esp8266_aldl_bridge.ino` en Arduino IDE / PlatformIO.
2. Ajusta `WIFI_SSID` / `WIFI_PASS` y el pin del nivel-shifter ALDL (ver comentarios).
3. Flashea al ESP8266. Al bootear, imprime su IP por Serial (115200 baud) y también
   la anuncia en la red local vía mDNS como `rtweb.local`.
4. En la web app, pon esa IP (o `rtweb.local`) en el campo de conexión y da "Conectar".
5. Los frames crudos que llegan por WebSocket se decodifican con la definición
   `.adx` cargada, y se grafican en vivo.

## Por qué no está publicado como Artifact de claude.ai

Un WebSocket hacia un dispositivo en tu red local (ej. `192.168.1.50`) está bloqueado
por la política de seguridad de las páginas publicadas en claude.ai. Por eso este
proyecto vive como archivos reales que tú hosteas: abriendo `index.html` local,
sirviéndolo desde un Raspberry Pi, o incluso que el propio ESP8266 lo sirva.

## Estado actual / próximos pasos honestos

- [x] Parser XDF/ADX (tablas 2D, metadata de PIDs)
- [x] UI de tabla editable básica
- [x] Cliente WebSocket + protocolo de mensajes JSON
- [x] Firmware base: bit-banging ALDL 160 baud + servidor WebSocket
- [x] Modo simulado (datos falsos oscilando) para probar la UI sin hardware
- [ ] Vista 3D de superficie (Three.js) — siguiente sesión
- [ ] Autodetección de protocolo (160/8192 baud) en el firmware
- [ ] Checksum / comparador de binarios
- [ ] Overlay del log en vivo sobre las tablas
- [ ] Calibración real con tu ECU (necesita hardware en mano)
