/**
 * Simulación de lo que ORDENA la ECM con un .bin dado, cuadro por cuadro,
 * sobre un log real: avance de chispa estimado, ciclo del EGR y RPM objetivo
 * de ralentí. Sirve para comparar dos versiones del chip (A = original,
 * B = modificado) sobre el mismo manejo antes de grabar nada.
 *
 * Modelo del 4E.xdf (máscara $4E, ECM 1228062), con los nombres de tabla y
 * constante tal cual vienen en ese archivo. Lo que SÍ cuenta:
 *   Main Spark Advance (RPM × kPa) + Coolant Temp Compensation (°F × kPa)
 *   + si el EGR está activo: Spark Added for EGR On + EGR Spark Advance
 *     Correction (según el ciclo estimado del EGR)
 *   tope en Maximum Spark Advance.
 * Lo que NO cuenta (no viene en el log o no está en el XDF): control de chispa
 * de ralentí, retardo por detonación, avance de carretera, transiciones. Es una
 * estimación para comparar versiones, no una medición. Tampoco predice cómo
 * responde el motor (si detona, a cuánto queda el ralentí): eso solo lo dice
 * un log después de grabar.
 *
 * El avance que ordena la ECM supone el tiempo base de fábrica (10°, "Initial
 * Advance" ≈ 9.84°). Con el distribuidor en otra base, el avance real en el
 * cigüeñal es el ordenado − (10 − base).
 */

/** MAP en voltios -> kPa, con la conversión del 4E.ads ("MAP kPa": cuenta × 0.369 + 10.354; cuenta = V / 0.0196). */
export function mapVoltsToKpa(v) {
  return (v / 0.0196) * 0.369 + 10.354;
}

const cToF = (c) => (c * 9) / 5 + 32;

const TABLES = {
  mainSpark: "Main Spark Advance",
  coolantComp: "Coolant Temp Compensation",
  egrSparkCorr: "EGR Spark Advance Correction",
  egrDc: "EGR Duty Cycle",
  egrMultCoolant: "EGR DC Multiplier vs Coolant temp",
  egrMultBaro: "EGR DC Multiplier vs Barometric vs MAP",
};

const CONSTANTS = {
  egrSparkAdd: "Spark Added for EGR On",
  maxAdvance: "Maximum Spark Advance",
  egrOnMph: "MPH Above which EGR is Enabled",
  egrOffMph: "MPH Under which EGR is Disabled",
  egrOnTps: "TPS Above which EGR is Enabled",
  egrOffTps: "TPS Under which EGR is Disabled",
  egrMinCoolantF: "Minimum Coolant Temp for EGR",
  idleAcOn: "Target Idle Speed A/C On",
  idleAcOff: "Target Idle Speed A/C Off",
};

/** Lo indispensable: sin estas, no hay estimación de avance que valga. */
const REQUIRED = ["mainSpark", "maxAdvance"];

/**
 * Busca en el .xdf parseado las tablas y constantes del modelo. Devuelve
 * { supported, missing, tables, constants }; las que falten quedan en null y
 * esa parte del modelo se omite (p. ej. sin las tablas del EGR, no se suma EGR).
 */
export function buildSparkModel(xdf) {
  const byName = (list, name) => list.find((x) => (x.name || "").trim() === name) || null;
  const tables = {};
  const constants = {};
  const missing = [];
  for (const [k, name] of Object.entries(TABLES)) {
    tables[k] = byName(xdf.tables || [], name);
    if (!tables[k]) missing.push(name);
  }
  for (const [k, name] of Object.entries(CONSTANTS)) {
    constants[k] = byName(xdf.constants || [], name);
    if (!constants[k]) missing.push(name);
  }
  const supported = REQUIRED.every((k) => tables[k] || constants[k]);
  return { supported, missing, tables, constants };
}

/** Posición fraccionaria de `v` sobre un eje creciente: { i, f } con el valor recortado a los extremos. */
function axisPos(axis, v) {
  const n = axis.length;
  if (n === 1 || v <= axis[0]) return { i: 0, f: 0 };
  if (v >= axis[n - 1]) return { i: n - 2, f: 1 };
  let i = 0;
  while (i < n - 2 && v > axis[i + 1]) i++;
  const span = axis[i + 1] - axis[i];
  return { i, f: span ? (v - axis[i]) / span : 0 };
}

/**
 * Valor interpolado de una tabla en (fila = rowVal, columna = colVal), lineal
 * en una dimensión y bilineal en dos, como interpola la ECM. Las tablas de una
 * sola columna se leen solo por fila. null si falta el bin o la tabla.
 */
