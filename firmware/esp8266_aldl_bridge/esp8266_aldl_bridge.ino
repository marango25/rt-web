/**
 * esp8266_aldl_bridge.ino
 *
 * Puente ESP8266 <-> GM ALDL (160 u 8192 baud, autodetectado) <-> WebSocket.
 * El ESP8266 transmite su propia red WiFi (Access Point) - no necesita el
 * WiFi de casa ni un hotspot del celular, así que sirve igual en la calle
 * que en el garage. Conéctate a esa red y entra a su IP (ver setupWifi()).
 *
 * IMPORTANTE - lee esto antes de flashear:
 * 1. La línea ALDL es de un solo hilo (half-duplex), a nivel TTL pero con
 *    la ECU manejando el bus. NO conectes el pin ALDL directo al GPIO del
 *    ESP8266 sin protección - necesitas al menos una resistencia limitadora
 *    y, idealmente, un transistor/optoacoplador como buffer (ver hilos de
 *    GM-OBD1 en GitHub para el esquema de 2 transistores). Conectar directo
 *    puede dañar el ESP8266 o la ECU.
 * 2. 160 baud es MUY lento comparado con lo que el ESP8266 maneja normalmente.
 *    No es UART (no existe Serial.begin(160)): una interrupción anota la hora
 *    de cada flanco del pin y aldl_decoder.h decodifica el ancho de pulso.
 * 3. Esto es un PUNTO DE PARTIDA funcional para pruebas de banco, no un
 *    producto terminado. Espera ajustar los timings de sincronización
 *    (ALDL_DEC_* en aldl_decoder.h) una vez que lo pruebes contra tu ECU real.
 * 4. El firmware prueba 160 baud primero (protocolo confirmado de nuestro
 *    Sonoma 1993) y, si no sincroniza tras varios intentos, alterna a
 *    intentar 8192 baud (ver ALDL_8192_BIT_US) - pero ese segundo modo solo
 *    detecta actividad con forma de UART válida y manda los bytes crudos;
 *    NO tiene un frame/PROM ID/checksum validado como 160 baud, porque
 *    nunca se probó contra una ECU real que lo use. Trátalo como un punto
 *    de partida para ese caso, no como algo ya calibrado.
 *
 * Librerías necesitadas (Arduino IDE > Library Manager):
 *  - ESP8266WiFi (viene con el core de ESP8266)
 *  - ESPAsyncTCP
 *  - ESPAsyncWebServer
 *  - ArduinoJson
 */

#include <ESP8266WiFi.h>
#include <ESPAsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <ESP8266mDNS.h>
#include "aldl_decoder.h" // decodificador de 160 baud por flancos con hora (lo alimenta la interrupción de abajo)
#include "secrets.h" // copia secrets.h.example a secrets.h y pon ahí el AP_SSID/AP_PASS de la red que va a transmitir el ESP8266 (no se sube al repo)

// ---------- CONFIG ----------
const char* MDNS_NAME = "rtweb"; // -> rtweb.local

#define ALDL_PIN 4          // GPIO donde llega la señal ALDL (vía buffer/level-shifter)
// El timing de 160 baud (celda ~6.25 ms, muestreo a 2000 us del flanco, SYNC de 9+ unos)
// vive en aldl_decoder.h (ALDL_DEC_*). Pulso corto ~368 us = 0, largo ~4400 us = 1.
#define ALDL_FRAME_BYTES 20  // ECM 1228062 / definición ALDL "A040" (GMC Sonoma 1993 2.8L TBI):
                             // A040.ads dice iNumBytesInPayload=20. El byte "1" de esa
                             // numeración (1-based) cae en frameBuf[0]. Ver defs/*.adx para el
                             // historial completo de por qué se probó y descartó un offset de 21.
                             // Cambia esto si usas otro ECM/definición.
#define ALDL_PROM_ID_HI 0x02 // PROM ID (2 bytes, frameBuf[1..2]) es constante para este ECM -
#define ALDL_PROM_ID_LO 0x27 // se usa para descartar frames mal sincronizados (ver loop()).

