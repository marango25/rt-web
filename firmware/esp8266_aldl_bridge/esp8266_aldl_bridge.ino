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
 * 5. (v2) Perfil de protocolo: el largo del frame, el PROM ID y si se fija el baud
 *    ya no son solo constantes compiladas. La web los manda al conectar (WebSocket,
 *    o una línea JSON por Serial en modo USB) tomándolos del bloque <PROTOCOL> del
 *    .adx, y este firmware confirma lo que aplicó. Las constantes ALDL_FRAME_BYTES y
 *    ALDL_PROM_ID_* quedan como valores por defecto (el Sonoma), así que con una web
 *    v1 - que no manda nada - se comporta igual que antes. Ver "PERFIL DE PROTOCOLO".
 *    Compila con el core ESP8266 3.1.2 + ArduinoJson 7.4.3 + ESPAsyncWebServer 3.1.0 y su
 *    lógica se probó en el host, pero NUNCA se ha probado contra hardware.
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
#define FW_VERSION "2.0.0-alpha.1" // se anuncia en el "hello" y al arrancar; la web lo muestra
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
#define ALDL_MAX_FRAME_BYTES 64 // tope del largo de frame que se puede pedir con un perfil (buffer de lectura)

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

// Qué protocolo fija el perfil que manda la web: AUTO = probar 160 y alternar a 8192 (lo que
// hacía v1); 160 u 8192 = quedarse en ese y no alternar.
enum ProfileBaud { PBAUD_AUTO, PBAUD_160, PBAUD_8192 };

// Perfil de protocolo: lo que en v1 eran solo constantes compiladas. Ver "PERFIL DE PROTOCOLO".
struct AldlProfile {
  ProfileBaud baud;
  uint8_t frameBytes;   // bytes de payload tras el SYNC (solo 160 baud)
  uint8_t promIdIndex;  // en qué byte del frame empieza el PROM ID (0-based)
  uint8_t promIdLen;    // 0 = no validar PROM ID
  uint8_t promId[4];
};

// ---------- ESTADO GLOBAL ----------
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

static_assert(ALDL_8192_MAX_FRAME <= ALDL_MAX_FRAME_BYTES, "frameBuf debe caber un frame de 8192 baud");
uint8_t frameBuf[ALDL_MAX_FRAME_BYTES];
volatile bool frameReady = false;

AldlProtocol currentProtocol = PROTO_160; // arrancamos asumiendo 160 baud (protocolo confirmado del Sonoma)
uint8_t protocolFailures = 0;

// Perfil vigente: arranca con las constantes del Sonoma, o sea lo mismo que v1.
AldlProfile aldlProfile = {PBAUD_AUTO, ALDL_FRAME_BYTES, 1, 2, {ALDL_PROM_ID_HI, ALDL_PROM_ID_LO, 0, 0}};
AldlProfile pendingAldlProfile;
volatile bool profilePending = false;

// ---------- PERFIL DE PROTOCOLO (v2) ----------
// Mensajes JSON, una línea por Serial (USB) o un mensaje de texto por WebSocket:
//   web -> {"cmd":"hello"}
//   fw  -> {"hello":{"fw":"2.0.0-alpha.1","caps":["profile"]}}   (también al conectar un cliente WS y al arrancar)
//   web -> {"cmd":"profile","baud":"160","frameBytes":20,"promIdIndex":1,"promId":[2,39]}
//   fw  -> {"profile":{...lo que aplicó...}}   o   {"profileError":"motivo"}
// El perfil NO se aplica en el momento en que llega: el callback de WebSocket puede correr en
// medio de una lectura (yield() dentro de readAldlBit160) y cambiar el largo de frame a mitad de
// captura corrompería el frame. Se deja pendiente y loop() lo aplica entre frames. Consecuencia:
// la confirmación puede tardar hasta ~3 s con la llave apagada (lo que tarda en volver de una
// lectura sin señal); la web espera hasta 6 s antes de avisar que no la recibió.
// (Las funciones de esta sección no reciben AldlProfile por parámetro a propósito: el generador
// de prototipos de Arduino suele colocarlos antes de la definición del struct y falla al compilar.)

String buildHelloJson() {
  StaticJsonDocument<192> doc;
  JsonObject hello = doc.createNestedObject("hello");
  hello["fw"] = FW_VERSION;
  JsonArray caps = hello.createNestedArray("caps");
  caps.add("profile");
  String out;
  serializeJson(doc, out);
  return out;
}

// Serializa el perfil VIGENTE (aldlProfile), que es lo que se manda de vuelta como confirmación.
String buildProfileJson() {
  StaticJsonDocument<384> doc;
  JsonObject p = doc.createNestedObject("profile");
  p["baud"] = aldlProfile.baud == PBAUD_160 ? "160" : (aldlProfile.baud == PBAUD_8192 ? "8192" : "auto");
  p["frameBytes"] = aldlProfile.frameBytes;
  p["promIdIndex"] = aldlProfile.promIdIndex;
  JsonArray promId = p.createNestedArray("promId");
  for (uint8_t i = 0; i < aldlProfile.promIdLen; i++) promId.add(aldlProfile.promId[i]);
  String out;
  serializeJson(doc, out);
  return out;
}

