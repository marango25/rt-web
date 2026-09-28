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
  Probado con un `navigator.serial` falso + frames reales de `sin_iac.csv`, y ya
  **confirmado contra el ESP8266 real** (toda la sesión de diagnóstico del 2026-09-22
  corrió por USB). Reconecta solo si se cae el enlace USB (el chip USB-serial se
  reinicia con el ruido del motor, o hay un brownout por el hub); el fallo del PRIMER
  intento tras el clic NO se reintenta en silencio, muestra el motivo real (casi
  siempre el Monitor Serie de Arduino con el puerto abierto).
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
`defs/gmc_sonoma_1993_a040.adx` (completa desde el 2026-09-22: incluye las
15 banderas de 1 bit y el PROM ID de 16 bits). Falta cablear el naranja al nivel-shifter
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
- **10 kΩ entre el pin B (diagnóstico) y el pin A:** el diagrama del usuario dice que es lo
  que hace que la ECM transmita el flujo de datos. **Falso: el flujo sale igual sin ella.** Pero
  ojo, la razón NO es que la ECM ignore la resistencia — eso estaba mal escrito aquí hasta el
  2026-09-23. La ECM **sí la ve**, y el bit "Diagnostic switch in 10K mode" (byte 0, bit 5) lo
  demuestra. Revisado sobre los 29 logs:
  **vale 1 en el 100 % de los frames del 2026-09-16T19-56 al 2026-09-21T14-25, y 0 en el 100 %
  de los frames del 2026-09-22T04-06 en adelante.** No es un artefacto del firmware viejo: el
  PROM ID (0x0227 en bytes 1–2) valida al 100 % en las dos épocas, así que el alineamiento era
  correcto en ambas, y el resto del byte 0 (bit 2 = pulso de referencia) se comporta igual.
  Conclusión: **entre el 21 y el 22 de septiembre la 10 kΩ dejó de hacer contacto** (se soltó, se
  quitó, o falló el pin B), y desde entonces se está logueando sin ella y la ECM transmite lo
  mismo. Aprovecha cualquier visita al conector ALDL para revisarla. **Y úsalo como herramienta:
  ese bit es la forma de comprobar en vivo en qué modo está el ALDL.** El ESP8266 **no** se
  conecta al pin B (ECM A9, blanco/negro); ahí solo va la resistencia. En el ECM, el dato es A8
  (naranja).
- **Alimentación:** micro-USB desde un cargador de encendedor 12 V → 5 V (o el USB
  de la computadora en modo USB).
- **Sin camino de transmisión hacia la ECM.** Cualquier cosa que exija enviarle
  peticiones (p. ej. Mode 1 a 8192 baud) necesita hardware nuevo que no existe todavía.
- **Diagramas:** `docs/img/esquema-aldl.svg` y `docs/img/protoboard-aldl.svg`, extraídos
  del "Diagrama ALDL NodeMCU" del usuario (versión con condensador, 2026-09-19); el
  detalle y el montaje están en `docs/electronica.md`.
- **El condensador de 4.7 nF NO está instalado** (confirmado por el usuario el 2026-09-28):
  todos los logs hasta esa fecha son sin él, y es candidato a explicar los frames corruptos.
  **Sin confirmar:** voltaje medido en D2 con el motor en marcha, y si el cable trenzado y la
  tierra corta están instalados. No los des por hechos.

## Resultado real (2026-09-19; actualizado 2026-09-28)

El sistema ya cumplió su propósito tres veces: los registros del Sonoma ayudaron a encontrar
dos problemas que no se veían a simple vista.

**Caso 1 — sensor O2 (resuelto).** Con el original (1 hilo, sin calefactor) la ECM estaba
en lazo cerrado solo ~10 % del tiempo en ralentí caliente (O2 510–560 mV). El 2026-09-20 se
instaló un Bosch 13026 calefactado (4 cables) y los datos lo **confirman**: lazo cerrado
~100 %, O2 ~90–800 mV en ralentí caliente, ningún código (~550 frames).

**Caso 2 — el cabeceo con A/C (resuelto el 2026-09-22).** La causa NO era eléctrica del
A/C ni el sensor O2: era un **pulso de velocidad falso del VSS**. Cadena completa, cada
eslabón comprobado con un experimento de encender/apagar, no por deducción:

1. El ralentí áspero (más áspero con la carga del A/C) genera pulsación torsional.
2. Esa pulsación hace traquetear los engranajes de la transmisión en neutro (normal en
   manual; lo confirmó el mecánico del usuario).
3. El traqueteo sacude el rotor frente al VSS, que es de reluctancia variable y genera
   voltaje con el movimiento, no con la velocidad → pulso falso con el camión parado.
4. El DRAC cuenta ese pulso: la aguja del velocímetro se mueve sola y la ECM cree que el
   camión anda → cambia de estrategia de ralentí, abre la IAC ~8 pasos → tirón de RPM.

Evidencia clave: A-B-A con el VSS desconectado (37 % de muestras con VSS≠0 / σRPM 41 →
**0 %** / σ 16.7 → 36 % / σ 54); pisar el clutch lo mata (3/95 vs 8/21 con el clutch
suelto); con llave en ON y motor apagado, **0 de 59** (descarta todo acoplamiento
eléctrico del A/C, ventilador, luces y arnés); el compresor desconectado no lo quita.
Descartados con medición: compresor, ventilador/luces, arnés, conector del VSS (limpiado),
el propio sensor (nuevo, apretado, 1437 Ω), alternador (rizo AC < 0.1 V) y las tierras.

**Arreglo instalado y verificado:** una resistencia de **1.5 kΩ en paralelo** con los dos
cables del VSS en el conector de la transmisión (con dos conectores de mordida, sin cortar
cable del vehículo). Divide la señal a ~51 %: el ruido del traqueteo ya no llega al umbral
del DRAC, pero el pulso real de rodar sí. Log de verificación: **0 pulsos falsos en 318
muestras**, σRPM 15.8–18.3 en ralentí con A/C (igual que con el sensor desconectado), con
velocímetro funcionando y sin código 24. Trampa al armarla: son DOS cables separados unidos
solo por la resistencia; si se suelda a dos puntos del mismo cable, queda en corto y mide
0.000. **Confirmado en carretera el 2026-09-23** (log `T23-53-57`): el VSS siguió todo el
recorrido hasta 35 MPH con rampa limpia, y parado quedó **1 muestra de 72 con VSS=1** en un
ralentí largo. El arreglo aguanta. **Falta solo** contrastar contra GPS a velocidad de crucero
(la señal va dividida a ~51 %, así que el velocímetro podría leer corto).

**Caso 3 — mezcla pobre y detonación (resuelto el 2026-09-28).** Antes de esto ya se había
medido lo físico: presión del TBI **12–14 psi** en llave ON, ralentí y con A/C (log
`2026-09-27T15-06-19`), bomba 1.5 L en 10 s, sin goteo del TBI. En el camión iban unos
inyectores GP Sorensen 800-1806N (puestos ~mayo 2026, antes de todos los logs). Se cambiaron por
un par GM **5235203** (del 4.3L, ~45 lb/h; el original del 2.8 es el **5235130**, ~33 lb/h), se
desconectó la batería para dejar el BLM en 128 y se repitió la misma ruta. Filtro de siempre:
lazo cerrado + BLM habilitado + ≥80 °C + rodando.

