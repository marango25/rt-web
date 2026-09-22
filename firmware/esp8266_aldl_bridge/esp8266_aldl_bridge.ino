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
 *    Aquí se hace bit-banging manual (no Serial.begin(160), eso no existe),
 *    leyendo el pin con timing preciso.
 * 3. Esto es un PUNTO DE PARTIDA funcional para pruebas de banco, no un
 *    producto terminado. Espera ajustar los timings de sincronización
 *    (ALDL_BIT_US) una vez que lo pruebes contra tu ECU real.
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
#include "secrets.h" // copia secrets.h.example a secrets.h y pon ahí el AP_SSID/AP_PASS de la red que va a transmitir el ESP8266 (no se sube al repo)

// ---------- CONFIG ----------
const char* MDNS_NAME = "rtweb"; // -> rtweb.local

#define ALDL_PIN 4          // GPIO donde llega la señal ALDL (vía buffer/level-shifter)
#define ALDL_BIT_US 6250    // 160 baud => ~6.25ms por celda de bit completa.
#define ALDL_SAMPLE_US 2000 // instante de muestreo tras el flanco de bajada (ver readAldlBit).
                             // Timing documentado (pulso corto ~368us = 0, largo ~4400us = 1)
                             // varía entre ECMs - AJUSTAR con captura real (osciloscopio/
                             // analizador lógico) si no sincroniza con tu ECU.
#define ALDL_SYNC 0x1FF      // 9 bits en 1 consecutivos = byte de sincronización/resync de frame
#define ALDL_FRAME_BYTES 20  // ECM 1228062 / definición ALDL "A040" (GMC Sonoma 1993 2.8L TBI):
                             // A040.ads dice iNumBytesInPayload=20. El byte "1" de esa
                             // numeración (1-based) cae en frameBuf[0]. Ver defs/*.adx para el
                             // historial completo de por qué se probó y descartó un offset de 21.
                             // Cambia esto si usas otro ECM/definición.
#define ALDL_PROM_ID_HI 0x02 // PROM ID (2 bytes, frameBuf[1..2]) es constante para este ECM -
#define ALDL_PROM_ID_LO 0x27 // se usa para descartar frames mal sincronizados (ver loop()).

#define ALDL_8192_BIT_US 122     // periodo de un bit a 8192 baud (~122.07us). A diferencia de 160
                                  // baud (que codifica cada bit como ancho de pulso dentro de una
                                  // celda fija - ver readAldlBit160), el modo "high speed" de ALDL a
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
volatile bool frameReady = false;

AldlProtocol currentProtocol = PROTO_160; // arrancamos asumiendo 160 baud (protocolo confirmado del Sonoma)
uint8_t protocolFailures = 0;

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

// ---------- LECTURA ALDL (bit-banging por ancho de pulso + sync) ----------
// Basado en documentación pública del protocolo GM ALDL 160 baud (Tech Edge;
// implementación de referencia "bot-thoughts" con Teensy 3.6). Cada bit es
// un pulso bajo de ancho variable dentro de una celda de ALDL_BIT_US:
//   - pulso corto (~368us)  => bit 0
//   - pulso largo (~4400us) => bit 1
// Se muestrea ALDL_SAMPLE_US después del flanco de bajada: si la línea
// sigue baja en ese instante, es un 1; si ya volvió a alta, es un 0.
// El byte de sincronización ALDL_SYNC (0x1FF, nueve 1-bits seguidos) es
// la única secuencia de 9 bits en 1 que el ECM manda - marca el inicio de
// frame y resincroniza el conteo de bits por byte en cualquier punto.
// IMPORTANTE: el timing exacto (ALDL_SAMPLE_US, ALDL_BIT_US) varía entre
// ECMs según la fuente original - si no sincroniza con tu Sonoma, captura
// la señal real con osciloscopio/analizador lógico y ajusta estos valores.

// Lee un bit ALDL bloqueando hasta completar su celda. Devuelve -1 si no
// hay flanco de bajada dentro de idleTimeoutUs (línea inactiva / fin de frame).
int readAldlBit160(unsigned long idleTimeoutUs) {
  unsigned long waitStart = micros();
  while (digitalRead(ALDL_PIN) == HIGH) {
    if ((unsigned long)(micros() - waitStart) > idleTimeoutUs) return -1;
    yield(); // deja respirar al stack WiFi/TCP mientras esperamos (si no, WDT resetea el chip)
  }

  unsigned long edgeTime = micros();
  // Muestrea 3 veces alrededor de ALDL_SAMPLE_US (en vez de una sola lectura)
  // y toma la mayoría - más resistente a un pico de ruido justo en el
  // instante de muestreo (motor encendido = bujías/bobina metiendo ruido).
  delayMicroseconds(ALDL_SAMPLE_US - 200);
  int lowCount = 0;
  for (int i = 0; i < 3; i++) {
    if (digitalRead(ALDL_PIN) == LOW) lowCount++;
    delayMicroseconds(200);
  }
  int bit = (lowCount >= 2) ? 1 : 0;

  // Completa el resto de la celda antes de buscar el siguiente flanco.
  while ((unsigned long)(micros() - edgeTime) < ALDL_BIT_US) {
    yield();
  }
  return bit;
}

