/**
 * frame-check.js
 *
 * Marca frames ALDL corruptos o inservibles para el análisis, con reglas que
 * declara cada parámetro del .adx (validmin/validmax, spike, monotonic; ver
 * ParsedParameter). Nada de índices de bytes aquí: el mapa vive en el .adx.
 *
 * Por qué hace falta: en los logs del Sonoma (12,292 frames revisados el
 * 2026-09-28) ~0.1-0.5 % de los frames pasan la validación del PROM ID pero
 * traen algo imposible - VSS de 211 o 254 MPH entre dos frames en 0, códigos
 * de falla que aparecen y desaparecen en un frame, el contador de detonación
 * que baja y vuelve - más los frames de apagado de llave (batería en 0 V).
 * Casi siempre es UN frame aislado con vecinos sanos, así que las reglas de
 * salto miran al anterior y al siguiente.
 */

/**
 * @param params   parámetros del .adx (ParsedParameter)
 * @param frames   un objeto de valores por frame, en orden
 * @param keyOf    cómo se llama cada parámetro dentro de esos objetos (id en vivo, nombre en un CSV)
 * @returns        por frame, "" si está bien o el motivo (texto) si es sospechoso.
 *                 El último frame no tiene siguiente: solo se le aplican validmin/validmax.
 */
export function checkFrames(params, frames, keyOf = (p) => p.id) {
  const rules = params.filter((p) => p.validMin != null || p.validMax != null || p.spike != null || p.monotonic);
  return frames.map((cur, i) => {
    const prev = i > 0 ? frames[i - 1] : null;
    const next = i + 1 < frames.length ? frames[i + 1] : null;
    const reasons = [];

    for (const p of rules) {
      const k = keyOf(p);
      const v = cur[k];
      if (v === undefined || v === null || Number.isNaN(v)) continue;
      const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

      if ((p.validMin != null && v < p.validMin) || (p.validMax != null && v > p.validMax)) {
        reasons.push(`${p.name} ${fmt(v)} imposible`);
        continue;
      }
      if (!prev || !next) continue;
      const a = prev[k];
      const b = next[k];
      if (a === undefined || b === undefined || a === null || b === null) continue;

      if (p.spike != null && Math.abs(v - a) > p.spike && Math.abs(v - b) > p.spike && Math.abs(a - b) <= p.spike) {
        reasons.push(`${p.name} salto aislado ${fmt(a)}→${fmt(v)}→${fmt(b)}`);
        continue;
      }
      // Un contador sube o se queda (o se reinicia y sigue bajo). Bajar y volver, o subir y volver, es basura.
      if (p.monotonic && ((v < a && b >= a) || (v > b && b >= a && v > a))) {
        reasons.push(`${p.name} ${fmt(a)}→${fmt(v)}→${fmt(b)}`);
      }
    }
    return reasons.join("; ");
  });
}
