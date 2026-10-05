/**
 * Pruebas del decodificado de un parámetro ADX contra frames ALDL REALES del
 * GMC Sonoma (ECM 1228062, definición A040), sacados de
 * rtweb-log-2026-09-22T23-56-37-967Z.csv.
 *
 * No se prueba parseADX() aquí: usa DOMParser, que es del navegador. Lo que
 * se prueba es ParsedParameter, que es donde vive la lógica de extraer bytes,
 * bits y signo del frame.
 *
 * Correr con:  node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ParsedParameter } from "../src/xdf-parser.js";

const hex = (s) => s.split(" ").map((b) => parseInt(b, 16));

// Ralentí, motor caliente, A/C prendido. La app mostró 800 RPM y 13.6 V.
// idx14 = 0x41 -> lazo ABIERTO, mezcla rica.  idx16 = 0x07 -> A/C pedido.
const RALENTI = hex("04 02 27 38 33 00 68 20 19 80 af 00 00 00 41 88 07 03 8e f7");
// Rodando. idx14 = 0x83 -> lazo CERRADO, mezcla pobre.  idx16 = 0x06.
const RODANDO = hex("04 02 27 46 33 0a 95 2a 26 84 4e 00 00 00 83 8a 06 1d 8c 72");

const param = (extra) => new ParsedParameter({ id: "p", name: "P", units: "", equation: "X", ...extra });

test("valor numérico de 1 byte con ecuación (RPM y batería del log real)", () => {
  const rpm = param({ byteIndex: 7, byteLength: 1, equation: "X*25" });
  assert.equal(rpm.read(RALENTI), 800); // el CSV registró 800 RPM en este frame
  assert.equal(rpm.read(RODANDO), 1050);

  const batt = param({ byteIndex: 15, byteLength: 1, equation: "X*0.1" });
  assert.equal(batt.read(RALENTI).toFixed(1), "13.6"); // el CSV registró 13.6 V
});

test("16 bits big-endian: el PROM ID constante del 1228062", () => {
  const promId = param({ byteIndex: 1, byteLength: 2, equation: "X" });
  assert.equal(promId.read(RALENTI), 0x0227);
  assert.equal(promId.read(RODANDO), 0x0227); // constante: es lo que valida el alineamiento
  assert.equal(promId.isFlag, false);
});

test("complemento a dos, en 8 y en 16 bits", () => {
  const s8 = param({ byteIndex: 0, byteLength: 1, signed: true });
  assert.equal(s8.readRaw(hex("80")), -128);
  assert.equal(s8.readRaw(hex("ff")), -1);
  assert.equal(s8.readRaw(hex("7f")), 127);

  const s16 = param({ byteIndex: 0, byteLength: 2, signed: true });
  assert.equal(s16.readRaw(hex("ff ff")), -1);
  assert.equal(s16.readRaw(hex("80 00")), -32768);
  assert.equal(s16.readRaw(hex("7f ff")), 32767);

  // sin signed, los mismos bytes son positivos
  assert.equal(param({ byteIndex: 0, byteLength: 2 }).readRaw(hex("ff ff")), 65535);
});

test("bandera de 1 bit: lazo abierto/cerrado (idx 14 b7)", () => {
  const loop = param({ name: "Lazo", byteIndex: 14, bit: 7, trueLabel: "Cerrado", falseLabel: "Abierto" });
  assert.equal(loop.isFlag, true);

  assert.equal(loop.readFlag(RALENTI), false); // 0x41: ralentí -> lazo ABIERTO
  assert.equal(loop.read(RALENTI), 0); // se guarda como 0/1, no como texto
  assert.equal(loop.format(loop.read(RALENTI)), "Abierto");

  assert.equal(loop.readFlag(RODANDO), true); // 0x83: rodando -> lazo CERRADO
  assert.equal(loop.read(RODANDO), 1);
  assert.equal(loop.format(loop.read(RODANDO)), "Cerrado");
});

test("bandera invertida: A/C Request es activo en bajo (idx 16 b7)", () => {
  const ac = param({ byteIndex: 16, bit: 7, invert: true, trueLabel: "Si", falseLabel: "No" });
  // En los dos frames el bit 7 está en 0, y el usuario tenía el A/C prendido.
  assert.equal(ac.readFlag(RALENTI), true);
  assert.equal(ac.readFlag(RODANDO), true);

  // El mismo bit en 1 (0x83) = A/C NO pedido.
  const sinAc = RALENTI.slice();
  sinAc[16] = 0x83;
  assert.equal(ac.readFlag(sinAc), false);

  // Sin invert, el mismo byte da lo contrario: confirma que invert hace algo.
  const crudo = param({ byteIndex: 16, bit: 7 });
  assert.equal(crudo.readFlag(RALENTI), false);
});

test("todos los bits de idx 14 y 16 del frame de ralentí", () => {
  const bitsDe = (idx, bit, extra = {}) => param({ byteIndex: idx, bit, ...extra }).readFlag(RALENTI);
  // idx14 = 0x41 = 0100 0001
  assert.equal(bitsDe(14, 7), false); // lazo abierto
  assert.equal(bitsDe(14, 6), true); // mezcla rica
  assert.equal(bitsDe(14, 4), false); // inyección asíncrona no
  assert.equal(bitsDe(14, 1), false); // BLM deshabilitado
  assert.equal(bitsDe(14, 0, { invert: true }), false); // "Open Loop Idle": bit 1 = NO
  // idx16 = 0x07 = 0000 0111
  assert.equal(bitsDe(16, 4), false); // no está en P/N
  assert.equal(bitsDe(16, 3), false); // TCC suelto
  assert.equal(bitsDe(16, 2), true); // embrague del compresor enganchado
  assert.equal(bitsDe(16, 1), true); // AIR desviado
  assert.equal(bitsDe(16, 0), true); // AIR al escape
  // idx0 = 0x04 -> pulso de referencia presente (motor girando)
  assert.equal(bitsDe(0, 2), true);
});

test("sin códigos de falla guardados (bytes 11-13 en 0x00)", () => {
  for (const [idx, bit] of [[11, 6], [13, 6], [13, 5]]) {
    assert.equal(param({ byteIndex: idx, bit }).readFlag(RALENTI), false);
  }
  // Y con el bit puesto a mano sí se ve la falla: la bandera no está muerta.
  const con44 = RALENTI.slice();
  con44[13] = 0x40;
  assert.equal(param({ byteIndex: 13, bit: 6 }).readFlag(con44), true);
});

test("un frame más corto de lo que pide el parámetro devuelve null, no 0", () => {
  const corto = hex("04 02 27");
  assert.equal(param({ byteIndex: 14, bit: 7 }).read(corto), null);
  assert.equal(param({ byteIndex: 7, byteLength: 1, equation: "X*25" }).read(corto), null);
  // 16 bits que se sale por el último byte: también null
  assert.equal(param({ byteIndex: 2, byteLength: 2 }).read(corto), null);
  assert.equal(param({ byteIndex: 1, byteLength: 2 }).read(corto), 0x0227); // este sí cabe
});

test("format() deja los números como estaban y solo cambia las banderas", () => {
  const num = param({ byteIndex: 7, byteLength: 1, equation: "X*25" });
  assert.equal(num.format(800), "800.00");
  assert.equal(num.format(800, 1), "800.0");
  assert.equal(num.format(null), "--");
  assert.equal(num.format(undefined), "--");

  const flag = param({ byteIndex: 14, bit: 7, trueLabel: "Cerrado", falseLabel: "Abierto" });
  assert.equal(flag.format(1), "Cerrado");
  assert.equal(flag.format(0), "Abierto");
  assert.equal(flag.format(null), "--");
});

test("un bit fuera de 0..7 no convierte el parámetro en bandera", () => {
  assert.equal(param({ byteIndex: 0, bit: 8 }).isFlag, false);
  assert.equal(param({ byteIndex: 0, bit: -1 }).isFlag, false);
  assert.equal(param({ byteIndex: 0, bit: null }).isFlag, false);
  // sin `bit`, se comporta como siempre: valor numérico del byte
  assert.equal(param({ byteIndex: 14, equation: "X" }).read(RALENTI), 0x41);
});
