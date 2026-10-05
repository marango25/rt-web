# RT-Web — TunerPro RT propio, web-first

Editor de XDF/tablas + logging en tiempo real vía ESP8266 (WiFi) hablando ALDL (GM OBD1).

## Estructura

```
rt-web/
├── src/                          # Web app (vanilla JS, sin build step)
│   ├── index.html
│   ├── style.css
│   ├── xdf-parser.js             # Parser de XDF/ADX (XML de TunerPro 5 y el XDF de texto viejo)
│   ├── frame-check.js            # Marca frames ALDL corruptos (reglas validmin/spike/monotonic del .adx)
│   ├── ws-client.js              # Cliente WebSocket hacia el ESP8266 (modo WiFi)
│   ├── serial-client.js          # Lee los frames por USB con Web Serial (modo USB, sin WiFi)
│   ├── sim-source.js             # "Modo simulado": datos falsos realistas sin hardware
│   ├── db.js                     # Sesiones guardadas en IndexedDB (autoguardado)
│   ├── surface3d.js              # Vista 3D de tablas (Three.js, se carga con import() dinámico)
│   ├── main.js                   # UI: tablas, parámetros en vivo, replay, comparador de bins
│   └── vendor/                   # Three.js + OrbitControls vendorizados (sin CDN, MIT license)
├── firmware/
│   └── esp8266_aldl_bridge/
│       ├── esp8266_aldl_bridge.ino   # Firmware: ALDL 160/8192 baud (autodetectado) + WebSocket
│       └── secrets.h.example         # Copia a secrets.h con el AP_SSID/AP_PASS del ESP8266 (gitignored)
├── docs/
│   ├── electronica.md                # Conexión ESP8266 ↔ ALDL: esquema, materiales, verificaciones
│   ├── sensor-o2.md                  # Sensor O2 Bosch 13026: cableado y resultado en el Sonoma
│   └── img/                          # Diagramas: conexión ALDL NodeMCU y sensor Bosch 13026
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

## Conexión electrónica

El ESP8266 (NodeMCU) lee la línea de datos ALDL a través de un divisor de voltaje de
1 kΩ / 2.2 kΩ (la línea sale a ~5 V y el pin D2 no tolera más de 3.3 V) con un condensador de
4.7 nF en paralelo con la 2.2 kΩ contra el ruido del motor (recomendado). La resistencia de
10 kΩ entre los pines B y A del conector ALDL es opcional: la ECM 1228062 transmite igual sin
ella. Esquema, vista de protoboard,
lista de materiales y verificaciones en [docs/electronica.md](docs/electronica.md). **Léelo
antes de conectar nada al vehículo.**

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
4. Elige cómo conectar la web app (dos modos, ambos alimentan el mismo pipeline):
   - **Por WiFi:** desde tu celular/laptop conéctate a la red del ESP8266 como
     cualquier otra, pon su IP (`192.168.4.1` por defecto, o `rtweb.local` si te
     funciona el mDNS) en el campo de host y da "Conectar por WiFi". Ojo: tu
     computadora pierde su internet mientras esté en esa red.
   - **Por USB:** conecta el ESP8266 a la computadora con el cable y da
     "Conectar por USB" (te pide elegir el puerto serial). No usa WiFi, así que
     la computadora conserva su internet. Requiere Chrome/Edge y abrir la app
     desde `http://localhost` (Web Serial no existe en Safari/Firefox ni en
     `http://<ip>`). Si falla al abrir el puerto, cierra el Monitor Serie de Arduino.
     Si el enlace USB se cae a mitad de una captura (pasa: el chip USB-serial se reinicia con
     el ruido del motor), la app intenta reconectar sola; con un chip CH340 sin número de
     serie no siempre puede, y entonces muestra "Reconectar USB" (un clic).
5. Los frames crudos se decodifican con la definición `.adx` cargada, y se grafican
   en vivo. El firmware lee el ALDL de 160 baud por interrupción (comprobado en el camión: un
   frame cada ~1.19 s, sin perder ninguno). El modo de 8192 baud solo detecta actividad y no
   está validado contra una ECM real.

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
- [x] XDF real del 1228062: el `4E.xdf` de Robert Saar (máscara $4E, formato de texto viejo de
      TunerPro) abre en la app con tablas, constantes, banderas y checksum