#define ALDL_8192_BIT_US 122     // periodo de un bit a 8192 baud (~122.07us). A diferencia de 160
                                  // baud (que codifica cada bit como ancho de pulso dentro de una
                                  // celda fija - ver aldl_decoder.h), el modo "high speed" de ALDL a
                                  // 8192 baud es UART estándar de verdad: 1 bit de start (bajo), 8 de
                                  // datos (LSB primero), 1 de stop (alto) - como un puerto serial
                                  // normal pero a una tasa no estándar. Esto es documentación pública
                                  // del protocolo GM ALDL, NUNCA probada contra hardware real en este
                                  // proyecto (nuestro Sonoma 1993 solo habla 160 baud). Si algún día
                                  // conectas una ECU que sí hable 8192 baud, verifica esta
                                  // codificación con un analizador lógico antes de confiar en los
                                  // datos - podría no calzar exacto con tu ECU.
#define ALDL_8192_MAX_FRAME 32    // sin un sync/checksum conocido para este modo (a diferencia del
                                  // 0x1FF de 160 baud), agrupamos bytes por huecos de silencio en la
                                  // línea en vez de por un largo de frame fijo - ver readAldlFrame8192.
#define ALDL_8192_IDLE_GAP_US (ALDL_8192_BIT_US * 3)
#define ALDL_PROTO_FAILURES_BEFORE_SWITCH 3 // intentos fallidos seguidos (c/u hasta ~3s) antes de
                                             // probar el otro protocolo - ver loop()/handleProtocolFailure().

enum AldlProtocol { PROTO_160, PROTO_8192 };

// ---------- ESTADO GLOBAL ----------
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

uint8_t frameBuf[ALDL_8192_MAX_FRAME > ALDL_FRAME_BYTES ? ALDL_8192_MAX_FRAME : ALDL_FRAME_BYTES];

AldlProtocol currentProtocol = PROTO_160; // arrancamos asumiendo 160 baud (protocolo confirmado del Sonoma)
uint8_t protocolFailures = 0;

// ---------- CAPTURA DE FLANCOS POR INTERRUPCIÓN (160 baud) ----------
// La interrupción solo anota la hora y el nivel de cada flanco en un buffer
// circular; loop() lo vacía hacia AldlDecoder. Así la hora de cada flanco es
// exacta aunque el loop esté ocupado imprimiendo, armando JSON o atendiendo
// el WiFi (ver el porqué en aldl_decoder.h). ~320 flancos/s: 512 dan ~1.6 s
// de colchón antes de perder alguno.
#define EDGE_BUF_SIZE 512 // potencia de 2
volatile uint32_t edgeTimes[EDGE_BUF_SIZE];
volatile uint8_t edgeLow[EDGE_BUF_SIZE];
volatile uint16_t edgeHead = 0; // lo escribe la interrupción
uint16_t edgeTail = 0;          // lo lee loop()
volatile uint32_t edgeOverflows = 0;
volatile uint32_t edgeCount = 0; // flancos vistos por la interrupción (0 = la línea está quieta: llave en OFF o sin conexión)

AldlDecoder aldl;
unsigned long lastGoodFrameMs = 0;
unsigned long lastStatsMs = 0;
uint32_t statPromMismatch = 0;

void IRAM_ATTR onAldlEdge() {
  uint32_t t = micros();
  uint8_t low = GPIP(ALDL_PIN) ? 0 : 1;
  edgeCount++;
  uint16_t next = (edgeHead + 1) & (EDGE_BUF_SIZE - 1);
  if (next == edgeTail) {
    edgeOverflows++; // loop() no alcanzó a vaciar: se pierde este flanco (sale en las estadísticas)
    return;
  }
  edgeTimes[edgeHead] = t;
  edgeLow[edgeHead] = low;
  edgeHead = next;
}