| | antes (GP, 0°) `T18-10-01` | 203 a 0° `2026-09-28T00-55-59` | 203 a 10° `2026-09-28T01-30-21` |
|---|---|---|---|
| BLM crucero (MAP<1.6 V) | 158 | **123** | **119** |
| BLM carga (MAP>2.6 V) | 152 | 115 | 112 |
| detonación por frame (MAP≥3.3, ≥85 °C) | 1.8 (3.2 en `T20-07-45`) | **0.46** | **0.55** |
| IAC ralentí caliente sin A/C | — | 9 | 13–14 |

Lectura: 128 × 1.28 / 1.36 ≈ 120, o sea el motor pide lo mismo de siempre y el 203 se lo da.
**Eso NO prueba que los GP dieran poco caudal:** no distingue "inyectores cortos" de "el motor
pide ~25 % más por otra razón". El 203 es la contramedida, no la autopsia. Sin códigos 44/45.
**La baja de detonación no es por la gasolina:** la premium entró a las 19:35 del 2026-09-27 (evento
"ya con premium" en `T20-07-45`), así que ese log de los GP ya va casi entero con premium y es el
que da **3.2** por frame (p. ej. contador 25→141 entre 19:49:34 y 19:50:55, en 5.ª a 50–56 MPH,
MAP 3.4–3.8 V). `T18-10-01` (1.8) sería con la regular. Los logs de los 203 van con premium.
El aditivo entró junto con la premium (confirmado por el usuario): todo lo marcado "premium" lleva
aditivo, así que tampoco explica la diferencia GP→203.
**¿Chip modificado? (2026-09-28, sin confirmar).** Si el problema fuera solo "los GP daban poco" con
una PROM de fábrica para el 5235130, los 203 (~36 % más caudal) habrían dejado el BLM en ~94, no en
119–123. Que quede en ~120 dice que **motor + PROM piden ~25 % más que un 2.8 de fábrica**: PROM
calibrada para inyectores más grandes o más pobre (modificada o de otra aplicación), un motor con
más VE, o que los caudales nominales (~33 / ~45 lb/h) estén mal. Depende de esos dos números. Se
decide con la etiqueta del chip y el `.bin` contra el de fábrica (proyecto PROM), no con ALDL.
La detonación que queda sale casi toda en **5.ª ahorcado** (1650–1850 RPM, MAP 3.7–3.9 V,
50–56 MPH): la regla es bajar a 4.ª. Al leer estos logs, ignora los frames corruptos del
puente (BLM 0 o 240, VSS 211, saltos del contador de detonación en esos mismos frames).
**Desde el 2026-09-28 la app los marca sola** (`src/frame-check.js` + atributos `validmin`/`validmax`/
`spike`/`monotonic` del `.adx`): columna `sospechoso` en el CSV, no tocan las tarjetas en vivo y el
replay los excluye (a un CSV viejo se le calculan si el `.adx` está cargado ANTES de abrirlo). Sobre
12,475 frames del 22 al 28 marca 85 (0.68 %): 79 de apagado de llave (batería 0 V) y 6 de bit
perdido, y ningún frame bueno. Huella del bit perdido: el valor sale ×2 (detonación 24→48→24).
En tus propios scripts: filtra por `sospechoso` vacío.

**Tiempo base con los 203: se probaron 0°, 5° y 10°.** La detonación sale igual a 0° que a 10°.
El ralentí con el compresor enganchado da σRPM 20–23 (0°), 38–42 (5°) y 49 (10°), **pero no es
el tiempo:** sin A/C el MAP de ralentí es el mismo en los tres (1.24–1.25 V) y con A/C cambia
1.80 contra 2.05 V, es decir, lo que varió fue **cuánto jalaba el compresor** en cada tramo. Yo
había dicho que el cabeceo con A/C era por los 10° y el log de 5° lo desmintió. **Quedó en 5°
el 2026-09-28** (sin log manejando a 5°: la detonación ahí no está medida, aunque 0° y 10° dan
igual). **Regresado a 10° (spec) el 2026-09-28 ~15:00** (log `2026-09-28T15-10-27`, ya con
gasolina premium, todo parado): tramo 14:54–14:58 = 5°; 15:00–15:03 = calibrando con el SET TIMING
suelto (no comparable, IAC 15–17); 15:06 en adelante = 10° normal. Ralentí caliente sin A/C: IAC
12–13 (5°) → 9–12 (10°), MAP 1.31 → 1.29 V, mismo RPM; ojo que el TPS cerrado pasó de 0.47 a
0.51 V entre el tramo de calibración y el de 10° (algo movió la mariposa). La prueba con carga a
10° ya existe: es `2026-09-28T01-30-21` (203 a 10°, **ya con premium y aditivo**), y es la misma
configuración de hoy. No hace falta otro log manejando.

**Pista fuerte para el pop (log `2026-09-28T22-06-00`, sin confirmar):** a los 75 °C la ECM pasa
el ralentí a **lazo abierto** (spec de fábrica) y **en el mismo segundo manda el aire del AIR a los
puertos de escape** (byte 16 bit 0: 0→1; en lazo cerrado va desviado al filtro, como dice el manual
8-2). Desde ahí el ralentí va rico (O2 ~830-850 mV) con aire fresco entrando al múltiple: receta de
postcombustión. El usuario notó que el pop **desaparece con el compresor enganchado y vuelve al
soltarse** (A/C en la velocidad baja, ciclando cada ~6-7 s): suelto = 1000 RPM, MAP 1.14 V (más
vacío); enganchado = 850 RPM, MAP 1.67 V. Los bits del AIR son iguales en los dos estados, así que
el dato no explica esa parte.
**CORRECCIÓN (el usuario, 2026-09-28): el solenoide del AIR YA ESTÁ DESCONECTADO, y también la
manguera de vacío que va al múltiple.** O sea que el bit del byte 16 es solo lo que la ECM ORDENA, no
lo que pasa: sin solenoide ni vacío, según el manual (8-2: solenoide energizado = aire al escape) el
aire debería irse siempre al filtro. La hipótesis de la postcombustión pierde fuerza (no está muerta:
no verifiqué cómo queda la válvula del 2.8 sin vacío). Lo que queda por revisar, en orden:
(1) **¿el puerto del múltiple donde iba esa manguera está tapado?** Si está abierto es una fuga de
vacío; encajaría con que el pop se vaya con el compresor (más carga, menos peso relativo de la fuga),
aunque el log no muestra caídas pobres del O2 en ralentí caliente (730-890 mV) y el vacuómetro dio
17-17.8 inHg. (2) **Tubos y válvulas check del AIR:** sin flujo de aire, una check que fuga o un tubo
roto al múltiple deja salir escape = soplido/pop rítmico en ralentí; escuchar ahí. (3) ¿La banda de la
bomba AIR está puesta?
**Resuelto el mismo día: el AIR NO es.** Puerto de vacío tapado; bomba con banda, girando y soplando
suelta; probó extender/tapar el lado del escape y el pop no cambió. El pop se oye en el **mofle** y
se **siente en el motor** como un fallito.
**Lo que sí muestra el log `2026-09-28T22-49-18` (ralentí caliente 85 °C, sin A/C, lazo abierto, 6
min):** 22 caídas a ≤750 RPM (hasta 675) en 5.9 min, **y en cada caída el MAP sube** (mediana 1.36 V
en las caídas contra 1.27 V el resto; correlación RPM-MAP −0.62) con la IAC quieta. Esa es la huella
de una combustión que falla o se queda corta: el motor pierde un golpe, baja la RPM y entra menos
vacío. Casa con "pop en el mofle + fallito en el motor". El MAP de ralentí (mediana 1.29 V) está
arriba del **1.0 V** de la tabla de fábrica (3B-87) y el vacuómetro dio 17-17.8 inHg: vacío algo bajo
de forma crónica. Que se quite con el compresor (más carga) apunta más a una combustión diluida o
pobre que a una chispa débil, que fallaría MÁS con carga; pero la dependencia del avance (0° sin pop)
no encaja limpio con nada. **El EGR NO puede ser: está CANCELADO (bloqueado) desde la admisión**
(dato del usuario, 2026-09-28; no estaba anotado y llegué a proponerlo). Siguiente, gratis: el
**vacuómetro en ralentí mirando la AGUJA, no la cifra** (caída regular y rítmica = válvula que no
sella, típico del "puff" rítmico en el escape; caídas irregulares = encendido), luego encendido
(bujías, cables, tapa/rotor) y **prueba de compresión** (seca y húmeda).
**BLM de ralentí 116** en ese mismo log (aprendido a 48-53 °C con el A/C ciclando): abajo del 118 del
spec y cerca del ~115 que el manual asocia al código 45 (rico). Un solo log y en frío: vigilarlo.