- [x] Simulación sobre los logs de lo que ordena la ECM con un `.bin` (avance, EGR, ralentí
      objetivo), para comparar dos versiones de calibración cuadro por cuadro
- [x] Marca de frames corruptos (valores imposibles, saltos aislados, apagado de llave)

## Primer caso real

El sistema ya cumplió su propósito con el vehículo para el que se armó (GMC Sonoma 1993, 2.8L
TBI): sus registros ayudaron a **encontrar un problema**. Los síntomas eran un cabeceo al
encender el A/C y un bajón en el arranque en frío, y a simple vista no había nada que medir.
Los logs mostraron que:

- En ralentí caliente y sin A/C, el sensor O2 casi no se mueve (510 a 560 mV, unos 50 mV de
  variación) y la ECM está en lazo cerrado solo ~10 % del tiempo.
- En las sesiones largas, con el escape ya caliente, el sensor sí oscila (120 a 866 mV) y el
  lazo cerrado sube a 71–96 %.

Eso apuntaba a un sensor O2 de un solo hilo, sin calefactor, que se enfría en ralentí.

### Después de cambiar el sensor (2026-09-20)

Se instaló un sensor calefactado (Bosch 13026, 4 cables) y se repitieron las capturas: ralentí,
A/C y una vuelta de manejo (~550 frames válidos, sin ningún código de falla).

- **Confirmado:** con el motor caliente la ECM está en lazo cerrado ~100 % del tiempo (antes
  ~10 % en ralentí) y el O2 oscila de verdad (~90 a 800 mV en ralentí caliente, antes 510 a 560).
- **Hallazgo nuevo (resuelto después, ver "Tercer caso real"):** el BLM (corrección aprendida de combustible) se queda en
  ~151 y llega a 161, con el integrador centrado en 128. La ECM está estable, pero necesita
  entre +18 % y +26 % de combustible extra; el sensor viejo lo escondía en parte. Falta medir la
  presión de combustible y revisar el sellado del sensor y la junta del escape.
- **El cabeceo no se le atribuye al sensor.** Resultó ser otra cosa, y tuvo su propia
  investigación: ver "Segundo caso real" más abajo.
- **Aún sin medir:** el arranque en frío con el sensor nuevo, que era el síntoma original.

Ojo al comparar capturas: entre ellas también cambiaron el tiempo base y la limpieza de la IAC,
y el BLM se reinició. Además, con el firmware de entonces se captaba un frame cada ~3.6 s (hoy,
uno cada ~1.19 s), así que el CSV sirve para comparar distribuciones (percentiles), no para ver
fallas de encendido ni oscilaciones rápidas.

## Segundo caso real: el cabeceo con el A/C (2026-09-22)

El síntoma llevaba meses: con el A/C encendido, en ralentí y con el camión parado, el motor
daba tirones — y la aguja del velocímetro se movía sola. Suena a dos fallas distintas. Era una.

Lo primero fue arreglar la herramienta. El firmware estaba descartando **todos** los frames:
el ECM 1228062 manda un SYNC de **diez** bits en 1 y el código enganchaba a los nueve, así que
el bit sobrante corría el mensaje entero un bit (`02 27` se leía como `01 13`) y la validación
por PROM ID lo botaba. Que antes funcionara a ratos era suerte, según dónde empezara a buscar —
de ahí el 28 % de captura de los logs viejos. Corregido: 100 % de aceptación, cero descartes.

Con datos confiables, la causa salió de experimentos de encender y apagar, no de deducción:

| Prueba | Muestras con velocidad falsa | Desviación de RPM |
|---|---|---|
| VSS conectado | 37 % | 41.0 |
| VSS desconectado | **0 %** | 16.7 |
| VSS reconectado | 36 % | 53.7 |
| Con el clutch pisado | 3 de 95 (y las 3 al soltar/pisar) | — |
| Llave en ON, motor apagado | **0 de 59** | — |
| Con la resistencia instalada | **0 de 318** | 15.8–18.3 |