void startEdgeCapture() {
  edgeTail = edgeHead;
  aldlDecoderReset(&aldl, ALDL_FRAME_BYTES);
  lastGoodFrameMs = millis();
  attachInterrupt(digitalPinToInterrupt(ALDL_PIN), onAldlEdge, CHANGE);
}

void stopEdgeCapture() {
  detachInterrupt(digitalPinToInterrupt(ALDL_PIN));
}

// ---------- WIFI + WEBSOCKET ----------
void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
               AwsEventType type, void* arg, uint8_t* data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    Serial.printf("Cliente WS conectado: %s\n", client->remoteIP().toString().c_str());
  } else if (type == WS_EVT_DISCONNECT) {
    Serial.println("Cliente WS desconectado");
  }
}

// El ESP8266 transmite SU PROPIA red WiFi (modo Access Point) en vez de
// unirse a una existente - así no depende de tener el WiFi de casa (o un
// hotspot del celular) a la mano para funcionar. Conecta el teléfono/laptop
// directo a esta red y entra a la IP que imprime por Serial (normalmente
// 192.168.4.1, fija, no cambia). mDNS (rtweb.local) también funciona como
// atajo en la mayoría de casos, pero no es tan confiable en todos los
// navegadores/Android - la IP siempre funciona.
void setupWifi() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("Red propia lista: ");
  Serial.println(AP_SSID);
  Serial.print("IP: ");
  Serial.println(WiFi.softAPIP());

  if (MDNS.begin(MDNS_NAME)) {
    Serial.printf("mDNS activo (best-effort): http://%s.local\n", MDNS_NAME);
  }
}

void broadcastFrame(uint8_t* buf, size_t len, const char* proto) {
  // Manda { "t": millis, "proto": "160"|"8192", "raw": [b0, b1, ...] } - el
  // parseo/decodificación real vive en la web app (usando el .adx cargado),
  // el firmware solo transporta bytes crudos + en qué protocolo los leyó.
  // "proto" existe para que la web app pueda avisar si el frame viene de un
  // modo (8192 baud) que todavía no tiene una definición real decodificable.
  StaticJsonDocument<512> doc;
  doc["t"] = millis();
  doc["proto"] = proto;
  JsonArray raw = doc.createNestedArray("raw");
  for (size_t i = 0; i < len; i++) raw.add(buf[i]);

  String out;
  serializeJson(doc, out);
  ws.textAll(out);
}

void logFrameHex(const char* label, uint8_t* buf, size_t len) {
  Serial.print(label);
  for (size_t i = 0; i < len; i++) {
    if (buf[i] < 0x10) Serial.print('0');
    Serial.print(buf[i], HEX);
    Serial.print(' ');
  }
  Serial.println();
}

// ---------- LECTURA ALDL A 160 BAUD ----------
// Codificación por ancho de pulso: cada bit es una celda de ~6.25 ms que abre
// con un flanco de bajada; pulso bajo corto (~368 us) = 0, largo (~4400 us) = 1.
// El SYNC son diez 1 seguidos (el 1228062 manda diez, no nueve). La decodificación
// vive en aldl_decoder.h y se alimenta con los flancos que anota onAldlEdge().
// El timing (ALDL_DEC_SAMPLE_US) es el mismo del lector anterior, ya probado en el Sonoma.

// Vacía el buffer de flancos hacia el decodificador. Devuelve true si salió un frame completo.
bool pumpAldl160() {
  uint32_t now = micros();
  // Solo flancos de antes de `now`: los posteriores esperan a la próxima vuelta,
  // para que aldlTick(now) no muestree con un nivel "del futuro".
  while (edgeTail != edgeHead) {
    uint32_t t = edgeTimes[edgeTail];
    if ((int32_t)(t - now) > 0) break;
    aldlFeedEdge(&aldl, t, edgeLow[edgeTail] != 0);
    edgeTail = (edgeTail + 1) & (EDGE_BUF_SIZE - 1);
    if (aldl.frameReady) return true; // entregar antes de que el siguiente frame lo pise
  }
  aldlTick(&aldl, now);
  return aldl.frameReady;
}