**Pop leve y rítmico, solo en ralentí** (andando y acelerando, nada). Según el usuario: GP a 10°
más fuerte, 203 a 10° y a 5° leve, **a 0° nunca**. Depende del avance, así que no es una válvula
que no sella (eso saldría con cualquier tiempo); el mecanismo no está medido y el CSV (1 frame
cada ~2.4 s) no lo ve. Inofensivo. Pendiente la prueba de la hoja en el escape.

**Cabeceo y caídas con A/C parado: es calibración, no falla.** El objetivo de ralentí con A/C es
~825 RPM (sin A/C ~800) y la IAC no se anticipa al compresor: al llegar a un alto cae a 550–700
y se recupera. Solo se arregla en la **PROM** (RPM objetivo con A/C, apertura de la IAC al
enganchar). **No** con el tornillo de aire mínimo (la ECM lo compensa y sin A/C se dispara) ni
engañando al sensor de temperatura (cambia combustible y avance en todo el rango).

**Spec de ralentí de fábrica (confirmado el 2026-09-28 en el manual del usuario,
`~/Downloads/1993_ST-336-93_..._FUEL_AND_EMISSIONS_MANUAL.pdf`, pág. 4-4 = página 635 del PDF,
tabla "1993 CONTROLLED IDLE SPEED"):** 2.8L S-truck manual en neutral, motor caliente, sin A/C =
**800 RPM, IAC 5–20 counts, OPEN LOOP** (+1 count por cada 1000 ft de altitud). El camión da
~800 RPM con IAC 9–13 → **dentro de spec**. Y **el lazo abierto en ralentí es de fábrica**, no una
falla: eso cierra la duda de los bullets de "Lazo en ralentí" y explica el O2 fijo en ~850 mV
parado. El manual dice que el tornillo de mínimo "no se debe ajustar"; la tabla de MINIMUM IDLE
SPEED solo trae el 7.4L. El "650–750 RPM" que da el resumen de IA de Google es falso para este motor.

**Todo lo útil del manual ST-336-93 está resumido en `docs/manual-1993.md`** (2026-09-28): specs,
tabla de datos típicos del escáner, pruebas pendientes paso a paso y pines del ECM. Lo que cambia
cómo leer los logs o qué revisar:
- **Rangos de fábrica (3B-8):** INT 110–145, BLM 118–138, refrigerante 85–105 °C. Ya están como
  `warnmin`/`warnmax` en el `.adx` (antes eran 100–150 inventados). Son de ralentí: con carga el BLM
  (112–115) sale en rojo y es normal. BLM ≈150 = condición del código 44.
- **Auto-prueba de detonación (7-4):** con refrigerante >95 °C y carga cerca de WOT, la ECM
  **adelanta la chispa a propósito** una vez por encendido para probar el sensor. Al contar
  detonación, separa los frames de ≥95 °C. Además solo retarda arriba de 900 RPM, máx. 20°.
- **EGR sin revisar, y el manual lo liga a la detonación:** "pasajes tapados → detonación severa al
  acelerar". Prueba gratis: en ralentí caliente levantar el diafragma, el ralentí debe empeorar. El
  código 32 nunca salió (se vigila arriba de 45 MPH), así que tapón total poco probable; parcial no.
- **Thermac sin revisar:** compuerta de aire caliente del filtro; cerrada en caliente = aire caliente.
- **Validar el contador de detonación:** golpear el bloque a 1500 RPM con la app en vivo; debe subir.
- **AIR en ralentí:** en el S va a los puertos de escape en ralentí; la check valve del AIR está en
  la lista de "backfire" del manual. En el próximo log, mirar los bits del AIR cuando suene el pop.
- **A/C (3B-34):** la ECM suelta el embrague si el ralentí cae demasiado; mirar en el próximo log si
  lo hace en las caídas a 550–700.

Lo que sigue abierto (no lo des por resuelto; se trata aparte del desarrollo):