bool readAldlFrame160(uint8_t* out, size_t frameLen) {
  // Fase 1: cazar el SYNC activamente antes de guardar nada. Sin esto, cada
  // llamada empezaba a grabar desde donde cayera el primer flanco (no
  // necesariamente el inicio real de un mensaje), causando un desfase que
  // se acumulaba de a 1 byte por frame cuando los mensajes vienen seguidos
  // (poco hueco de silencio entre ellos, como con el motor encendido).
  // Fase 0: no empezar a cazar a media celda. readAldlBit160() da por hecho que
  // la línea está en alto y que el próximo flanco de bajada abre una celda nueva;
  // si entramos con la línea ya en bajo (a mitad de un pulso, que es lo normal
  // justo después de terminar el frame anterior), mide un pulso parcial y el
  // conteo de bits arranca desfasado. Esperar al alto cuesta como mucho una celda.
  unsigned long alignStart = micros();
  while (digitalRead(ALDL_PIN) == LOW) {
    if ((unsigned long)(micros() - alignStart) > (unsigned long)ALDL_BIT_US * 2) break; // línea pegada en bajo
    yield();
  }

  uint16_t shiftReg = 0;
  unsigned long huntStart = millis();
  while (true) {
    if (millis() - huntStart > 3000) return false; // no se encontró sync a tiempo

    int bit = readAldlBit160(2000000UL);
    if (bit < 0) return false; // bus inactivo

    shiftReg = ((shiftReg << 1) | bit) & ALDL_SYNC;
    if (shiftReg == ALDL_SYNC) break;
  }

  // Fase 1b: agotar la racha de unos antes de grabar nada. ALDL_SYNC son NUEVE
  // 1-bits, pero el 1228062 manda DIEZ (medido con captura de anchos de pulso en
  // el Sonoma: diez L4400 seguidos antes de cada mensaje). Enganchar a los nueve
  // dejaba el bit sobrante como primer bit del primer grupo y corría el mensaje
  // entero un bit - los frames salían divididos por 2 (02 27 -> 01 13) y el
  // chequeo de PROM ID los descartaba. Que a veces sí alineara era suerte: la
  // caza empieza en un punto cualquiera del pulso, así que a veces contaba solo
  // nueve de los diez unos (de ahí el 28% de frames capturados del log 04:06Z).
  // Cada byte viaja como [bit de arranque en 0][8 bits de datos], así que ningún
  // dato puede dar nueve unos seguidos (0xFF da ocho, cortados por el arranque
  // del siguiente byte): el primer 0 tras la racha es el arranque del primer byte.
  int firstBit;
  do {
    if (millis() - huntStart > 3000) return false;
    firstBit = readAldlBit160((unsigned long)ALDL_BIT_US * 3);
    if (firstBit < 0) return false;
  } while (firstBit == 1);

  // Fase 2: ya alineados justo después de un SYNC real - ahora sí se capturan
  // los frameLen bytes del mensaje. Arranca con el bit de arranque ya leído.
  int bitCount = 1;
  size_t byteIdx = 0;
  unsigned long frameStart = millis();
  shiftReg = 0;

  while (byteIdx < frameLen) {
    if (millis() - frameStart > 3000) return false; // frame incompleto: se cortó a media lectura

    int bit = readAldlBit160((unsigned long)ALDL_BIT_US * 3);
    if (bit < 0) return false;

    shiftReg = ((shiftReg << 1) | bit) & ALDL_SYNC;
    bitCount++;

    if (shiftReg == ALDL_SYNC) {
      // Resync de emergencia si aparece otro sync a mitad de frame: agotar
      // también aquí la racha de unos, por la misma razón que en la fase 1b.
      do {
        bit = readAldlBit160((unsigned long)ALDL_BIT_US * 3);
        if (bit < 0) return false;
      } while (bit == 1);
      shiftReg = 0;
      bitCount = 1;
      continue;
    }

    if (bitCount == 9) {
      out[byteIdx++] = shiftReg & 0xFF;
      bitCount = 0;
    }
  }
  return true;
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
    Serial.printf("Cambiando a modo %s...\n", currentProtocol == PROTO_160 ? "160 baud" : "8192 baud");
  }
}

void loop() {
  ws.cleanupClients();

  if (currentProtocol == PROTO_160) {
    if (readAldlFrame160(frameBuf, ALDL_FRAME_BYTES)) {
      protocolFailures = 0;
      // El cazador de SYNC a veces engancha un falso positivo (ruido) y captura
      // bytes que no arrancan en el lugar correcto. El PROM ID es constante
      // en un frame bien alineado - si no calza, se descarta en vez de mandar
      // basura a la web app (esto es lo que causaba "80mph"/"13000rpm" con el
      // motor prendido: frames de otro alineamiento, no ruido bit a bit).
      if (frameBuf[1] != ALDL_PROM_ID_HI || frameBuf[2] != ALDL_PROM_ID_LO) {
        Serial.println("Frame descartado (PROM ID no calza - desincronizado)");
        return;
      }
      logFrameHex("Frame ALDL (160 baud): ", frameBuf, ALDL_FRAME_BYTES);
      broadcastFrame(frameBuf, ALDL_FRAME_BYTES, "160");
    } else {
      handleProtocolFailure();
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
