// Prueba en la computadora de firmware/esp8266_aldl_bridge/aldl_decoder.h.
//
// Genera la señal que manda la ECM 1228062 (SYNC de diez unos + 20 bytes de
// [0 de arranque][8 bits], celdas de ~6.25 ms, pulso bajo de 368 us = 0 y de
// 4400 us = 1, mensajes pegados sin pausa) con frames REALES del Sonoma, y le
// pasa los flancos al decodificador como lo haría el loop del ESP8266:
// vaciando el buffer a ratos (cada 0.1-30 ms) y llamando aldlTick(now).
//
// Correr:
//   clang++ -std=c++11 -O2 -Wall -o /tmp/aldl_test test/firmware/aldl_decoder_test.cpp && /tmp/aldl_test
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <algorithm>
#include "../../firmware/esp8266_aldl_bridge/aldl_decoder.h"

// Horas en 64 bits para generar y ordenar; al decodificador le llegan los 32
// bits bajos, como micros() en el ESP8266 (que se desborda cada ~71 min).
struct Edge {
  uint64_t t;
  bool low;
};

static const uint8_t RALENTI[20] = {0x04, 0x02, 0x27, 0x38, 0x33, 0x00, 0x68, 0x20, 0x19, 0x80,
                                    0xaf, 0x00, 0x00, 0x00, 0x41, 0x88, 0x07, 0x03, 0x8e, 0xf7};
static const uint8_t RODANDO[20] = {0x04, 0x02, 0x27, 0x46, 0x33, 0x0a, 0x95, 0x2a, 0x26, 0x84,
                                    0x4e, 0x00, 0x00, 0x00, 0x83, 0x8a, 0x06, 0x1d, 0x8c, 0x72};

struct Signal {
  std::vector<Edge> edges;
  std::vector<std::vector<uint8_t>> frames; // lo que se mandó, en orden
  uint64_t t;
  double period;  // us por celda
  int jitter;     // +-us en cada flanco
};

static int rnd(int lo, int hi) { return lo + rand() % (hi - lo + 1); }

static void cell(Signal& s, int bit) {
  uint64_t start = s.t + (s.jitter ? rnd(-s.jitter, s.jitter) : 0);
  uint64_t lowLen = bit ? 4400 : 368;
  s.edges.push_back({start, true});
  s.edges.push_back({start + lowLen + (s.jitter ? rnd(-s.jitter, s.jitter) : 0), false});
  s.t += (uint64_t)s.period;
}

static void message(Signal& s, const uint8_t* bytes) {
  for (int i = 0; i < 10; i++) cell(s, 1); // el 1228062 manda DIEZ unos
  for (int b = 0; b < 20; b++) {
    cell(s, 0);
    for (int i = 7; i >= 0; i--) cell(s, (bytes[b] >> i) & 1);
  }
  s.frames.push_back(std::vector<uint8_t>(bytes, bytes + 20));
}

// Picos de ruido: bajadas cortas (5-60 us) en instantes al azar.
static void addNoise(Signal& s, int count) {
  uint64_t end = s.t;
  for (int i = 0; i < count; i++) {
    uint64_t at = (uint64_t)(((double)rand() / RAND_MAX) * end);
    uint64_t len = rnd(5, 60);
    s.edges.push_back({at, true});
    s.edges.push_back({at + len, false});
  }
}

// Reconstruye el nivel real de la línea a partir de flancos superpuestos
// (señal + ruido): la línea está baja si algún pulso la tiene baja.
static std::vector<Edge> mergeLevels(const std::vector<Edge>& raw) {
  std::vector<std::pair<uint64_t, int>> ev;
  for (const Edge& e : raw) ev.push_back({e.t, e.low ? +1 : -1});
  std::sort(ev.begin(), ev.end(), [](const std::pair<uint64_t, int>& a, const std::pair<uint64_t, int>& b) {
    return a.first < b.first || (a.first == b.first && a.second > b.second);
  });
  std::vector<Edge> out;
  int depth = 0;
  for (auto& p : ev) {
    int before = depth;
    depth += p.second;
    if (depth < 0) depth = 0;
    if (before == 0 && depth > 0) out.push_back({p.first, true});
    if (before > 0 && depth == 0) out.push_back({p.first, false});
  }
  return out;
}

struct Result {
  int sent, good, badOk; // badOk = frames con PROM ID correcto pero contenido distinto
  AldlDecoder d;
};