- **RESUELTO el 2026-09-28 con los inyectores 203 (ver Caso 3); lo que sigue es historial.**
  **Mezcla pobre: BLM 130–152 en TODAS las bandas de carga** (+2 a +19 %) con INT en 128–131.
  Ya descartado con datos: **fuga de vacío** (17.0–17.8 inHg estables en ralentí caliente,
  8 logs; el usuario además roció limpiador por todos lados sin efecto), sensores (TPS, MAP,
  temperatura, O2, alternador) y códigos. **Único sospechoso que queda: la entrega física de
  combustible.** Siguiente: **medir presión del TBI (~9–13 psi, y que aguante con el A/C
  puesto y acelerando)**; si está baja, filtro/regulador/bomba. **El usuario lo dejó de lado
  a propósito el 2026-09-22** para cerrar primero el cabeceo; no lo reabras sin que él lo pida.
  **Evidencia nueva y fuerte (2026-09-23), la más directa hasta ahora:** con el **embrague del
  compresor enganchado** la mezcla se va pobre y se queda ahí — O2 p5/p50/p95 = 13/**31**/173 mV
  (89 % bajo 100 mV, n=201) contra 80/**404**/777 mV con el compresor suelto (9 %, n=143), mismo
  motor, ≥82 °C, ralentí, con minutos de diferencia. No es el sensor: revive en cuanto el
  compresor se suelta. El MAP sube de 1.16 a 1.95 V con la carga y el combustible no acompaña.
  Además la ECM está en **lazo abierto el 100 % del tiempo con A/C**, así que no corrige nada
  (eso **cambió** la noche del 2026-09-23: ahora cierra el lazo en ralentí, ver el bullet del
  lazo; la mezcla pobre no se arregló, solo pasó a estar tapada por la corrección).
  **Reconfirmado dos veces más el 2026-09-23** en los logs `T19-27-18` y `T19-34-26`, filtrando por
  el bit del embrague (byte 16 bit 2): con el clutch enganchado, O2 p50 = **22 mV** (100 % bajo
  100 mV, n=83) y **49 mV** (82 %, n=119); con el clutch suelto, p50 324 y 586 mV. Y el bit de lazo
  cerrado vale **0 % con el clutch enganchado en los dos**. Truco para no equivocarse: filtra
  SIEMPRE por el bit del embrague, no por el marcador "A/C" del evento — pedir A/C no es el mismo
  estado que el compresor arrastrando, y mezclar las dos poblaciones hace parecer que el O2
  "oscila sano hasta 900 mV" cuando esos picos son todos del compresor suelto.
  **Tercera confirmación, la más fuerte, en el log `T23-22-24` del 2026-09-23** (un recorrido con
  carga real, el primero): el motor **se ahogó y se apagó solo** al poner el A/C recién arrancado
  (bullet siguiente), y el segundo intento sobrevivió **solo porque pudo corregir**, gastando
  **INT 128→145 y BLM 128→149 en 40 s** (+16 %, casi todo su rango) en cuanto enganchó el
  compresor. Cuando a este motor le quitas la corrección de combustible y le metes carga, no
  aguanta. En ese mismo log el BLM está **≥140 en el 63 % de los frames (máx 151)** en todas las
  bandas: crucero (MAP<1.6 V) 138, media 143, acelerando (MAP>2.6 V) 139.
  **Cuarta captura (log `T23-53-57` del 2026-09-23, 576 s, recorrido corto con A/C), y aquí
  aparece la FORMA del problema, que cambia cómo hay que medir:** filtrando solo los frames que de
  verdad están aprendiendo (lazo cerrado **y** BLM habilitado, ≥80 °C, n=94) el BLM subió otra vez
  — **mediana 147, máx 156, ≥140 en el 72 %, ≥150 en el 20 %** (anoche: 143 / 151 / 63 %), parejo
  en todas las bandas (crucero 147, media 148, carga 142). Pero **en ralentí caliente el motor está
  RICO, no pobre**: en lazo abierto, n=86, O2 p5/p50/p95 = **693/852/888 mV, 0 % bajo 100 mV, 94 %
  por encima de 700**, con el compresor enganchado igual (p50 826 mV). O sea **pobre rodando y con
  carga, rico parado**. Consecuencia práctica: **una lectura del manómetro en ralentí puede salir
  perfecta y no significar nada.** Hay que medir las tres: (1) llave en ON sin arrancar — debe
  llegar a ~9–13 psi y **quedarse ahí**, si se cae es inyector/regulador/válvula de retención que
  fuga; (2) en ralentí; (3) **con el compresor enganchado y acelerando**, que es donde el BLM se va
  a 147–156. La hipótesis que explica rico-en-ralentí y pobre-con-carga a la vez es **un inyector
  TBI que gotea y a la vez no da caudal**: mira el patrón de rociado con la tapa del filtro quitada
  (debe ser un cono fino, no un chorro ni goteo) — es gratis y se hace en la misma sesión.
  **CONFIRMACIÓN LIMPIA, DESDE CERO (log `2026-09-24T01-23-42`, la evidencia más fuerte que hay).**
  El procedimiento de aire mínimo borró el BLM (ver el bullet del código 42), así que quedó en 128
  sin nada aprendido. El usuario manejó ~45 min y **la ECM se volvió a ganar la corrección hoy
  mismo**, con el tiempo en 10° y el tornillo recién ajustado: sobre 377 frames aprendiendo (lazo
  cerrado + BLM habilitado), **BLM mediana 141, p90 153, MÁXIMO 159, y ≥150 en el 29 %**. Es el
  valor más alto de todo el proyecto (antes: máx 156). Curva: 129 → 134 → 140 al minuto 2, y 144–146
  al minuto 6–8. **Ya nadie puede decir que el 146–156 era un valor viejo arrastrado: lo aprendió
  de nuevo, desde 128, en menos de 10 minutos.** El motor pide +11 % a +24 % de combustible extra
  para llegar a estequiometría. Esto ya no necesita más confirmación por ALDL — necesita un
  manómetro.
- **Se ahogó y se apagó solo al poner el A/C recién arrancado (2026-09-23, log `T23-22-24`).**
  A-B regalado: dos arranques a 49 °C con el A/C pedido, 30 s de diferencia, uno murió y el otro
  no. **Intento 1 (murió):** arrancó en lazo ABIERTO con el BLM deshabilitado y **"Open Loop
  Idle" = SÍ** (byte 14 bit 0), o sea el IAC siguiendo una tabla por temperatura y **no** el error
  de RPM. El compresor enganchó a los 12 s, con el ralentí rápido en plena bajada (1075 RPM), y el
  **IAC siguió cerrándose mientras el motor se moría: 81 → 73 → 69 pasos**; RPM 1075 → 925 → 800
  → 0 y MAP 1.84 → 2.00 → 2.55 V (el vacío cayéndose). Cerró el lazo en el último frame vivo, ya
  tarde. **Intento 2 (sobrevivió):** arrancó **ya en lazo cerrado**, con BLM habilitado y Open
  Loop Idle en no (el O2 calefactado seguía caliente del intento anterior); el compresor enganchó
  a 1450 RPM y el ralentí se agarró en 925, pero gastando INT 128→145 y BLM 128→149 en 40 s.
  Lectura: no es aire, ni ralentí, ni los 10° de tiempo — es la mezcla pobre atrapada en la peor
  ventana (los ~12 s tras arrancar en tibio, ya sin enriquecimiento de arranque y todavía sin lazo
  cerrado). Falta el frame del instante exacto de la muerte (hueco de 3.1 s contra 2.38 s
  normales).
  **Corrección del 2026-09-23 (log `T23-53-57`): los "12–13 s" NO son una demora fija de la ECM.**
  En ese log el compresor enganchó a **+35.7 s** del arranque. La demora depende de cuándo se pide
  el A/C, no de un temporizador. Lo que sí se repite es la condición: ese arranque fue también
  tibio (68.6 °C) con A/C, **no se apagó**, y arrancó **ya en lazo cerrado con BLM habilitado**,
  subiendo BLM 133→144 en el primer minuto. Tercera vez que se cumple la misma regla:
  **sobrevive el arranque que puede corregir.** El truco de esperar ~20 s antes de poner el A/C
  sigue sirviendo para esquivarlo (esquivarlo, no arreglarlo).
- **TRES paros seguidos el 2026-09-24 (log `T01-23-42`, 01:14:02 / 01:14:29 / 01:14:57) — causa
  CONFIRMADA: falso contacto en el conector del compresor.** El usuario lo sospechó y se paró a
  conectarlo; los datos le dan la razón, y **no fue ni el tornillo de aire mínimo ni el tiempo**.
  Prueba: el bit de **petición de A/C (byte 16 bit 7, activo en bajo) va y viene solo** en ese
  minuto — byte 16 alterna 0x02 (pedido) → 0x82/0x83 (no pedido) → 0x07 (pedido) sin que nadie
  toque el control. Y **dos de los tres paros ocurren en el frame exacto en que se engancha el
  embrague** (bit 2): a las 01:14:26 venía a 1200 RPM con la IAC en 38, engancha y muere al frame
  siguiente; a las 01:14:55 venía bajando normal a 775 RPM con IAC 14, engancha y muere. El
  tercero (01:14:02) es el clásico: frena y se para con el compresor ya enganchado, la ECM cierra
  la IAC **66 → 51 → 45 → 39 → 33 → 27 → 21** mientras el RPM cae 1675 → 1000, y no la alcanza.
  Lección para leer logs: si hay paros con A/C, **mira primero si el bit de petición está
  parpadeando** antes de culpar al ralentí.
  **Corrección del usuario (2026-09-23): uno de los tres NO fue un paro, fue él apagando para
  cargar gasolina.** No dijo cuál; el candidato es el de 01:14:02 (el único que no coincide con
  un enganche del embrague). Quedan **dos** paros reales, los dos en el frame del enganche.
- **La IAC "clavada" en 74–76 con el A/C puesto es normal**, no una falla: con A/C pedido la ECM
  mantiene una posición mínima de IAC fija, sin importar el RPM (se ve a 1300 y a 2250 RPM igual).
  El usuario lo notó y su explicación era la correcta.