void printAldlStats() {
  // Línea de diagnóstico: la web app solo parsea las líneas "Frame ALDL", así que esta no estorba.
  // ok = frames entregados; con la ECM mandando uno cada ~1.19 s, en 10 s deberían ser ~8.
  // flancos: ~320/s con la ECM hablando; 0 = no llega señal al pin. nivel = cómo está la línea ahora (en reposo, alta).
  Serial.printf("Stats ALDL: ok=%u prom_mal=%u resync=%u inactivo=%u ruido=%u overflow=%u flancos=%u nivel=%s\n",
                (unsigned)aldl.statFrames, (unsigned)statPromMismatch, (unsigned)aldl.statResyncs,
                (unsigned)aldl.statIdleAborts, (unsigned)aldl.statGlitches, (unsigned)edgeOverflows,
                (unsigned)edgeCount, digitalRead(ALDL_PIN) ? "alto" : "bajo");
}

// ---------- LECTURA ALDL A 8192 BAUD (UART estándar, protocolo alterno) ----
// A diferencia de 160 baud, aquí no cazamos un SYNC de 9 bits en 1 - es un
// esquema completamente distinto (ver comentario de ALDL_8192_BIT_US arriba).
// Sin un sync/checksum conocido para este modo, agrupamos bytes por huecos
// de silencio en la línea en vez de por un largo de frame fijo.

// Lee un byte UART estándar (8N1, LSB primero) a ALDL_8192_BIT_US por bit.
// Devuelve -1 si no hay flanco de bajada dentro de idleTimeoutUs (línea
// inactiva) o si el bit de start/stop no calza (framing inválido - probable
// señal que en realidad no es 8192 baud, o ruido).
int readAldl8192Byte(unsigned long idleTimeoutUs) {
  unsigned long waitStart = micros();
  while (digitalRead(ALDL_PIN) == HIGH) {
    if ((unsigned long)(micros() - waitStart) > idleTimeoutUs) return -1;
    yield();
  }

  unsigned long bitStart = micros();
  delayMicroseconds(ALDL_8192_BIT_US / 2); // al centro del bit de start
  if (digitalRead(ALDL_PIN) != LOW) return -1; // flanco falso (ruido), no era un start bit real

  uint8_t value = 0;
  for (int i = 0; i < 8; i++) {
    while ((unsigned long)(micros() - bitStart) < (unsigned long)ALDL_8192_BIT_US * (i + 1)) yield();
    if (digitalRead(ALDL_PIN) == HIGH) value |= (1 << i); // LSB primero, como UART estándar
  }

  while ((unsigned long)(micros() - bitStart) < (unsigned long)ALDL_8192_BIT_US * 9) yield();
  if (digitalRead(ALDL_PIN) != HIGH) return -1; // bit de stop inválido: framing error

  return value;
}

// Lee bytes hasta que la línea queda en silencio (fin de mensaje) o se llena
// el buffer. Devuelve cuántos bytes se alcanzaron a leer (0 si no hubo
// actividad válida en absoluto - eso es lo que usa loop() para decidir si
// este protocolo no es el correcto y toca probar el otro).
size_t readAldlFrame8192(uint8_t* out, size_t maxLen) {
  size_t count = 0;
  while (count < maxLen) {
    int b = readAldl8192Byte(count == 0 ? 2000000UL : ALDL_8192_IDLE_GAP_US);
    if (b < 0) break;
    out[count++] = (uint8_t)b;
  }
  return count;
}

// ---------- SETUP / LOOP ----------
void setup() {
  Serial.begin(115200);
  pinMode(ALDL_PIN, INPUT);
  startEdgeCapture(); // arrancamos en 160 baud

  setupWifi();

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send(200, "text/plain", "RT-Web bridge activo. Conecta la web app via WebSocket a /ws");
  });

  server.begin();
  Serial.println("Servidor listo.");
}