static Result run(Signal& s, uint64_t startOffset) {
  std::vector<Edge> edges = mergeLevels(s.edges);
  AldlDecoder d;
  aldlDecoderReset(&d, 20);
  Result r = {(int)s.frames.size(), 0, 0, d};
  size_t next = 0, matched = 0;
  uint64_t now = startOffset;
  uint64_t end = s.t + 50000;
  while (now < end) {
    now += rnd(100, 30000); // el loop vacía el buffer cuando puede
    while (next < edges.size() && edges[next].t <= now) {
      aldlFeedEdge(&d, (uint32_t)edges[next].t, edges[next].low);
      next++;
      if (d.frameReady) {
        d.frameReady = false;
        bool prom = d.frame[1] == 0x02 && d.frame[2] == 0x27;
        bool found = false;
        for (size_t k = matched; k < s.frames.size(); k++) {
          if (memcmp(d.frame, s.frames[k].data(), 20) == 0) {
            found = true;
            matched = k + 1;
            break;
          }
        }
        if (found) r.good++;
        else if (prom) r.badOk++;
      }
    }
    aldlTick(&d, (uint32_t)now);
    if (d.frameReady) { // un frame que se cierra en el tick
      d.frameReady = false;
      bool prom = d.frame[1] == 0x02 && d.frame[2] == 0x27;
      bool found = false;
      for (size_t k = matched; k < s.frames.size(); k++) {
        if (memcmp(d.frame, s.frames[k].data(), 20) == 0) {
          found = true;
          matched = k + 1;
          break;
        }
      }
      if (found) r.good++;
      else if (prom) r.badOk++;
    }
  }
  r.d = d;
  return r;
}

static Signal makeSignal(int messages, double period, int jitter, uint64_t t0) {
  Signal s;
  s.t = t0;
  s.period = period;
  s.jitter = jitter;
  for (int m = 0; m < messages; m++) {
    uint8_t f[20];
    memcpy(f, (m % 3 == 0) ? RALENTI : RODANDO, 20);
    if (m % 3 == 2) f[7] = (uint8_t)rnd(0, 255), f[10] = (uint8_t)rnd(0, 255), f[17] = (uint8_t)m; // variar
    message(s, f);
  }
  return s;
}

static int failures = 0;
static void check(const char* name, bool ok, const Result& r) {
  printf("%-58s %s  enviados=%d buenos=%d basura_con_prom_ok=%d ruido=%u resync=%u inactivo=%u\n", name,
         ok ? "OK  " : "FALLA", r.sent, r.good, r.badOk, (unsigned)r.d.statGlitches, (unsigned)r.d.statResyncs,
         (unsigned)r.d.statIdleAborts);
  if (!ok) failures++;
}

int main() {
  srand(12345);

  {
    Signal s = makeSignal(50, 6250, 0, 1000);
    Result r = run(s, 0);
    check("limpia, 50 mensajes seguidos", r.good == 50 && r.badOk == 0, r);
  }
  {
    Signal s = makeSignal(50, 6150, 0, 1000);
    Result r = run(s, 0);
    check("reloj de la ECM 1.6% rápido (6150 us)", r.good == 50 && r.badOk == 0, r);
  }
  {
    Signal s = makeSignal(50, 6350, 0, 1000);
    Result r = run(s, 0);
    check("reloj de la ECM 1.6% lento (6350 us)", r.good == 50 && r.badOk == 0, r);
  }
  {
    Signal s = makeSignal(50, 6250, 80, 1000);
    Result r = run(s, 0);
    check("temblor de +-80 us en cada flanco", r.good == 50 && r.badOk == 0, r);
  }
  {
    // Arranca a mitad de un mensaje (se conecta con el motor ya hablando): se pierde solo ese.
    Signal s = makeSignal(50, 6250, 0, 1000);
    Signal cut = s;
    cut.edges.clear();
    uint64_t from = 1000 + (uint64_t)(6250 * 95);
    for (const Edge& e : s.edges)
      if (e.t >= from) cut.edges.push_back(e);
    Result r = run(cut, from);
    check("se engancha a mitad de un mensaje: pierde solo ese", r.good == 49 && r.badOk == 0, r);
  }
  {
    // Micros() se desborda a mitad del log.
    // Arranca 300 celdas antes del desborde de 32 bits: el desborde cae en el 2.o mensaje.
    uint64_t t0 = 0x100000000ull - 6250ull * 300ull;
    Signal s = makeSignal(20, 6250, 0, t0);
    Result r = run(s, t0 - 1000);
    check("desborde de micros() a mitad del log", r.good == 20 && r.badOk == 0, r);
  }
  {
    // Ruido moderado: ~2 picos por mensaje.
    Signal s = makeSignal(200, 6250, 40, 1000);
    addNoise(s, 400);
    Result r = run(s, 0);
    check("ruido moderado (~2 picos por mensaje)", r.good >= 180, r);
  }
  {
    // Ruido fuerte: ~10 picos por mensaje. No se exige casi nada: se mide cuánta basura pasa.
    Signal s = makeSignal(200, 6250, 40, 1000);
    addNoise(s, 2000);
    Result r = run(s, 0);
    check("ruido fuerte (~10 picos por mensaje), medir basura", r.good >= 100, r);
  }

  printf(failures ? "\n%d prueba(s) fallaron\n" : "\ntodas las pruebas pasaron\n", failures);
  return failures ? 1 : 0;
}