- **Enfriamiento — BAJADO a vigilancia el 2026-09-23 (ya no es un frente):** sube a 94–96 °C **solo parado con A/C**
  (+0.34 a +1.24 °C/min); sin A/C queda plana en 85–91 y no se dispara. El enfriamiento es fan
  clutch mecánico + 2 pushers auxiliares de 10" adelante (ya confirmado que soplan hacia el
  motor). **La ECM no manda ventiladores en este ECM:** ningún bit de los 160 cambia sobre
  92 °C, o sea que esta parte no se ve en los datos. Orden acordado, de gratis a caro: tapar el
  pedazo de shroud que falta abajo, limpiar la basura entre condensador y radiador, corregir el
  tiempo base (siguiente punto), y hasta el final el fan clutch. El test de mano del clutch solo
  cuenta si apagas **parado en ralentí a 94–96 °C** (llegando rodando ya se soltó).
  **Por qué bajó de prioridad:** el termostato es de 195 °F (90.5 °C) y el dato nunca mostró fuga
  térmica — **se topa** en 94–96 y se queda ahí, parado, con A/C, en clima caliente. Eso está dentro
  de lo normal para esta camioneta. El usuario decidió el 2026-09-23 no hacer el shroud ni la limpieza
  por ahora, y tiene razón: no urge. **No se lo vuelvas a proponer sin que él lo pida.** Siguen siendo
  buena idea algún día (son gratis y sí ayudan en ralentí), no una reparación pendiente.
  **Vuelve a ser un problema solo si:** pasa de ~105 °C y sigue subiendo sin toparse, la aguja llega al
  rojo, pierde refrigerante o lo empuja al depósito, o aparece detonación por calor bajo carga.
- **Tiempo base 10° ATRASADO (hallazgo del 2026-09-23).** El *93 Truck Fuel & Emissions
  Service Manual* (tabla "Timing Specifications", que el propio manual dice usar cuando no está
  la etiqueta VECI — y no está) da para el **2.8L en plataforma S: 10° BTDC a ≤600 RPM**. El
  camión trae **0°** desde el 2026-09-20; el 0° es el spec del 4.3L. Bypass en el V6 =
  desconectar el **conector SET TIMING** (un hilo, canela con raya negra, bajo la caja de
  calefacción del lado del pasajero); el puente A-B es bypass **solo para el 2.5L**.
  **HECHO el 2026-09-23: el usuario lo ajustó a 10° y reconectó el conector. Ya no está abierto.**
  Medido en los logs `T19-27-18` y `T19-34-26` (ralentí caliente, sin A/C, mismo día):

  | estado | RPM | IAC | MAP |
  |---|---|---|---|
  | conector ON, base 0° | 803 | 8.1 | 1.206 V |
  | conector OFF, base 0° | 821 | 11.9 | 1.229 V |
  | conector OFF, base 10° | 817 | 7.5 | 1.162 V |
  | conector ON, base 10° | 827 | 9.0 | 1.160 V |

  Lectura: con la ECM en bypass (las dos filas sólidas, n=41 y n=64, estables y a la misma
  temperatura) avanzar 0°→10° se mide clarísimo: **−4.4 pasos de IAC y −0.067 V de MAP** al mismo
  RPM. El ajuste está hecho y medido.
  **NO concluir nada de las filas "conector ON".** La de base 0° son solo 8 frames en 20 s justo
  tras apagar el A/C, con el ralentí sin asentar (el RPM cae a 725 ahí dentro). Con esa celda
  llegué a decir que la ECM "se traga" el cambio de base y **la lámpara lo desmintió**: con el
  conector reconectado el usuario leyó **por encima de 18°**, cuando con base 0° la ECM daba
  16–18°. O sea que devolvió poco o nada de los 10°, y el motor hoy trae más avance en ralentí
  que ayer. **CERRADO el 2026-09-23 (no ayuda al calentamiento):** decodificando los dos logs por
  el bit del embrague del compresor, los tramos comparables arrancan casi de la misma temperatura
  (81.9 y 82.5 °C) y suben **+1.20 °C/min a base 0° contra +1.23 °C/min a base 10°**. Idéntico, y
  en el tope de la banda. Los 10° no movieron el calentamiento.
  **El contador de detonación NO ha registrado nada.** Si alguien cita un salto de 4→15 en estos
  logs, es basura: esa fila es el frame del apagado de llave (**batería 0.0 V**, y MAP 4.27 V con
  la mariposa cerrada a 925 RPM, físicamente imposible andando). El 9→4 entre los dos logs es el
  ciclo de llave de en medio. En los 116 frames de ralentí con A/C a 10°: **0 eventos**. Y ojo,
  **el acelerador no se movió en ninguno de los dos logs** (TPS = 0.49 V exacto en las 453 filas),
  así que no dicen nada bajo carga.
  **La vuelta en carretera ya se hizo (log `T23-22-24`, 2026-09-23) y SÍ registró:** el contador
  subió **11 → 21, +10 eventos**, todos en frames con temp ≥83 °C y MAP ≥2.6 V. Con la MISMA carga
  por debajo de 80 °C (MAP hasta 3.41 V, TPS hasta 1.16 V, 2200 RPM): **0 eventos**. Calor +
  mezcla pobre + avance. Dos cuidados antes de citarlo: el contador **arranca en 11–13 en cada
  encendido** antes de cualquier carga (ruido de arranque, no detonación real), así que solo
  sirven los incrementos, nunca el valor absoluto; y el 21→32 de la última fila es otra vez el
  frame del apagado de llave (batería 0.0 V). **No bajes los 10° por esto todavía:** la mezcla
  pobre explica la detonación y sigue sin medirse.
  **Segunda vuelta (log `T23-53-57`, 2026-09-23): +5 eventos, 11 → 16**, con MAP 2.19–3.53 V. Lo
  nuevo, y es a peor: **dos de esos incrementos cayeron a 73 y 74 °C**, o sea por debajo de los
  80 °C donde antes había 0. Los otros tres a 81, 85 y 86 °C. Sigue siendo n pequeño. El 16→28 de
  la última fila es otra vez el frame de apagado de llave (batería 0.0 V) — ignóralo.
  **En este ECM no hay avance de chispa ni retardo de knock en el flujo ALDL** (revisado el
  A040.ads: 65 parámetros, solo `Knock Counter` byte 17 y la bandera del código 43/ESC). Cualquier
  plan que pida "monitorear los grados de retardo" es imposible con este hardware.
