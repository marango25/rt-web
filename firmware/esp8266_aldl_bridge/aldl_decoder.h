/**
 * aldl_decoder.h - decodificador ALDL de 160 baud a partir de flancos con hora.
 *
 * Por qué existe: el lector viejo leía la línea "a mano" (esperando flancos
 * con while + yield) en el mismo hilo que imprime por Serial, arma el JSON y
 * atiende el WiFi. La ECM 1228062 manda los mensajes pegados, sin pausa
 * (10 pulsos de SYNC + 20 bytes de 9 celdas = 190 celdas * 6.25 ms = ~1.19 s),
 * y el cazador de SYNC necesita ver 9 de esos 10 unos: solo 1 pulso de
 * margen. Si procesar el frame anterior tardaba más de una celda, se perdía
 * el SYNC siguiente y con él el frame entero (los logs tenían 1 fila cada
 * 2.4-3.6 s en vez de cada 1.19 s).
 *
 * Ahora una interrupción anota cada flanco con micros() y este decodificador
 * los procesa cuando el loop puede: la hora de cada flanco no depende de lo
 * ocupado que esté el ESP8266.
 *
 * La regla de decisión de cada bit es LA MISMA del lector viejo (ya probada
 * contra el camión): el bit es 1 si la línea está en bajo en al menos 2 de 3
 * muestras tomadas a 1800/2000/2200 us del flanco de bajada que abre la
 * celda. Igual la caza del SYNC (9 unos) y el vaciado de la racha de 10.
 *
 * Sin dependencias de Arduino, para poder probarlo en la computadora
 * (ver test/firmware/aldl_decoder_test.cpp).
 */
#pragma once
#include <stdint.h>
#include <stddef.h>

#define ALDL_DEC_SAMPLE_US 2000     // muestra central tras el flanco de bajada (+-200 us las otras dos)
#define ALDL_DEC_MIN_CELL_US 5000   // una celda real dura ~6250 us: un flanco de bajada antes de esto es ruido
#define ALDL_DEC_IDLE_US 18750      // 3 celdas sin flanco = línea inactiva, se abandona el frame a medias
#define ALDL_DEC_MAX_FRAME 32

struct AldlDecoder {
  // --- configuración ---
  uint8_t frameLen;

  // --- nivel de la línea (según los flancos consumidos) ---
  bool lineLow;
  bool haveLevel;

  // --- celda en curso ---
  bool cellOpen;
  uint32_t cellStart;
  uint8_t samplesTaken;
  uint8_t lowSamples;
  uint32_t lastCellStart;
  bool haveLastCell;

  // --- armado del frame ---
  enum { HUNT, DRAIN, DATA } state;
  uint16_t shiftReg;
  uint8_t bitCount;
  uint8_t byteIdx;
  uint8_t buf[ALDL_DEC_MAX_FRAME];

  // --- salida ---
  bool frameReady;
  uint8_t frame[ALDL_DEC_MAX_FRAME];

  // --- estadísticas (para el diagnóstico por Serial) ---
  uint32_t statFrames;      // frames completos entregados
  uint32_t statGlitches;    // flancos de bajada descartados por llegar demasiado pronto (ruido)
  uint32_t statResyncs;     // SYNC a media lectura: el frame en curso se tiró y se empezó otro
  uint32_t statIdleAborts;  // frames abandonados porque la línea se quedó quieta
};

static inline void aldlDecoderReset(AldlDecoder* d, uint8_t frameLen) {
  d->frameLen = frameLen > ALDL_DEC_MAX_FRAME ? ALDL_DEC_MAX_FRAME : frameLen;
  d->lineLow = false;
  d->haveLevel = false;
  d->cellOpen = false;
  d->cellStart = 0;
  d->samplesTaken = 0;
  d->lowSamples = 0;
  d->lastCellStart = 0;
  d->haveLastCell = false;
  d->state = AldlDecoder::HUNT;
  d->shiftReg = 0;
  d->bitCount = 0;
  d->byteIdx = 0;
  d->frameReady = false;
  d->statFrames = 0;
  d->statGlitches = 0;
  d->statResyncs = 0;
  d->statIdleAborts = 0;
}

// t >= ref, tolerante al desborde de micros() (cada ~71 min)
static inline bool aldlAtOrAfter(uint32_t t, uint32_t ref) {
  return (int32_t)(t - ref) >= 0;
}

static inline void aldlStartFrame(AldlDecoder* d) {
  d->state = AldlDecoder::DATA;
  d->bitCount = 1; // el 0 que cortó la racha de unos ya es el bit de arranque del primer byte
  d->byteIdx = 0;
  d->shiftReg = 0;
}