export function lookupTable(t, bin, rowVal, colVal = null) {
  if (!t || !bin) return null;
  const val = (r, c) => t.valueAt(r, c, bin);
  const rp = t.rows > 1 ? axisPos(t.yAxis, rowVal) : { i: 0, f: 0 };
  const r1 = Math.min(rp.i + 1, t.rows - 1);
  if (t.cols <= 1 || colVal === null) {
    const a = val(rp.i, 0);
    const b = val(r1, 0);
    return a === null || b === null ? null : a + (b - a) * rp.f;
  }
  const cp = axisPos(t.xAxis, colVal);
  const c1 = Math.min(cp.i + 1, t.cols - 1);
  const v00 = val(rp.i, cp.i);
  const v01 = val(rp.i, c1);
  const v10 = val(r1, cp.i);
  const v11 = val(r1, c1);
  if ([v00, v01, v10, v11].some((v) => v === null)) return null;
  const top = v00 + (v01 - v00) * cp.f;
  const bottom = v10 + (v11 - v10) * cp.f;
  return top + (bottom - top) * rp.f;
}

/** Celda más cercana (fila, columna) de una tabla para un punto de operación; para contar tiempo por celda. */
export function nearestCell(t, rowVal, colVal) {
  const near = (axis, v) => {
    let best = 0;
    axis.forEach((a, i) => {
      if (Math.abs(a - v) < Math.abs(axis[best] - v)) best = i;
    });
    return best;
  };
  return { row: near(t.yAxis, rowVal), col: t.cols > 1 ? near(t.xAxis, colVal) : 0 };
}

function constValue(model, key, bin) {
  const c = model.constants[key];
  return c ? c.value(bin) : null;
}

/**
 * Simula un log entero con un bin. `samples` es un arreglo de
 * { rpm, mapV, coolantC, mph, tpsV, acRequested } (null donde no hay dato).
 * Va en orden porque el EGR tiene histéresis (se prende arriba de un umbral y
 * se apaga abajo de otro). Opciones: { baroKpa, tpsClosedV }.
 * Devuelve un arreglo paralelo de
 * { kpa, main, coolant, egrActive, egrDc, egrSpark, total, idleTarget } (null si no aplica).
 */
export function simulateLog(model, bin, samples, { baroKpa = 90, tpsClosedV = 0.49 } = {}) {
  const t = model.tables;
  const k = (key) => constValue(model, key, bin);
  const maxAdv = k("maxAdvance");
  const egrSparkAdd = k("egrSparkAdd") ?? 0;
  const egrOnMph = k("egrOnMph");
  const egrOffMph = k("egrOffMph");
  const egrOnTps = k("egrOnTps");
  const egrOffTps = k("egrOffTps");
  const egrMinF = k("egrMinCoolantF");
  const idleOn = k("idleAcOn");
  const idleOff = k("idleAcOff");
  const egrModel = t.egrDc && t.egrSparkCorr && egrOnMph !== null && egrOnTps !== null;

  let egrOn = false;
  return samples.map((s) => {
    if (s.rpm == null || s.mapV == null || s.rpm <= 0) return null;
    const kpa = mapVoltsToKpa(s.mapV);
    const coolantF = s.coolantC != null ? cToF(s.coolantC) : null;
    const main = lookupTable(t.mainSpark, bin, s.rpm, kpa);
    if (main === null) return null;
    const coolant = t.coolantComp && coolantF !== null ? lookupTable(t.coolantComp, bin, coolantF, kpa) ?? 0 : 0;

    let egrDc = 0;
    let egrSpark = 0;
    if (egrModel) {
      // TPS en %, como lo ve la ECM: abertura sobre la posición cerrada aprendida.
      const tpsPct = s.tpsV != null ? Math.max(0, ((s.tpsV - tpsClosedV) / (5 - tpsClosedV)) * 100) : 0;
      const mph = s.mph ?? 0;
      const warm = egrMinF === null || coolantF === null || coolantF >= egrMinF;
      if (!egrOn && mph > egrOnMph && tpsPct > egrOnTps && warm) egrOn = true;
      else if (egrOn && (mph < (egrOffMph ?? egrOnMph) || tpsPct < (egrOffTps ?? egrOnTps) || !warm)) egrOn = false;
      if (egrOn) {
        egrDc = lookupTable(t.egrDc, bin, s.rpm, kpa) ?? 0;
        if (t.egrMultCoolant && coolantF !== null) egrDc *= lookupTable(t.egrMultCoolant, bin, coolantF) ?? 1;
        if (t.egrMultBaro) egrDc *= lookupTable(t.egrMultBaro, bin, kpa, baroKpa) ?? 1;
        egrDc = Math.min(100, egrDc);
        if (egrDc > 0) egrSpark = egrSparkAdd + (lookupTable(t.egrSparkCorr, bin, egrDc) ?? 0);
      }
    }

    let total = main + coolant + egrSpark;
    if (maxAdv !== null) total = Math.min(total, maxAdv);
    const idleTarget = s.acRequested ? idleOn : idleOff;
    return { kpa, main, coolant, egrActive: egrOn && egrDc > 0, egrDc, egrSpark, total, idleTarget };
  });
}