- **σRPM con A/C: el usuario tiene razón, EMPEORÓ al mover el tiempo. Confirmado con A-B de 17
  tramos el 2026-09-23.** (Antes escribí aquí que quedaba "resuelto, era el lazo". Era falso:
  salió de un solo tramo sin A/C. El A-B contra los logs del 09-22 lo desmiente.)
  Método: ralentí asentado, caliente (≥82 °C), parado, acelerador cerrado, **≥30 s después del
  último cambio del embrague** (si no, los transitorios ensucian todo), separando por el bit del
  compresor. **Con el compresor enganchado:**

  | tiempo base | tramos | σRPM mediana | IQR | rango RPM | IAC |
  |---|---|---|---|---|---|
  | 0° (09-22, 6 logs) | 15 | **24.5** (10.4–81.2) | 25 | 725–950 | 45 |
  | 0° (09-23 19h) | 2 | **22.4** (13.1–31.7) | 25–50 | 725–900 | 38 |
  | 10° (09-23 23h) | 2 | **77.9** (70.6–85.1) | **75** | **550–975** | 42 |

  Los dos tramos con base 10° son peores que 16 de los 17 tramos con base 0°. El único de base 0°
  comparable (81.2) está a 1025 RPM con 30 % de lazo cerrado, otra condición. **No es el lazo:**
  uno de los dos tramos de base 10° está 100 % cerrado y el otro 0 %, y los dos dan 70–85. **No es
  el BLM:** el log `09-22T21-28` tiene BLM 146, igual que anoche, con σ 16.9 y 24.5. **No es la
  temperatura:** todos ≥82 °C. Y el IQR (robusto, no se lo come un pico) pasa de 25 a **75**, así
  que es la distribución entera, no un transitorio suelto.
  **Sin A/C el efecto es mucho más chico y no concluyente:** base 10° da σ 16.8 (IAC 6) contra
  17.1 y 24.8 de los tramos de base 0° del mismo día, y 5.0 del mejor tramo del 09-22 (IAC 11).
  **La pista física: la IAC se está cerrando log tras log.** Sin A/C, caliente: **11 pasos**
  (09-22, base 0°) → **8** (09-23 19h, base 0°) → **6** (09-23 23h, base 10°). Más avance = más
  par con el mismo aire, así que la ECM cierra la IAC para sostener 800 RPM. A 6 pasos casi no le
  queda margen hacia abajo, y cuando entra la carga del compresor el motor se va a 550–975 en vez
  de 725–900. En `T23-53-57` **cayó a 550 RPM con MAP 2.84 V** a 87.5 °C — casi se apaga.
  **QUÉ HACER, y NO es bajar el tiempo:** los 10° son el spec del manual para el 2.8L en
  plataforma S; el 0° era el número del 4.3L. Lo que falta es el otro paso del procedimiento:
  **el aire mínimo se calibró a 600 RPM el 2026-09-22 con el tiempo base en 0°** (ver el bullet
  "Ralentí / aire mínimo" para la evidencia de la fecha) **y no se ha rehecho desde que el tiempo
  pasó a 10°**. GM exige ajustarlo **después** de que el tiempo base esté correcto, justo por
  esto. Rehacerlo ahora (cerrar el tornillo hasta volver a 600 RPM con la IAC desconectada)
  devuelve la IAC a su ventana sana de ~10–15 pasos y le regresa el margen que perdió. Es gratis y es el orden correcto
  del manual. Solo si después de eso el ralentí con A/C sigue en σ 70–85 hay que discutir el
  avance, y aun así la presión del TBI va antes.
  **NO se ajusta en bypass.** El conector SET TIMING va **conectado** (operación normal) durante
  el ajuste de aire mínimo; el bypass fue solo para poner los 10° en el distribuidor y ya cumplió.
  Razón: el aire mínimo se calibra contra el avance con el que el motor **va a funcionar de
  verdad** (la ECM manda 16–18°+ en ralentí), no contra el avance fijo del bypass. Si se ajusta en
  bypass, con menos avance hay menos par, habría que **abrir** el tornillo de más, y al reconectar
  el ralentí se dispararía y la IAC caería a 0 — exactamente el problema del 2026-09-22T04-06, y
  peor. El único que va desconectado es el conector eléctrico de la **IAC**.
  **Trampas al hacerlo:** (a) el procedimiento pide **asentar la IAC antes de desconectarla** (si
  solo la desenchufas, el pintle se queda donde estaba y el tornillo no queda ajustando lo que
  crees) — los pasos exactos están en el mismo *93 Truck Fuel & Emissions Service Manual* que ya
  tiene, y el puente A-B ahí es para eso, **no** para el tiempo (el bypass del V6 sigue siendo el
  conector SET TIMING). El puente A-B va puesto **solo** para asentar el pintle (llave en ON,
  motor APAGADO, ~30 s); se desconecta la IAC con el puente todavía puesto, y **el puente se quita
  ANTES de arrancar** — si el motor arranca con A-B a tierra queda en field service (lazo abierto,
  tiempo fijo) y el RPM que leas no sirve para calibrar. (b) Desconectar la IAC probablemente guarde un código: **NO lo borres
  después** — quitar el fusible del ECM se lleva el BLM, que es la evidencia de la mezcla pobre.
  Un código guardado no estorba (el 42 ya está ahí). (c) Con el A-B puenteado a tierra la ECM
  entra en field service (lazo abierto, tiempo fijo): **no interpretes un log capturado así como
  operación normal**; se nota en el bit de lazo (byte 14 bit 7). (d) Captura el "antes" y el
  "después" **el mismo día**, y mide dos cosas: IAC en ralentí caliente sin A/C (meta ~10–15
  pasos, hoy 6) y σRPM con el compresor enganchado (meta ~25, hoy 78).
  **HECHO el 2026-09-24. Resultado: ayudó a medias.** El usuario rehízo el aire mínimo (log
  `T00-34-45`, quedó en ~610–650 RPM con la IAC asentada) y manejó 45 min (log `T01-23-42`).
  **IAC en ralentí caliente sin A/C: volvió a 12 pasos** (meta cumplida; venía de 6).
  **σRPM con el compresor enganchado: 78 → 53** (n=155, IQR sigue en 75, rango 650–975). Mejoró la
  mitad del camino pero **sigue al doble de los 24.5 de base 0°**, así que el ajuste de aire mínimo
  no era la explicación completa. Ojo con un confusor real: ese tramo corrió a **92.5–96 °C**,
  bastante más caliente que las referencias de base 0° (85–90 °C). Sin A/C el ralentí ya está en el
  rango bueno (σ 21.8, IQR 25, rango 750–850 en el tramo final).
  **TRAMPA QUE CAÍ YO, no la repitas:** al ver IAC 64–65 justo después del ajuste dije "te pasaste
  de cerrado con el tornillo". **Era falso.** La IAC leía alto porque el **BLM estaba en 128**
  (recién borrado) y el motor, más pobre, hacía menos par. En cuanto el BLM reaprendió a 141–147 la
  IAC bajó sola de **65 a 12**. Yo había estimado que el BLM movía ~5 pasos; mueve **~53**. **Nunca
  juzgues la posición de la IAC con el BLM sin reaprender.**
  Historial de cómo se llegó aquí (se deja por el método, ya superado por la tabla de arriba):
- **σRPM con A/C se duplicó el 2026-09-23 — A VIGILAR, sin causa confirmada.** Mismo día, mismo
  motor, ralentí caliente con el compresor enganchado: **σRPM 15.8 → 31.2**, rango 775–825 →
  **725–900**, y la IAC pasó de plana en 30–33 a cazar entre 38 y 50 pasos. No es el VSS (0 pulsos
  falsos en todo el tramo). El 15.8 es justo el valor con que se verificó el arreglo del VSS.
  Entre los dos tramos cambiaron DOS cosas (base 0°→10° y el conector SET TIMING reconectado) y el
  segundo es la segunda jalada de A/C del día, con el compresor ya caliente. **Prueba que lo
  decide:** repetir en la primera jalada del día, 4 min de ralentí caliente con A/C. σ ~16 = fue
  heat-soak; σ ~30 = persiste. **Si persiste, NO bajes el tiempo base primero:** un ralentí pobre
  también caza, y la mezcla pobre con el compresor está confirmada y sin medir. Presión del TBI
  primero; tocar los 10° del spec del manual es el último recurso.
  **Dato nuevo del 2026-09-23 en la noche (log `T23-22-24`), y el usuario lo SINTIÓ:** al llegar a
  su destino apagó A/C y abanicos y notó variaciones pequeñas en ralentí que el día anterior con
  base 0° no sentía. Medido en el ralentí asentado (85.8 °C, sin A/C ni abanicos, IAC 5–9 pasos,
  n=12–14): **σRPM 39.3**, rango 750–875, contra 15.8–18.3 de la verificación del VSS. **No es el
  VSS** (0 velocidades ≠ 0 en las 93 muestras con acelerador cerrado y el camión parado). La
  explicación que encaja con lo demás: ahora está en lazo CERRADO en ralentí (bullet de abajo) y
  está **cazando una mezcla pobre**, con BLM 143 / INT 125 y el O2 oscilando 160–737 mV. Antes, en
  lazo abierto, el combustible era fijo: más parejo al tacto pero sin corregir nada. O sea que el
  ralentí se siente peor mientras la ECM trabaja mejor. Sigue igual la conclusión: presión del TBI
  primero, no bajar el tiempo.
