/**
 * Pruebas de src/frame-check.js con los frames corruptos REALES que se
 * encontraron en los logs del Sonoma (2026-09-22 al 28) y los mismos umbrales
 * que declara defs/gmc_sonoma_1993_a040.adx.
 *
 * Correr con:  node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ParsedParameter } from "../src/xdf-parser.js";
import { checkFrames } from "../src/frame-check.js";

const hex = (s) => s.split(" ").map((b) => parseInt(b, 16));
const P = (extra) => new ParsedParameter({ units: "", equation: "X", byteLength: 1, ...extra });

// Los mismos atributos que el .adx del Sonoma
const PARAMS = [
  P({ id: "rpm", name: "RPM", byteIndex: 7, equation: "X*25", validMax: 6000 }),
  P({ id: "speed", name: "Velocidad", byteIndex: 5, validMax: 120, spike: 15 }),
  P({ id: "blm", name: "BLM", byteIndex: 18, validMin: 80, validMax: 200 }),
  P({ id: "knock", name: "Detonacion", byteIndex: 17, monotonic: true }),
  P({ id: "batt", name: "Bateria", byteIndex: 15, equation: "X*0.1", validMin: 6, validMax: 17 }),
  P({ id: "code_44", name: "Codigo 44", byteIndex: 13, bit: 6, spike: 0.5 }),
  P({ id: "prom_id", name: "PROM ID", byteIndex: 1, byteLength: 2, validMin: 551, validMax: 551 }),
];

const decode = (raw) => Object.fromEntries(PARAMS.map((p) => [p.id, p.read(hex(raw))]));
const check = (...raws) => checkFrames(PARAMS, raws.map(decode));

test("VSS 211 entre dos frames en 0 (log 2026-09-28T01-30-21, fila 188)", () => {
  const r = check(
    "04 02 27 36 37 00 61 22 19 80 c1 00 01 00 41 88 07 05 7c 41",
    "00 02 27 64 36 d3 84 31 19 80 cf 00 01 00 c3 78 02 06 80 01",
    "04 02 27 31 36 00 4d 2f 1a 80 c1 00 01 00 c3 86 02 06 80 01"
  );
  assert.deepEqual([r[0], r[2]], ["", ""]);
  assert.match(r[1], /Velocidad 211 imposible/);
});

test("bit perdido: BLM 240 y detonación x2 (log 2026-09-28T01-30-21, fila 382)", () => {
  const r = check(
    "04 02 27 48 2f 2a 44 38 1a 80 8b 00 01 00 c3 88 06 18 78 c1",
    "04 02 27 48 2f 26 34 44 1a 7c 9e 00 01 00 c3 85 06 30 f0 a9",
    "04 02 27 48 2f 21 3d 3b 1a 7f 0e 00 01 00 83 88 06 18 77 e1"
  );
  assert.equal(r[0], "");
  assert.match(r[1], /BLM 240 imposible/);
  assert.match(r[1], /Detonacion 24→48→24/);
  assert.equal(r[2], "");
});

test("frame de apagado de llave: batería 0 V", () => {
  const r = check(
    "00 02 27 19 30 00 db 22 19 80 03 00 01 00 05 00 f0 63 8c e2",
    "00 02 27 64 31 00 dc 00 19 80 02 00 01 00 00 00 f0 00 80 00"
  );
  assert.match(r[0], /Bateria 0 imposible/);
  assert.match(r[1], /Bateria 0 imposible/);
});

test("datos buenos no se marcan: ralentí, rodando, arranque con batería baja, detonación que sube de verdad", () => {
  const r = check(
    "04 02 27 38 33 00 68 20 19 80 af 00 00 00 41 88 07 03 8e f7", // ralentí
    "04 02 27 46 33 0a 95 2a 26 84 4e 00 00 00 83 8a 06 1d 8c 72", // rodando a 10 MPH
    "04 02 27 46 33 12 95 2a 26 84 4e 00 00 00 83 55 06 1e 8c 72", // 18 MPH, batería 8.5 V, detonación +1
    "04 02 27 46 33 19 95 2a 26 84 4e 00 00 00 83 8a 06 28 8c 72" //  25 MPH, detonación +10 y se queda
  );
  assert.deepEqual(r, ["", "", "", ""]);
});

test("el contador de detonación que se reinicia con la llave no es basura", () => {
  const f = (k) => `04 02 27 38 33 00 68 20 19 80 af 00 00 00 41 88 07 ${k} 8e f7`;
  assert.deepEqual(check(f("20"), f("0b"), f("0b"), f("0c")), ["", "", "", ""]);
});

test("un código que aparece y desaparece en un solo frame", () => {
  const f = (b13) => `04 02 27 38 33 00 68 20 19 80 af 00 00 ${b13} 41 88 07 03 8e f7`;
  const r = check(f("00"), f("40"), f("00"));
  assert.match(r[1], /Codigo 44 salto aislado/);
  // un código que se queda puesto sí es real
  assert.deepEqual(check(f("00"), f("40"), f("40")), ["", "", ""]);
});

test("PROM ID distinto de 551", () => {
  const r = check("04 02 28 38 33 00 68 20 19 80 af 00 00 00 41 88 07 03 8e f7");
  assert.match(r[0], /PROM ID 552 imposible/);
});