// Cuenta un intento fallido del protocolo actual y, tras
// ALDL_PROTO_FAILURES_BEFORE_SWITCH seguidos, prueba el otro. Así el
// firmware no necesita saber de antemano si el ECU conectado habla 160 u
// 8192 baud - lo descubre solo, alternando hasta que uno sincroniza.
void handleProtocolFailure() {
  protocolFailures++;

  static unsigned long lastNoDataLog = 0;
  if (millis() - lastNoDataLog > 2000) {
    Serial.printf(
        "Sin datos ALDL en modo %s (intento %u/%u antes de probar el otro protocolo) - normal si la "
        "llave no esta en ON o el pin no es el correcto\n",
        currentProtocol == PROTO_160 ? "160 baud" : "8192 baud", protocolFailures, ALDL_PROTO_FAILURES_BEFORE_SWITCH);
    lastNoDataLog = millis();
  }

  if (protocolFailures >= ALDL_PROTO_FAILURES_BEFORE_SWITCH) {
    currentProtocol = (currentProtocol == PROTO_160) ? PROTO_8192 : PROTO_160;
    protocolFailures = 0;
    // 8192 baud se lee por sondeo (readAldl8192Byte); la interrupción de 160 solo corre en su modo.
    if (currentProtocol == PROTO_160) startEdgeCapture();
    else stopEdgeCapture();
    Serial.printf("Cambiando a modo %s...\n", currentProtocol == PROTO_160 ? "160 baud" : "8192 baud");
  }
}

void loop() {
  ws.cleanupClients();

  if (currentProtocol == PROTO_160) {
    if (pumpAldl160()) {
      aldl.frameReady = false;
      for (size_t i = 0; i < ALDL_FRAME_BYTES; i++) frameBuf[i] = aldl.frame[i];
      // El cazador de SYNC a veces engancha un falso positivo (ruido) y captura
      // bytes que no arrancan en el lugar correcto. El PROM ID es constante
      // en un frame bien alineado - si no calza, se descarta en vez de mandar
      // basura a la web app (esto es lo que causaba "80mph"/"13000rpm" con el
      // motor prendido: frames de otro alineamiento, no ruido bit a bit).
      if (frameBuf[1] != ALDL_PROM_ID_HI || frameBuf[2] != ALDL_PROM_ID_LO) {
        statPromMismatch++;
        Serial.println("Frame descartado (PROM ID no calza - desincronizado)");
      } else {
        protocolFailures = 0;
        lastGoodFrameMs = millis();
        logFrameHex("Frame ALDL (160 baud): ", frameBuf, ALDL_FRAME_BYTES);
        broadcastFrame(frameBuf, ALDL_FRAME_BYTES, "160");
      }
    } else if (millis() - lastGoodFrameMs > 3000) {
      // Igual que antes: ~3 s sin un frame válido cuenta como un intento fallido de este protocolo.
      lastGoodFrameMs = millis();
      handleProtocolFailure();
    }
    if (millis() - lastStatsMs > 10000) {
      lastStatsMs = millis();
      printAldlStats();
    }
  } else {
    // A diferencia de 160 baud, aquí no validamos PROM ID (no conocemos el
    // framing/checksum real de este modo todavía - ver comentario de
    // ALDL_8192_BIT_US). Solo confirmamos que HAY actividad con forma de
    // UART válida y mandamos los bytes crudos con "proto":"8192" para que
    // quede claro en la web app que no vienen de una definición decodificada.
    size_t n = readAldlFrame8192(frameBuf, ALDL_8192_MAX_FRAME);
    if (n > 0) {
      protocolFailures = 0;
      Serial.printf("Actividad a 8192 baud detectada (%u bytes) - protocolo no completamente validado aun.\n", (unsigned)n);
      logFrameHex("Frame ALDL (8192 baud, crudo): ", frameBuf, n);
      broadcastFrame(frameBuf, n, "8192");
    } else {
      handleProtocolFailure();
    }
  }
}
