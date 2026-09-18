/**
 * sim-source.js
 *
 * Fuente de frames falsos para probar la UI sin el ESP8266.
 *
 * Para los byte-index que coinciden con la definición real del vehículo
 * (defs/gmc_sonoma_1993_a040.adx) genera valores dentro de rangos reales,
 * tomados de las capturas de ralentí de verdad (Downloads/todo_apagado_
 * ralenti.csv y todo_prendido_ralenti.csv): RPM ~1000, TPS fijo ~0.49V
 * (mariposa cerrada), O2 oscilando rápido en closed-loop sano, y un ciclo
 * lento simulado de A/C entrando/saliendo que sube IAC y MAP juntos (como
 * en el log real) y baja un poco la batería bajo esa carga eléctrica.
 *
 * Cualquier otro byte-index (de otra definición .adx que no sea esta) sigue
 * usando la onda seno genérica de antes, para no romper el modo simulado
 * con otros archivos.
 */

function syntheticRawByte(byteIndex, tSec, acPhase) {
  const noise = (freq, phase = 0) => Math.sin(tSec * 2 * Math.PI * freq + phase);

  switch (byteIndex) {
    case 3: // IAC steps: ~13 en ralentí normal, sube a ~45 cuando el ciclo de "A/C" entra
      return 13 + acPhase * 32 + 2 * noise(0.4, 1);
    case 4: // temperatura refrigerante (tabla NTC) - motor ya caliente, casi plano
      return 56 + 2 * noise(0.03, 2);
    case 5: // velocidad del vehículo: 0 en ralentí
      return 0;
    case 6: // MAP: sube junto con el IAC (menos vacío al dejar pasar más aire)
      return 62 + acPhase * 24 + 2 * noise(0.4, 1.5);
    case 7: // RPM ~1000, sube un poco bajo el ciclo de "A/C"
      return 40 + acPhase * 2 + noise(0.5, 0.5);
    case 8: // TPS ~0.49V fijo, mariposa cerrada en ralentí
      return 25 + noise(0.2, 3);
    case 9: // Integrator (INT)
      return 125 + 6 * noise(0.3, 4);
    case 10: // O2 mV, closed loop oscilando rápido y sano
      return 115 + 25 * noise(0.7, 0);
    case 15: // voltaje de batería: baja un poco bajo la carga eléctrica del A/C
      return 143 - acPhase * 4 + noise(0.1, 2);
    case 17: // contador de detonación, casi siempre plano
      return 10 + (noise(0.02, 0) > 0.9 ? 1 : 0);
    case 18: // Block Learn (BLM), aprende lento - casi plano
      return 124 + 3 * noise(0.05, 1);
    case 19: // transiciones rico/pobre - contador rápido tipo diente de sierra
      return (tSec * 60) % 255;
    default: {
      const speed = 0.0006 + (byteIndex % 5) * 0.00035;
      const phase = byteIndex * 1.3;
      return 128 + 120 * Math.sin(tSec * 1000 * speed + phase);
    }
  }
}

export class SimSource {
  constructor({ onFrame, intervalMs = 200 } = {}) {
    this.onFrame = onFrame || (() => {});
    this.intervalMs = intervalMs;
    this._timer = null;
    this._t0 = 0;
  }

  start(frameLength) {
    this.stop();
    this._t0 = performance.now();
    this._timer = setInterval(() => {
      const tMs = performance.now() - this._t0;
      const tSec = tMs / 1000;
      // 0..1, sube y baja lento (ciclo completo ~25s) simulando el A/C entrando y saliendo
      const acPhase = (Math.sin(tSec * 2 * Math.PI * 0.04 - Math.PI / 2) + 1) / 2;

      const raw = [];
      for (let i = 0; i < frameLength; i++) {
        const value = syntheticRawByte(i, tSec, acPhase);
        raw.push(Math.max(0, Math.min(255, Math.round(value))));
      }
      this.onFrame(raw, Math.round(tMs));
    }, this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  get running() {
    return this._timer !== null;
  }
}
