/**
 * Pruebas del parser de XDF de TEXTO viejo de TunerPro (parseLegacyXDF) y del
 * evaluador de ecuaciones. El XDF de abajo es un recorte fiel del 4E.xdf de
 * Robert Saar (máscara $4E, ECM 1228062: el del Sonoma), con las mismas
 * direcciones, ecuaciones y rarezas del original: encabezados de grupo con
 * espacios, "OB|uid" para enlazar otra constante y PopByCol.
 *
 * Correr con:  node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseXDF, detectFormat, evalEquation } from "../src/xdf-parser.js";

const XDF = `XDF
1.110000

DO NOT HAND EDIT!!!! (Trust me)

%%HEADER%%
	001005 DefTitle         ="4E"
	001010 Author           ="Robert Saar"
	001030 BinSize          =0x1000
%%END%%

%%CHECKSUM%%
	000002 UniqueID         =0x7FC
	010005 Title            ="Checksum"
	010010 DataStart        =0x4
	010015 DataEnd          =0xFFF
	010025 StoreAddr        =0x0
	010030 CalcMethod       =0x0
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x470F
	020005 Title            ="     General"
	020100 Address          =0x0
	020200 Equation         =X,TH|0|0|0|0|
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x3783
	020005 Title            ="PROM ID"
	020050 SizeInBits       =0x10
	020100 Address          =0x2
	020200 Equation         =X,TH|0|0|0|0|
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x15D9
	020005 Title            ="Coolant Table Bias"
	020100 Address          =0xD
	020200 Equation         =X*0.3515625,TH|0|0|0|0|
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x2B5
	020005 Title            ="BPW Constant for EGR Off"
	020010 Desc             ="181 for stock 4.3, 166 for stock 2.8"
	020100 Address          =0x2AE
	020200 Equation         =X,TH|0|0|0|0|
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x9999
	020005 Title            ="Firmado de prueba"
	020050 SizeInBits       =0x10
	020150 Flags            =0x1
	020100 Address          =0x10
	020200 Equation         =X,TH|0|0|0|0|
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x4AAA
	020005 Title            ="     IAC"
	020100 Address          =0x0
	020200 Equation         =X,TH|0|0|0|0|
%%END%%

%%CONSTANT%%
	000002 UniqueID         =0x2EC0
	020005 Title            ="Target Idle Speed A/C On"
	020100 Address          =0x5CD
	020200 Equation         =X*12.5,TH|0|0|0|0|
%%END%%

%%FLAG%%
	000002 UniqueID         =0x1234
	030005 Title            ="Tranny Select(X=Manual)"
	030100 Address          =0x7
	030200 BitNumber        =0x7
%%END%%

%%TABLE%%
	000002 UniqueID         =0x2FC9
	040005 Title            ="Coolant Temp Compensation"
	040100 Address          =0x102
	040200 ZEq              =X*0.3515625 -y,TH|0|0|0|0|,OB|15D9|0|0|0|
	040300 Rows             =0x2
	040305 Cols             =0x3
	040320 XUnits           ="kPa"
	040325 YUnits           ="F"
	040350 XLabels          =60,70,80
	040360 YLabels          =41,59
%%END%%

%%TABLE%%
	000002 UniqueID         =0x5555
	040005 Title            ="Main VE Table"
	040100 Address          =0x356
	040200 ZEq              =X/2.56,TH|0|0|0|0|
	040300 Rows             =0x2
	040305 Cols             =0x3
	040310 PopByCol         =0x1
%%END%%
`;

function sampleBin() {
  const bin = new Uint8Array(0x1000);
  bin[0x2] = 0x02;
  bin[0x3] = 0x27; // PROM ID 551, el que manda el Sonoma por ALDL
  bin[0x7] = 0x80; // bit 7: caja manual
  bin[0xd] = 10; // Coolant Table Bias crudo
  bin[0x10] = 0xff;
  bin[0x11] = 0xfe; // -2 con signo
  bin[0x2ae] = 166;
  bin[0x5cd] = 66; // 825 RPM
  bin.set([50, 51, 52, 60, 61, 62], 0x102);
  bin.set([1, 2, 3, 4, 5, 6], 0x356);
  let sum = 0;
  for (let i = 4; i <= 0xfff; i++) sum = (sum + bin[i]) & 0xffff;
  bin[0] = sum >> 8;
  bin[1] = sum & 0xff;
  return bin;
}

test("detecta el XDF de texto como xdf, y parseXDF lo despacha solo", () => {
  assert.equal(detectFormat(XDF), "xdf");
  const d = parseXDF(XDF);
  assert.equal(d.header.title, "4E");
  assert.equal(d.header.author, "Robert Saar");
  assert.equal(d.tables.length, 2);
});

test("los títulos con espacios son grupos, no datos", () => {
  const d = parseXDF(XDF);
  assert.deepEqual(
    d.constants.map((c) => [c.name, c.group]),
    [
      ["PROM ID", "General"],
      ["Coolant Table Bias", "General"],
      ["BPW Constant for EGR Off", "General"],
      ["Firmado de prueba", "General"],
      ["Target Idle Speed A/C On", "IAC"],
    ]
  );
});

test("constantes: 16 bits big-endian, con signo y ecuación", () => {
  const d = parseXDF(XDF);
  const bin = sampleBin();
  const get = (n) => d.constants.find((c) => c.name === n).value(bin);
  assert.equal(get("PROM ID"), 0x0227);
  assert.equal(get("Target Idle Speed A/C On"), 825);
  assert.equal(get("BPW Constant for EGR Off"), 166);
  assert.equal(get("Firmado de prueba"), -2);
  assert.equal(d.constants[0].value(null), null);
});

test("bandera: bit 7 de 0x7 (caja manual)", () => {
  const d = parseXDF(XDF);
  const bin = sampleBin();
  assert.equal(d.flags[0].value(bin), true);
  bin[0x7] = 0x7f;
  assert.equal(d.flags[0].value(bin), false);
});

test("tabla por filas con la variable y enlazada por OB|15D9", () => {
  const d = parseXDF(XDF);
  const t = d.tables.find((x) => x.name === "Coolant Temp Compensation");
  assert.deepEqual(t.xAxis, [60, 70, 80]);
  assert.deepEqual(t.yAxis, [41, 59]);
  assert.equal(t.varRefs.y.name, "Coolant Table Bias");
  const bin = sampleBin();
  assert.equal(t.valueAt(0, 1, bin), 51 * 0.3515625 - 10 * 0.3515625);
  assert.equal(t.valueAt(1, 0, bin), 60 * 0.3515625 - 10 * 0.3515625);
});

test("tabla PopByCol: las celdas van por columnas", () => {
  const d = parseXDF(XDF);
  const t = d.tables.find((x) => x.name === "Main VE Table");
  const bin = sampleBin();
  // columna 0 = bytes 1,2; columna 1 = 3,4; columna 2 = 5,6
  assert.equal(t.valueAt(0, 0, bin) * 2.56, 1);
  assert.equal(t.valueAt(1, 0, bin) * 2.56, 2);
  assert.equal(Math.round(t.valueAt(0, 1, bin) * 2.56), 3);
  assert.equal(Math.round(t.valueAt(1, 2, bin) * 2.56), 6);
});

test("checksum: suma de 16 bits de 0x4..0xFFF guardada en 0x0", () => {
  const d = parseXDF(XDF);
  const bin = sampleBin();
  assert.equal(d.checksum.verify(bin).ok, true);
  bin[0x5cd] = 70; // subir el ralentí con A/C sin corregir el checksum
  const r = d.checksum.verify(bin);
  assert.equal(r.ok, false);
  assert.equal(r.computed - r.stored, 4);
});

test("evalEquation: las formas del 4E.xdf", () => {
  assert.equal(evalEquation("X", 7), 7);
  assert.equal(evalEquation("X*.1", 100), 10);
  assert.equal(evalEquation("X*1.35 -40", 100), 95);
  assert.equal(evalEquation("X*.369+10.354", 100), 100 * 0.369 + 10.354);
  assert.equal(evalEquation("X*(0.01960784313725490196078431372549/0.04)", 100), 100 * (0.01960784313725490196078431372549 / 0.04));
  assert.equal(evalEquation("X*0.3515625 -y", 100, { y: 2 }), 100 * 0.3515625 - 2);
  assert.equal(evalEquation("-X+5", 2), 3);
  // formas que ya usaba el .adx
  assert.equal(evalEquation("X*25", 32), 800);
  assert.equal(evalEquation("X*0.0196", 100), 1.96);
  // basura: devuelve el crudo en vez de reventar
  assert.equal(evalEquation("X**", 9), 9);
  assert.equal(evalEquation("X*z", 9), 9);
});