- **Lazo en ralentí: el "cambio" NO se repitió — sigue saliendo a lazo ABIERTO parado.** El log
  `T23-53-57` (mismo día, después del `T23-22-24`, mismo tiempo base y el SET TIMING puesto) da
  **23 % cerrado en ralentí** y **0–10 % en los tramos asentados**, contra 98 % rodando (n=114).
  Así que el 98 % parado del `T23-22-24` fue la excepción, no un estado nuevo, y el ajuste de
  tiempo no lo causó. Bien que quedara anotado como "es UN log". **Regla para leer cualquier CSV:
  mira primero el bit de lazo (byte 14 bit 7) antes de comparar O2, INT o σRPM entre logs** —
  casi todas las discrepancias del 2026-09-23 salieron de mezclar tramos de lazo distinto.
  Lo que decía el bullet original, como historial:
- **Lazo en ralentí: CAMBIÓ el 2026-09-23 (log `T23-22-24`).** Venía de lazo ABIERTO parado
  (1 % cerrado; 0 % con el compresor enganchado) y no era por temperatura (rodando a 96 °C
  cerraba el 100 %, y el sensor O2 conmuta 0–835 mV a 96 °C). Ahora está **cerrado el 98 % parado
  en ralentí** y el 97 % en todo el log, con "Open Loop Idle" en solo 3 %. Coincide con el ajuste
  a 10° + reconectar el SET TIMING, pero es UN log: no lo des como causa probada. Lo que sí
  importa: **el O2 ya no se colapsa con el compresor** (p50 568 mV, 17 % bajo 100 mV, contra
  22–49 mV y 82–100 % del mismo día en `T19-27-18`/`T19-34-26`) — y **no** porque la mezcla se
  arreglara, sino porque ahora la ECM lo tapa metiendo +12 % (BLM 143 con el clutch enganchado
  igual que suelto). Antes de comparar O2 entre logs, mira primero el bit de lazo cerrado.
- **Código 42 (EST Monitor) guardado desde el 2026-09-23.** Venía de bytes 11–13 en 0x00 en 16
  logs / ~2600 frames; en el log `T23-22-24` el **byte 12 bit 0** está puesto en las 209 filas,
  incluso con la llave en ON y el motor apagado. Es **historia del procedimiento de tiempo**
  (desconectar el SET TIMING con el motor andando lo guarda), **no una falla viva**: el usuario
  confirmó que el conector está puesto, y el código quedó porque se le dijo que no desconectara la
  batería. **No lo limpies todavía:** quitar el fusible del ECM (la forma de borrarlo sin tocar la
  batería) borra la memoria de mantenimiento **incluido el BLM**, que es justo la evidencia de la
  mezcla pobre. Déjalo hasta después de medir la presión del TBI.
  **AVISO NUEVO (2026-09-24): el fusible no es la única forma de perder el BLM.** En el log
  `2026-09-24T00-34-45` (procedimiento de aire mínimo) el **BLM vale 128 en las 339 filas** y el
  INT también, contra **146** en el log de 40 minutos antes, **sin haber desconectado la batería
  ni el fusible**. Lo único que pasó en medio fue el procedimiento con el ALDL en modo
  diagnóstico. El **código 42 sobrevivió** (byte 12 = 0x01 en todas las filas), así que no fue un
  borrado general de memoria: se fue **solo el block learn**. Conclusión práctica: **poner el ALDL
  en modo diagnóstico resetea el BLM en este ECM.** Antes de cualquier procedimiento que lo use,
  da por perdida la evidencia del BLM y captura el "antes" primero. Hay que volver a manejarlo
  para que reaprenda antes de que el BLM signifique algo otra vez. Los bytes 11 y 13
  siguen en 0x00. Mapa de los bits de código, por si hace falta otro: `A040.ads` usa byteindex
  **+1** respecto al `raw_frame` (ads 12 = raw 11 → códigos 12/13/14/15/21/22/23/24; ads 13 =
  raw 12 → 25/31/32/33/34/35/41/42; ads 14 = raw 13 → 43/44/45/51/52/53/54/55). Ya no hace falta
  el puente A-B para contar destellos del Check Engine.
  **Sigue igual en el log `T23-53-57`:** byte 12 = 0x01 en las 243 filas, bytes 11 y 13 en 0x00.
  Ningún código nuevo — pero con BLM llegando a 156 ya está rozando el umbral del **código 44
  (O2 pobre)**; si aparece, no es una falla nueva, es la misma mezcla pobre cruzando el límite.
- **Arranque en frío con el sensor nuevo: sin medir.** El 2026-09-23 el usuario salió en frío
  y reportó **cero cabeceo** (con A/C un buen rato, 25 °C nublado), pero no capturó log. Sigue
  siendo la prueba que falta para el síntoma original. Captúrala con la web de `main` (la v2 se
  archivó el 2026-09-28). **El log `T23-22-24` NO es esa prueba:** arranca a 49 °C (motor tibio), no en frío.
- **Ralentí / aire mínimo — OJO CON LA FECHA (corregido el 2026-09-23 con los datos).** Aquí
  decía que el aire mínimo se ajustó el 2026-09-16. **El ajuste que dejó el tornillo donde está
  hoy fue el del 2026-09-22, entre las 03:44 y las 15:16**, y eso importa porque en esa fecha el
  **tiempo base estaba en 0°**. Evidencia: ralentí caliente parado sin A/C, log por log —
  09-16 → 1000 RPM con IAC 35–38; 09-21 → 1000 RPM con IAC 22–25; **09-22T04-06 (03:44) → 975 RPM
  con IAC 0**; **09-22T15-22 (15:16) → 825 RPM con IAC 10**. El salto está entre esos dos logs, no
  el 09-16. (El 09-16 sí hubo un intento, pero no produjo el estado actual.)
  Consecuencia directa: **el tornillo quedó calibrado a 600 RPM con 0° de avance, y hoy el motor
  trae 10°.** Con 10° más de avance el mismo caudal de aire da más par, así que el aire mínimo
  real ahora está **por encima** de 600 y la ECM tiene que cerrar la IAC para sostener 800 →
  **6 pasos** (contra 10–11 con base 0°). Rehacer el procedimiento a 10° obliga a **cerrar** el
  tornillo y le devuelve el margen a la IAC. **No es un ajuste redundante: el tornillo está
  calibrado para un tiempo base que ya no existe.** Ver el bullet de σRPM para las trampas.
- **Variables mezcladas entre capturas:** tiempo base (al principio atrasado por debajo de 0°, no 11° como decía aquí; luego 0° → 10° → 0° → 10° → 5°), limpieza de la IAC y
  resets del BLM. No compares el BLM entre días como si nada, y para el cambio de tiempo el
  "antes" y el "después" tienen que ser del mismo día.