String buildProfileErrorJson(const char* msg) {
  StaticJsonDocument<192> doc;
  doc["profileError"] = msg;
  String out;
  serializeJson(doc, out);
  return out;
}

// A todos los clientes WebSocket y por Serial: el perfil aplicado no está atado al transporte
// por el que se pidió (loop() no sabe quién lo mandó).
void announce(const String& json) {
  ws.textAll(json);
  Serial.println(json);
}

// Responde solo a quien preguntó: al cliente WS que mandó el comando, o por Serial si vino de ahí (client == nullptr).
void replyControl(AsyncWebSocketClient* client, const String& json) {
  if (client) client->text(json);
  else Serial.println(json);
}

// Valida el comando "profile" y lo deja en pendingAldlProfile. Los mismos límites que valida la
// web (protocol-profile.js): aquí se repiten por si llega algo que no salió de la web.
bool parseProfileCommand(JsonDocument& doc, const char*& err) {
  AldlProfile p;
  memset(&p, 0, sizeof(p));

  const char* baud = doc["baud"] | "auto";
  if (strcmp(baud, "160") == 0) p.baud = PBAUD_160;
  else if (strcmp(baud, "8192") == 0) p.baud = PBAUD_8192;
  else if (strcmp(baud, "auto") == 0) p.baud = PBAUD_AUTO;
  else { err = "baud no valido (160, 8192 o auto)"; return false; }

  int frameBytes = doc["frameBytes"] | 0;
  if (frameBytes < 1 || frameBytes > ALDL_MAX_FRAME_BYTES) { err = "frameBytes fuera de rango (1 a 64)"; return false; }
  p.frameBytes = (uint8_t)frameBytes;

  JsonArray promId = doc["promId"];
  size_t n = promId.size();
  if (n > sizeof(p.promId)) { err = "promId demasiado largo (maximo 4 bytes)"; return false; }
  int index = doc["promIdIndex"] | 0;
  if (n > 0 && (index < 0 || index + (int)n > frameBytes)) { err = "promId se sale del frame"; return false; }
  p.promIdIndex = (uint8_t)(n > 0 ? index : 0);
  p.promIdLen = (uint8_t)n;

  size_t i = 0;
  for (JsonVariant v : promId) {
    int b = v | -1;
    if (b < 0 || b > 255) { err = "promId: cada byte debe estar entre 0 y 255"; return false; }
    p.promId[i++] = (uint8_t)b;
  }

  pendingAldlProfile = p;
  return true;
}

// client: quien mandó el comando (WebSocket), o nullptr si vino por Serial.
void handleCommand(const char* text, size_t len, AsyncWebSocketClient* client) {
  StaticJsonDocument<384> doc;
  if (deserializeJson(doc, text, len)) return; // JSON ilegible: se ignora, como hacía v1 con todo lo que le llegaba

  const char* cmd = doc["cmd"] | "";
  if (strcmp(cmd, "hello") == 0) {
    replyControl(client, buildHelloJson());
  } else if (strcmp(cmd, "profile") == 0) {
    const char* err = nullptr;
    if (parseProfileCommand(doc, err)) profilePending = true; // se aplica en loop(), entre frames
    else replyControl(client, buildProfileErrorJson(err));
  }
}

// Lee comandos por Serial (una línea JSON que empieza con "{"). No bloquea: solo consume lo
// que ya llegó al buffer; loop() la llama una vez por vuelta.
void pollSerialCommands() {
  static char line[256];
  static size_t n = 0;
  static bool overflow = false;
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (!overflow && n > 0 && line[0] == '{') handleCommand(line, n, nullptr);
      n = 0;
      overflow = false;
    } else if (n < sizeof(line)) {
      line[n++] = c;
    } else {
      overflow = true; // línea demasiado larga: se descarta hasta el próximo salto de línea
    }
  }
}

void applyPendingProfile() {
  aldlProfile = pendingAldlProfile;
  profilePending = false;
  if (aldlProfile.baud == PBAUD_160) currentProtocol = PROTO_160;
  else if (aldlProfile.baud == PBAUD_8192) currentProtocol = PROTO_8192;
  protocolFailures = 0;
  Serial.printf("Perfil aplicado: %u bytes por frame, PROM ID de %u byte(s)\n",
                (unsigned)aldlProfile.frameBytes, (unsigned)aldlProfile.promIdLen);
  announce(buildProfileJson());
}

// ¿El PROM ID del perfil vigente calza en este frame? Sin PROM ID en el perfil (largo 0) no se filtra nada.
bool promIdMatches(const uint8_t* buf) {
  for (uint8_t i = 0; i < aldlProfile.promIdLen; i++) {
    if (buf[aldlProfile.promIdIndex + i] != aldlProfile.promId[i]) return false;
  }
  return true;
}