La cadena completa: el ralentí áspero (más áspero con la carga del A/C) produce pulsación
torsional → los engranajes de la transmisión traquetean en neutro (normal en una manual, lo
confirmó el mecánico) → ese traqueteo sacude el rotor frente al sensor de velocidad → el sensor
es de reluctancia variable, o sea que genera voltaje con el *movimiento*, no con la velocidad,
así que suelta un pulso con el camión parado → el DRAC lo cuenta: la aguja se mueve y la ECM
cree que el camión anda, cambia su estrategia de ralentí y abre la IAC unos 8 pasos → tirón.
El A/C cierra el círculo porque es lo que pone áspero el ralentí.

Por el camino quedaron **descartados con medición, no con opinión**: el embrague del compresor
(el síntoma sigue con él desconectado), el ventilador, las luces y el arnés (con llave en ON y
motor apagado no pasa nunca), el conector del VSS (limpiado), el sensor mismo (nuevo, apretado,
1437 Ω), el alternador (rizo de AC por debajo de 0.1 V) y las tierras de la transmisión.

**El arreglo:** una resistencia de 1.5 kΩ en paralelo con los dos cables del VSS, en el conector
de la transmisión, con dos conectores de mordida y sin cortar ningún cable del vehículo. Divide
la señal a la mitad: el ruido del traqueteo ya no alcanza el umbral del DRAC, pero el pulso real
de rodar sí. No afecta la exactitud del velocímetro, porque el DRAC cuenta pulsos, no amplitud —
lo único que sube es la velocidad mínima detectable, de unos 2 a unos 4 MPH.

En resumen: no se cambió ninguna pieza. Se le bajó la ganancia a un sensor demasiado sensible.

## Tercer caso real: la mezcla pobre y la detonación (2026-09-28)

Desde que se cambió el sensor O2 quedó a la vista que el motor iba pobre: la ECM tenía que
agregar entre +23 % y +28 % de combustible en crucero (BLM 158–164) y el contador de
detonación subía con carga, sobre todo en caliente. Antes de tocar nada se descartó lo que se
podía medir: fugas de vacío (17–17.8 inHg estables), sensores, la bomba (1.5 L en 10 s) y la
presión del TBI (12–14 psi con llave en ON, en ralentí y con el A/C puesto).

La prueba fue cambiar una sola cosa: los inyectores que traía (GP Sorensen) por un par GM
5235203, que da ~36 % más caudal. Se borró la corrección aprendida desconectando la batería y
se repitió la misma ruta:

| | Antes | Con los 203, tiempo 0° | Con los 203, tiempo 10° |
|---|---|---|---|
| Corrección de crucero (BLM) | 158 (+23 %) | 123 (−4 %) | 119 (−7 %) |
| Detonación por lectura con carga fuerte | 1.8–3.2 | 0.46 | 0.55 |

La cuenta cuadra: el motor pide lo mismo de siempre y ahora el inyector se lo da. Ojo, eso no
demuestra que los inyectores viejos fallaran: el resultado sería el mismo si el motor pidiera
más combustible por otra razón. Los 203 son la solución, no la autopsia. La detonación que
queda aparece casi solo en 5.ª a menos de ~1900 RPM y casi a fondo; bajando a 4.ª desaparece.

También se probó el tiempo base en 0°, 5° y 10°. La detonación salió igual a 0° que a 10°. El
ralentí con el A/C parecía empeorar con más avance, pero no: sin A/C el motor consume el mismo
aire con cualquier tiempo, y la diferencia con A/C era cuánto estaba jalando el compresor en
cada captura. Ese cabeceo con el A/C parado viene de la calibración de la ECM (el ralentí
objetivo con A/C es bajo y la IAC no se adelanta a la carga) y solo se arregla reprogramando
el chip. Queda un "pop" en ralentí que aparece con el avance alto y no con el tiempo base en 0°.

## Licencia

Copyright (C) 2026 Miguel Arango

GPLv3 — ver [LICENSE](LICENSE). En corto: puedes usar, copiar, modificar y distribuir este
proyecto libremente, pero cualquier versión modificada que distribuyas debe seguir siendo
código abierto bajo la misma licencia.

Three.js y OrbitControls (`src/vendor/`) son de terceros, licencia MIT — sus avisos de
copyright quedan intactos en los propios archivos vendorizados.