// Un bit decodificado entra al armado del frame. Misma lógica que el lector viejo.
static inline void aldlPushBit(AldlDecoder* d, int bit) {
  const uint16_t SYNC = 0x1FF; // 9 unos seguidos: ningún dato los puede formar (cada byte lleva un 0 de arranque)
  switch (d->state) {
    case AldlDecoder::HUNT:
      d->shiftReg = ((d->shiftReg << 1) | bit) & SYNC;
      if (d->shiftReg == SYNC) d->state = AldlDecoder::DRAIN;
      break;

    case AldlDecoder::DRAIN:
      // El 1228062 manda DIEZ unos, no nueve: agotar la racha. El primer 0 es el arranque del primer byte.
      if (bit == 0) aldlStartFrame(d);
      break;

    case AldlDecoder::DATA:
      d->shiftReg = ((d->shiftReg << 1) | bit) & SYNC;
      d->bitCount++;
      if (d->shiftReg == SYNC) {
        // SYNC a media lectura = empezó otro mensaje (se perdieron bits del actual). Se tira el actual.
        d->statResyncs++;
        d->state = AldlDecoder::DRAIN;
        break;
      }
      if (d->bitCount == 9) {
        d->buf[d->byteIdx++] = d->shiftReg & 0xFF;
        d->bitCount = 0;
        if (d->byteIdx >= d->frameLen) {
          for (uint8_t i = 0; i < d->frameLen; i++) d->frame[i] = d->buf[i];
          d->frameReady = true;
          d->statFrames++;
          // Tras el último byte viene el SYNC del siguiente mensaje: a cazarlo.
          d->state = AldlDecoder::HUNT;
          d->shiftReg = 0;
        }
      }
      break;
  }
}

// Toma las muestras de la celda abierta cuyo instante ya pasó antes de `t`,
// con el nivel que tenía la línea hasta ese momento. Cierra la celda al tener las 3.
static inline void aldlTakeSamplesBefore(AldlDecoder* d, uint32_t t, bool inclusive) {
  if (!d->cellOpen) return;
  while (d->samplesTaken < 3) {
    uint32_t at = d->cellStart + (ALDL_DEC_SAMPLE_US - 200) + 200u * d->samplesTaken;
    bool due = inclusive ? aldlAtOrAfter(t, at) : (int32_t)(t - at) > 0;
    if (!due) return;
    if (d->lineLow) d->lowSamples++;
    d->samplesTaken++;
  }
  d->cellOpen = false;
  aldlPushBit(d, d->lowSamples >= 2 ? 1 : 0);
}

/** Un flanco de la línea: `t` = micros() del flanco, `low` = nivel DESPUÉS del flanco. En orden cronológico. */
static inline void aldlFeedEdge(AldlDecoder* d, uint32_t t, bool low) {
  // Las muestras pendientes que caen antes de este flanco ven el nivel anterior.
  aldlTakeSamplesBefore(d, t, false);

  bool falling = low && (!d->haveLevel || !d->lineLow);
  d->lineLow = low;
  d->haveLevel = true;
  if (!falling) return;

  if (d->haveLastCell && !aldlAtOrAfter(t, d->lastCellStart + ALDL_DEC_MIN_CELL_US)) {
    d->statGlitches++; // demasiado pronto para ser una celda nueva: ruido del motor
    return;
  }
  if (d->cellOpen) {
    // No debería pasar (las muestras terminan a 2200 us y la celda siguiente llega a >5000),
    // pero por si acaso: cerrar la anterior con lo que haya.
    aldlTakeSamplesBefore(d, t, true);
  }
  d->cellOpen = true;
  d->cellStart = t;
  d->samplesTaken = 0;
  d->lowSamples = 0;
  d->lastCellStart = t;
  d->haveLastCell = true;
}

/**
 * Avanza el reloj sin flancos nuevos (llamar en cada vuelta del loop con micros()):
 * cierra la celda si ya pasaron sus instantes de muestreo y detecta la línea inactiva.
 */
static inline void aldlTick(AldlDecoder* d, uint32_t now) {
  aldlTakeSamplesBefore(d, now, true);
  if (d->haveLastCell && !aldlAtOrAfter(d->lastCellStart + ALDL_DEC_IDLE_US, now)) {
    if (d->state != AldlDecoder::HUNT) d->statIdleAborts++;
    d->state = AldlDecoder::HUNT;
    d->shiftReg = 0;
    d->haveLastCell = false; // la próxima bajada abre celda sin chequeo de "demasiado pronto"
  }
}