// ---------- WIFI + WEBSOCKET ----------
void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
               AwsEventType type, void* arg, uint8_t* data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    Serial.printf("Cliente WS conectado: %s\n", client->remoteIP().toString().c_str());
    client->text(buildHelloJson()); // directo al cliente nuevo: textAll() puede no incluirlo todavía dentro de este evento
  } else if (type == WS_EVT_DISCONNECT) {
    Serial.println("Cliente WS desconectado");
  } else if (type == WS_EVT_DATA) {
    // Solo mensajes de texto completos en un único fragmento; los comandos son cortos.
    AwsFrameInfo* info = (AwsFrameInfo*)arg;
    if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
      handleCommand((const char*)data, len, client);
    }
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
  // Capacidad calculada para ALDL_MAX_FRAME_BYTES elementos + el objeto de 3 campos (con los 512
  // fijos de v1 un frame de más de ~28 bytes perdía el final en silencio). Con las macros de la
  // librería, y no un número a ojo, alcanza en cualquier plataforma. static: no carga el stack.
  static StaticJsonDocument<JSON_OBJECT_SIZE(3) + JSON_ARRAY_SIZE(ALDL_MAX_FRAME_BYTES)> doc;
  doc.clear();
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
  uint16_t shiftReg = 0;
  unsigned long huntStart = millis();
  while (true) {
    if (millis() - huntStart > 3000) return false; // no se encontró sync a tiempo

    int bit = readAldlBit160(2000000UL);
    if (bit < 0) return false; // bus inactivo

    shiftReg = ((shiftReg << 1) | bit) & ALDL_SYNC;
    if (shiftReg == ALDL_SYNC) break;
  }

  // Fase 2: ya alineados justo después de un SYNC real - ahora sí se capturan
  // los frameLen bytes del mensaje.
  int bitCount = 0;
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
      bitCount = 0; // resync de emergencia si aparece otro sync a mitad de frame
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
  Serial.println();
  Serial.println("RT-Web firmware " FW_VERSION);
  pinMode(ALDL_PIN, INPUT);

  setupWifi();

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send(200, "text/plain", "RT-Web bridge activo. Conecta la web app via WebSocket a /ws");
  });

  server.begin();
  Serial.println("Servidor listo.");
  Serial.println(buildHelloJson()); // por USB la placa suele reiniciarse al abrir el puerto: así la web lo ve al volver
}

// Cuenta un intento fallido del protocolo actual y, tras
// ALDL_PROTO_FAILURES_BEFORE_SWITCH seguidos, prueba el otro. Así el
// firmware no necesita saber de antemano si el ECU conectado habla 160 u
// 8192 baud - lo descubre solo, alternando hasta que uno sincroniza.
void handleProtocolFailure() {
  protocolFailures++;

  static unsigned long lastNoDataLog = 0;
  if (millis() - lastNoDataLog > 2000) {
    if (aldlProfile.baud == PBAUD_AUTO) {
      Serial.printf(
          "Sin datos ALDL en modo %s (intento %u/%u antes de probar el otro protocolo) - normal si la "
          "llave no esta en ON o el pin no es el correcto\n",
          currentProtocol == PROTO_160 ? "160 baud" : "8192 baud", protocolFailures, ALDL_PROTO_FAILURES_BEFORE_SWITCH);
    } else {
      Serial.printf(
          "Sin datos ALDL en modo %s (protocolo fijado por el perfil) - normal si la llave no esta en ON "
          "o el pin no es el correcto\n",
          currentProtocol == PROTO_160 ? "160 baud" : "8192 baud");
    }
    lastNoDataLog = millis();
  }

  // Con el baud fijado por un perfil no se alterna: el ECU ya se sabe de qué velocidad es.
  if (aldlProfile.baud == PBAUD_AUTO && protocolFailures >= ALDL_PROTO_FAILURES_BEFORE_SWITCH) {
    currentProtocol = (currentProtocol == PROTO_160) ? PROTO_8192 : PROTO_160;
    protocolFailures = 0;
    Serial.printf("Cambiando a modo %s...\n", currentProtocol == PROTO_160 ? "160 baud" : "8192 baud");
  }
}

void loop() {
  ws.cleanupClients();
  pollSerialCommands();
  if (profilePending) applyPendingProfile(); // entre frames, nunca a mitad de una lectura

  if (currentProtocol == PROTO_160) {
    if (readAldlFrame160(frameBuf, aldlProfile.frameBytes)) {
      protocolFailures = 0;
      // El cazador de SYNC a veces engancha un falso positivo (ruido) y captura
      // bytes que no arrancan en el lugar correcto. El PROM ID es constante
      // en un frame bien alineado - si no calza, se descarta en vez de mandar
      // basura a la web app (esto es lo que causaba "80mph"/"13000rpm" con el
      // motor prendido: frames de otro alineamiento, no ruido bit a bit).
      // Posición y valor salen del perfil (por defecto, los del Sonoma: bytes 1-2 = 02 27).
      if (!promIdMatches(frameBuf)) {
        Serial.println("Frame descartado (PROM ID no calza - desincronizado)");
        return;
      }
      logFrameHex("Frame ALDL (160 baud): ", frameBuf, aldlProfile.frameBytes);
      broadcastFrame(frameBuf, aldlProfile.frameBytes, "160");
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
