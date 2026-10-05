/**
 * Pruebas de la simulación del chip (prom-sim.js) con tablas y constantes de
 * mentira que imitan las del 4E.xdf: interpolación, EGR con histéresis, tope
 * de avance, RPM objetivo con A/C y conversión del MAP.
 *
 * Correr con:  node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSparkModel, simulateLog, lookupTable, nearestCell, mapVoltsToKpa } from "../src/prom-sim.js";

/** Tabla falsa con la misma interfaz que ParsedTable: valores fijos, sin bin de verdad. */
function fakeTable(name, yAxis, xAxis, grid) {
  return {
    name,
    rows: yAxis.length,
    cols: xAxis.length,
    yAxis,
    xAxis,
    valueAt: (r, c, bin) => (bin ? grid[r][c] : null),
  };
}
const fakeConst = (name, v) => ({ name, value: (bin) => (bin ? v : null) });

const BIN = new Uint8Array(4096); // solo tiene que existir: los valores salen de los fakes

function fakeXdf({ egrOnMph = 6 } = {}) {
  return {
    tables: [
      fakeTable("Main Spark Advance", [800, 1600], [30, 90], [
        [25, 5],
        [35, 15],
      ]),
      fakeTable("Coolant Temp Compensation", [41, 239], [60, 100], [
        [0, 0],
        [0, 0],
      ]),
      fakeTable("EGR Duty Cycle", [800, 1000, 1600], [40, 90], [
        [0, 0],
        [30, 60],
        [30, 60],
      ]),
      fakeTable("EGR Spark Advance Correction", [0, 25, 100], [0], [[0], [10], [10]]),
    ],
    constants: [
      fakeConst("Spark Added for EGR On", 3),
      fakeConst("Maximum Spark Advance", 40),
      fakeConst("MPH Above which EGR is Enabled", egrOnMph),
      fakeConst("MPH Under which EGR is Disabled", 4),
      fakeConst("TPS Above which EGR is Enabled", 4),
      fakeConst("TPS Under which EGR is Disabled", 2),
      fakeConst("Minimum Coolant Temp for EGR", 95),
      fakeConst("Target Idle Speed A/C On", 900),
      fakeConst("Target Idle Speed A/C Off", 800),
    ],
  };
}

test("conversión del MAP: llave en ON a ~990 m (4.3 V) da ~91 kPa", () => {
  assert.ok(Math.abs(mapVoltsToKpa(4.3) - 91.3) < 0.5);
  assert.ok(Math.abs(mapVoltsToKpa(1.29) - 34.6) < 0.5);
});

test("interpolación bilineal, recortada a los extremos de los ejes", () => {
  const t = fakeXdf().tables[0];
  assert.equal(lookupTable(t, BIN, 800, 30), 25);
  assert.equal(lookupTable(t, BIN, 1200, 60), 20); // centro: promedio de las cuatro esquinas
  assert.equal(lookupTable(t, BIN, 5000, 10), 35); // fuera de rango: se queda en la orilla
  assert.equal(lookupTable(t, null, 800, 30), null);
  assert.deepEqual(nearestCell(t, 1500, 80), { row: 1, col: 1 });
});

test("tabla de una columna se lee solo por fila", () => {
  const corr = fakeXdf().tables[3];
  assert.equal(lookupTable(corr, BIN, 12.5), 5);
  assert.equal(lookupTable(corr, BIN, 60), 10);
});

test("modelo incompleto: avisa qué falta", () => {
  const m = buildSparkModel({ tables: [], constants: [] });
  assert.equal(m.supported, false);
  assert.ok(m.missing.includes("Main Spark Advance"));
});

const at = (o) => ({ rpm: 1600, mapV: 4.3, coolantC: 90, mph: 50, tpsV: 1.5, acRequested: false, ...o });

test("el EGR agrega avance rodando con carga, y el tope de avance lo recorta", () => {
  const m = buildSparkModel(fakeXdf());
  const [r] = simulateLog(m, BIN, [at({})], { tpsClosedV: 0.5 });
  assert.equal(r.egrActive, true);
  assert.equal(r.egrSpark, 13); // 3 de "EGR On" + 10 de la corrección (ciclo ≥25 %)
  assert.ok(r.main < 20);
  assert.equal(r.total, r.main + 13);

  const [lugging] = simulateLog(m, BIN, [at({ mapV: 2.0 })], { tpsClosedV: 0.5 });
  assert.equal(lugging.total, 40); // 30-35° de tabla + 13 de EGR, recortado a 40
});

test("EGR cancelado (umbral de MPH imposible): mismo cuadro sin avance extra", () => {
  const m = buildSparkModel(fakeXdf({ egrOnMph: 255 }));
  const [r] = simulateLog(m, BIN, [at({})], { tpsClosedV: 0.5 });
  assert.equal(r.egrActive, false);
  assert.equal(r.egrSpark, 0);
});

test("histéresis del EGR: se prende arriba de 6 MPH y no se apaga hasta bajar de 4", () => {
  const m = buildSparkModel(fakeXdf());
  const out = simulateLog(m, BIN, [at({ mph: 5 }), at({ mph: 7 }), at({ mph: 5 }), at({ mph: 3 })], { tpsClosedV: 0.5 });
  assert.deepEqual(
    out.map((r) => r.egrActive),
    [false, true, true, false]
  );
});

test("motor parado = sin cuadro; ralentí sin EGR; objetivo de ralentí según el A/C", () => {
  const m = buildSparkModel(fakeXdf());
  const out = simulateLog(
    m,
    BIN,
    [at({ rpm: 0 }), at({ rpm: 800, mapV: 1.3, mph: 0, tpsV: 0.5, acRequested: true }), at({ rpm: 800, mapV: 1.3, mph: 0, tpsV: 0.5 })],
    { tpsClosedV: 0.5 }
  );
  assert.equal(out[0], null);
  assert.equal(out[1].egrActive, false);
  assert.equal(out[1].idleTarget, 900);
  assert.equal(out[2].idleTarget, 800);
});
