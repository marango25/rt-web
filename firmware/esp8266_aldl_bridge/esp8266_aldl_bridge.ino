/**
 * esp8266_aldl_bridge.ino
 *
 * Puente ESP8266 <-> GM ALDL (160 baud) <-> WebSocket.
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
#include "secrets.h" // copia secrets.h.example a secrets.h y pon tu WIFI_SSID/WIFI_PASS ahí (no se sube al repo)

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

// ---------- ESTADO GLOBAL ----------
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

uint8_t frameBuf[ALDL_FRAME_BYTES];
volatile bool frameReady = false;

// ---------- WIFI + WEBSOCKET ----------
void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
               AwsEventType type, void* arg, uint8_t* data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    Serial.printf("Cliente WS conectado: %s\n", client->remoteIP().toString().c_str());
  } else if (type == WS_EVT_DISCONNECT) {
    Serial.println("Cliente WS desconectado");
  }
}

void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin(MDNS_NAME)) {
    Serial.printf("mDNS activo: http://%s.local\n", MDNS_NAME);
  }
}

void broadcastFrame(uint8_t* buf, size_t len) {
  // Manda { "t": millis, "raw": [b0, b1, ...] } - el parseo/decodificación
  // real vive en la web app (usando el .adx cargado), el firmware solo
  // transporta bytes crudos.
  StaticJsonDocument<512> doc;
  doc["t"] = millis();
  JsonArray raw = doc.createNestedArray("raw");
  for (size_t i = 0; i < len; i++) raw.add(buf[i]);

  String out;
  serializeJson(doc, out);
  ws.textAll(out);
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
int readAldlBit(unsigned long idleTimeoutUs) {
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

bool readAldlFrame(uint8_t* out, size_t frameLen) {
  // Fase 1: cazar el SYNC activamente antes de guardar nada. Sin esto, cada
  // llamada empezaba a grabar desde donde cayera el primer flanco (no
  // necesariamente el inicio real de un mensaje), causando un desfase que
  // se acumulaba de a 1 byte por frame cuando los mensajes vienen seguidos
  // (poco hueco de silencio entre ellos, como con el motor encendido).
  uint16_t shiftReg = 0;
  unsigned long huntStart = millis();
  while (true) {
    if (millis() - huntStart > 3000) return false; // no se encontró sync a tiempo

    int bit = readAldlBit(2000000UL);
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

    int bit = readAldlBit((unsigned long)ALDL_BIT_US * 3);
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

void loop() {
  ws.cleanupClients();

  if (readAldlFrame(frameBuf, ALDL_FRAME_BYTES)) {
    // El cazador de SYNC a veces engancha un falso positivo (ruido) y capura
    // 21 bytes que no arrancan en el lugar correcto. El PROM ID es constante
    // en un frame bien alineado - si no calza, se descarta en vez de mandar
    // basura a la web app (esto es lo que causaba "80mph"/"13000rpm" con el
    // motor prendido: frames de otro alineamiento, no ruido bit a bit).
    if (frameBuf[1] != ALDL_PROM_ID_HI || frameBuf[2] != ALDL_PROM_ID_LO) {
      Serial.println("Frame descartado (PROM ID no calza - desincronizado)");
      return;
    }

    Serial.print("Frame ALDL: ");
    for (size_t i = 0; i < ALDL_FRAME_BYTES; i++) {
      if (frameBuf[i] < 0x10) Serial.print('0');
      Serial.print(frameBuf[i], HEX);
      Serial.print(' ');
    }
    Serial.println();
    broadcastFrame(frameBuf, ALDL_FRAME_BYTES);
  } else {
    static unsigned long lastNoDataLog = 0;
    if (millis() - lastNoDataLog > 2000) {
      Serial.println("Sin datos ALDL (timeout esperando flanco/sync - normal si la llave no esta en ON o el pin no es el correcto)");
      lastNoDataLog = millis();
    }
  }
}