- La ECM manda **1 frame cada ~1.19 s** y el puente capta 1 de cada 2 a 4 según el log (2.38 s
  por fila en `T23-22-24` y en `T23-53-57`, ≈3.6 s en los anteriores): los CSV no resuelven fallas de encendido ni oscilaciones rápidas del O2. Compara
  distribuciones (percentiles), no cuentes cruces.
  **Causa y arreglo (2026-09-28, CONFIRMADO en el camión, también con el motor andando y SIN el
  condensador: log `2026-09-28T22-06-00`, 398 filas de 400 posibles en 474 s, una cada 1.189 s; los 2
  frames que faltan son uno en el arranque (batería 9.8 V) y uno al apagar; 0 frames corruptos en 380
  con el motor andando. Los logs viejos tenían 1 fila cada 2.4-3.6 s):** los mensajes van pegados (10 unos de
  SYNC + 20 bytes = 190 celdas = 1.19 s) y el lector viejo, que leía la línea por sondeo en el mismo
  hilo que imprime y atiende el WiFi, solo tenía 1 pulso de margen para cazar el SYNC siguiente.
  El firmware ahora anota cada flanco por interrupción y decodifica aparte
  (`firmware/esp8266_aldl_bridge/aldl_decoder.h`, misma regla de muestreo que antes). Probado en
  la computadora con señal simulada y frames reales (`test/firmware/aldl_decoder_test.cpp`: 100 %
  limpio, con reloj ±1.6 %, temblor y desborde de micros()) y compila; **falta flashearlo y ver un
  log**. Cada 10 s imprime `Stats ALDL: ok=... prom_mal=... ruido=... flancos=... nivel=...` por
  Serial: con la ECM hablando, `ok` sube ~8 y `flancos` ~3,200 cada 10 s. `flancos=0 nivel=bajo`
  = no llega señal (llave en OFF o cable suelto), no es el firmware. Si algo sale mal, volver al commit anterior del `.ino`.
- **El BLM alterna entre dos valores frame a frame** (p. ej. 146/135 en `T23-53-57`) cuando el MAP
  se mueve: son **dos celdas de BLM vecinas**, no ruido ni un error de decodificación. Usa
  medianas sobre un tramo, nunca filas sueltas.
- **Ojo con los logs anteriores al 2026-09-22:** el firmware descartaba la mayoría de los
  frames por un desfase de 1 bit (el 1228062 manda un SYNC de DIEZ unos, no nueve). Un log
  viejo con huecos largos no significa que la ECM dejara de hablar. Ya corregido: 100 % de
  aceptación, 0 descartes.

Detalle para humanos en el README ("Primer caso real", "Segundo caso real" y "Tercer caso real").

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

El hardware ya está armado y leyendo el camión; las preguntas de bring-up
("¿ya armó el level-shifter?") están superadas. **Estado al 2026-09-28: los tres
problemas grandes del Sonoma están resueltos** (sensor O2, pulso falso del VSS y
mezcla pobre; ver "Resultado real"). No hay nada urgente. Pendientes, sin prisa:

1. Tiempo base ya en **10°** (2026-09-28). La detonación con carga a 10° ya está
   medida (`2026-09-28T01-30-21`, misma configuración: 203 + premium + aditivo).
2. Si el usuario quiere mejorar el ralentí con A/C: el **proyecto de la PROM**
   (foto de la etiqueta del chip → leer el `.bin` → XDF de esa calibración →
   subir el RPM objetivo con A/C → quemar otro EPROM, guardando el original).
   Es donde el editor XDF de este proyecto se vuelve útil de verdad.
   **Ya investigado (2026-09-28):** máscara **$4E** (tunerpro.net, TunerCat y la lista C3 de
   Ludis coinciden). El PROM ID que manda el camión, **551 (0x0227)**, es el "Scan ID" del chip
   de fábrica **AZNU** (S10/S15 2.8 manual 91–93, PROM ID 0435; el dato viene de un anuncio de
   eBay y un post de gearhead-efi), así que el chip *probablemente* es de fábrica, aunque editar
   tablas sin cambiar el ID es posible. EPROM **2732A** (24 pines, 4 KB, mapeada en $D000).
   XDF gratis: `~/Downloads/4E.xdf` (Robert Saar 2009, de
   https://www.tunerpro.net/download/bindefs/GM/4E.xdf) — **formato de texto viejo de TunerPro
   ("XDF 1.110000"), no XML**. **Desde el 2026-09-28 la web app lo abre** (`parseLegacyXDF` en
   `src/xdf-parser.js`): tablas, constantes y banderas agrupadas, checksum OK/MAL al cargar el
   `.bin`, y el comparador de binarios anota qué constante o celda cambió y valida el checksum de
   A y B. Probado con el 4E.xdf real y un `.bin` sintético; **falta probarlo con el `.bin` real**
   (y revisar que el bit de "Tranny Select" = manual salga en 1). Checksum: suma 16 bits de 0x0004–0x0FFF guardada en 0x0000; PROM ID en
   0x0002–3, máscara en 0x0004. Trae "Target Idle Speed A/C On/Off" (0x5CD/0x5CF, X×12.5 RPM),
   **pero no un parámetro de pasos de IAC al enganchar el A/C** (TunerCat, de pago, tampoco;
   lista pública en `~/Downloads/TunerCat_ecm_4E_parametros.pdf`). **Para la duda del chip
   modificado:** "BPW Constant for EGR Off" en **0x2AE** vale **166 en un 2.8 de fábrica** (181 en
   el 4.3) según el autor del XDF — es lo primero que hay que leer en el `.bin`. No hay `.bin` de
   stock descargable. `~/Downloads/4E.ads` es la v1.3 del mismo flujo que `A040.ads`.
3. La prueba de la hoja en el escape para el pop de ralentí.
3b. Pruebas gratis del manual (pasos en `docs/manual-1993.md` §3): EGR (levantar el diafragma),
   Thermac, golpes al sensor de detonación con la app en vivo, PCV.
4. Menores: borrar el código 42 (desconectar la batería; ya no hay BLM que
   proteger), filtro de aire nuevo, soldar y termocontráctil en los empalmes del
   diodo del compresor, contrastar el velocímetro contra GPS.

**Versión universal (antes "v2"), archivada el 2026-09-28.** El intento de perfil de protocolo
como dato (el firmware recibe de la web baud/bytes/PROM ID sacados del `.adx`) quedó en la etiqueta
`archivo/v2-perfil-protocolo`; el PR #1 se cerró y sus ramas se borraron. Se rehará en una rama
nueva desde `main` **después** de probar en el camión el firmware por interrupción, rescatando la
parte web (`src/firmware-link.js`, `src/protocol-profile.js`: `git show archivo/v2-perfil-protocolo:<ruta>`).
El decodificador nuevo ya ayuda: el largo del frame es parámetro y la caza del SYNC sirve con 9 o 10
unos; falta que el PROM ID y el largo lleguen por el perfil. Solo el Sonoma puede validarlo.

**No reabras el enfriamiento** sin que él lo pida. No re-litigar las decisiones
de la sección "Decisiones ya tomadas" salvo que el usuario explícitamente pida
cambiarlas.

**No abras los CSV de `~/Downloads` por iniciativa propia** — el usuario lo
pidió explícitamente el 2026-09-23. Espera a que diga que capturó uno nuevo;
listar nombres y fechas sí está bien.
