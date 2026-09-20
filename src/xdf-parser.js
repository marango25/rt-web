/**
 * xdf-parser.js
 *
 * Parser mínimo pero real para archivos XDF (definiciones de tablas de bin)
 * y ADX (definiciones de datastream en vivo) de TunerPro.
 *
 * Ambos son XML. La estructura difiere ligeramente:
 *  - XDF: <XDFFORMAT> con <TABLE>, <EMBEDDEDDATA offset=... />, <MATH equation=... />
 *  - ADX: <ADXFORMAT> con <PARAMETERGROUP>, <PARAMETER> con id/units/equation
 *
 * No cubrimos aún: banks/switches complejos, checksums embebidos en XDF,
 * ni todas las variantes de <MATH> (soportamos expresiones simples tipo
 * lineales "X*a+b" que es el 90% de los casos reales).
 */

import { normalizeProfile } from "./protocol-profile.js";

export class ParsedTable {
  constructor({ name, rows, cols, cells, units, xLabel, yLabel, xAxis, yAxis, equation }) {
    this.name = name;
    this.rows = rows;
    this.cols = cols;
    this.cells = cells; // array plano rows*cols de {offset, bits}
    this.units = units;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    this.xAxis = xAxis || Array.from({ length: cols }, (_, i) => i); // valores reales de breakpoint por columna (ej. RPM)
    this.yAxis = yAxis || Array.from({ length: rows }, (_, i) => i); // valores reales de breakpoint por fila (ej. MAP)
    this.equation = equation || "X";
  }

  /** Valor real de la celda (row, col) leyendo `bin` (Uint8Array) en el offset de esa celda. null si no hay bin o falta la celda. */
  valueAt(row, col, bin) {
    if (!bin) return null;
    const cell = this.cells[row * this.cols + col];
    if (!cell) return null;
    const raw = readCellRaw(bin, cell.offset, cell.bits);
    if (raw == null) return null;
    return evalEquation(this.equation, raw);
  }
}

/** Lee el valor crudo de una celda desde un binario de calibración. Soporta 8 y 16 bits (big-endian, común en ECUs GM). */
function readCellRaw(bin, offset, bits) {
  if (offset == null || offset < 0 || offset >= bin.length) return null;
  if (bits > 8) {
    if (offset + 1 >= bin.length) return null;
    return (bin[offset] << 8) | bin[offset + 1];
  }
  return bin[offset];
}

/** Interpola linealmente en una tabla [[raw, valor], ...] ordenada por raw ascendente. */
function interpolateTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];

  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i];
    const [x1, y1] = table[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return table[table.length - 1][1];
}

export class ParsedParameter {
  constructor({ id, name, units, equation, byteIndex, byteLength, table, warnMin, warnMax, flatAlert }) {
    this.id = id;
    this.name = name;
    this.units = units;
    this.equation = equation; // string, ej "X*0.25" o "X-40"
    this.byteIndex = byteIndex;
    this.byteLength = byteLength || 1;
    this.table = table || null; // [[raw, valor], ...] ordenado por raw - para sensores no lineales (ej. NTC de temperatura)
    this.warnMin = warnMin ?? null; // si el valor cae debajo, se marca la tarjeta como fuera de rango
    this.warnMax = warnMax ?? null;
    this.flatAlert = !!flatAlert; // si true, avisa cuando el valor no cambia por mucho tiempo (sensor "pegado")
  }

  /** Aplica la ecuación (o tabla, si existe) a un valor crudo. */
  evaluate(rawValue) {
    if (this.table && this.table.length) {
      return interpolateTable(this.table, rawValue);
    }
    return evalEquation(this.equation, rawValue);
  }
}

/**
 * Soporta expresiones lineales simples: X*a+b, X*a-b, X-a, X*a, X/a, X.
 * Se evita eval() real por seguridad; parseo manual de un patrón fijo.
 * Compartida entre ParsedParameter (bytes en vivo) y ParsedTable (celdas de bin).
 */
function evalEquation(equation, rawValue) {
  const expr = equation.trim().replace(/\s+/g, "");
  if (expr === "X") return rawValue;

  const patterns = [
    { re: /^X\*([\d.]+)\+([\d.]+)$/, fn: (m) => rawValue * parseFloat(m[1]) + parseFloat(m[2]) },
    { re: /^X\*([\d.]+)-([\d.]+)$/, fn: (m) => rawValue * parseFloat(m[1]) - parseFloat(m[2]) },
    { re: /^X\*([\d.]+)$/, fn: (m) => rawValue * parseFloat(m[1]) },
    { re: /^X\/([\d.]+)$/, fn: (m) => rawValue / parseFloat(m[1]) },
    { re: /^X\+([\d.]+)$/, fn: (m) => rawValue + parseFloat(m[1]) },
    { re: /^X-([\d.]+)$/, fn: (m) => rawValue - parseFloat(m[1]) },
  ];

  for (const p of patterns) {
    const m = expr.match(p.re);
    if (m) return p.fn(m);
  }

  console.warn(`Ecuación no soportada aún: "${equation}", devolviendo valor crudo`);
  return rawValue;
}

function textOf(el, selector, fallback = "") {
  const node = el.querySelector(selector);
  return node ? node.textContent.trim() : fallback;
}

function attrOf(el, name, fallback = "") {
  return el.hasAttribute(name) ? el.getAttribute(name) : fallback;
}

/**
 * Breakpoints reales de un eje (ej. RPM: 500, 1000, 1500...) desde elementos
 * <label index="N" value="V"/> hijos de <xaxis>/<yaxis>. Si el eje no trae
 * labels (o no existe), cae a un índice sintético 0..count-1 - suficiente
 * para ver la forma de la tabla, aunque el resaltado de "posición actual"
 * ya no compare contra unidades reales en ese caso.
 */
function parseAxisBreakpoints(tableNode, axisSelector, count) {
  const arr = Array.from({ length: count }, (_, i) => i);
  const axisNode = tableNode.querySelector(axisSelector);
  if (!axisNode) return arr;

  const labels = axisNode.querySelectorAll("label");
  if (!labels.length) return arr;

  labels.forEach((l) => {
    const idx = parseInt(attrOf(l, "index", "-1"), 10);
    const val = parseFloat(attrOf(l, "value", "NaN"));
    if (idx >= 0 && idx < count && !Number.isNaN(val)) arr[idx] = val;
  });
  return arr;
}

/** Parsea un XDF (definición de tablas de bin). Devuelve { tables: ParsedTable[] } */
export function parseXDF(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) {
    throw new Error("XML inválido en el XDF: " + errorNode.textContent.slice(0, 200));
  }

  const tables = [];
  const tableNodes = doc.querySelectorAll("XDFTABLE, TABLE");

  tableNodes.forEach((tableNode) => {
    const name = textOf(tableNode, "title") || attrOf(tableNode, "uniqueid") || "Tabla sin nombre";
    const rows = parseInt(textOf(tableNode, "yaxis > indexcount", "1"), 10) || 1;
    const cols = parseInt(textOf(tableNode, "xaxis > indexcount", "1"), 10) || 1;

    const cells = [];
    tableNode.querySelectorAll("EMBEDDEDDATA").forEach((ed) => {
      cells.push({
        offset: parseInt(attrOf(ed, "mmedoffset", "0"), 16) || parseInt(attrOf(ed, "mmedoffset", "0"), 10),
        bits: parseInt(attrOf(ed, "mmedelementsizebits", "8"), 10),
      });
    });

    const mathNode = tableNode.querySelector("MATH");
    const equation = mathNode ? attrOf(mathNode, "equation", "X") : "X";

    tables.push(
      new ParsedTable({
        name,
        rows,
        cols,
        cells: cells.length ? cells : new Array(rows * cols).fill({ offset: 0, bits: 8 }),
        units: textOf(tableNode, "units", ""),
        xLabel: textOf(tableNode, "xaxis > title", "X"),
        yLabel: textOf(tableNode, "yaxis > title", "Y"),
        xAxis: parseAxisBreakpoints(tableNode, "xaxis", cols),
        yAxis: parseAxisBreakpoints(tableNode, "yaxis", rows),
        equation,
      })
    );
  });

  return { tables };
}

/**
 * Lee el bloque opcional <PROTOCOL baud="160" framebytes="20" promidindex="1" promid="02 27" />
 * (perfil de protocolo, ver protocol-profile.js). Devuelve null si el ADX no lo trae: en ese
 * caso la app se comporta como v1 (V1_PROFILE), así que los ADX viejos siguen funcionando.
 */
function parseProtocol(doc) {
  const node = doc.querySelector("PROTOCOL");
  if (!node) return null;
  return normalizeProfile({
    baud: attrOf(node, "baud"),
    frameBytes: attrOf(node, "framebytes"),
    promIdIndex: attrOf(node, "promidindex"),
    promId: attrOf(node, "promid"),
  });
}

/** Parsea un ADX (definición de datastream en vivo). Devuelve { parameters: ParsedParameter[], protocol: perfil|null } */
export function parseADX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode) {
    throw new Error("XML inválido en el ADX: " + errorNode.textContent.slice(0, 200));
  }

  const lookupTables = new Map();
  doc.querySelectorAll("LOOKUPTABLE").forEach((t) => {
    const entries = [];
    t.querySelectorAll("ENTRY").forEach((e) => {
      entries.push([parseFloat(attrOf(e, "raw", "0")), parseFloat(attrOf(e, "value", "0"))]);
    });
    entries.sort((a, b) => a[0] - b[0]);
    lookupTables.set(attrOf(t, "id"), entries);
  });

  const parameters = [];
  doc.querySelectorAll("PARAMETER, PID").forEach((p) => {
    const tableId = attrOf(p, "table", "");
    const warnMinRaw = attrOf(p, "warnmin", "");
    const warnMaxRaw = attrOf(p, "warnmax", "");
    parameters.push(
      new ParsedParameter({
        id: attrOf(p, "id", attrOf(p, "address", "0x00")),
        name: attrOf(p, "name", textOf(p, "name", "Parametro")),
        units: attrOf(p, "units", ""),
        equation: attrOf(p, "equation", attrOf(p, "formula", "X")),
        byteIndex: parseInt(attrOf(p, "byteindex", "0"), 10),
        byteLength: parseInt(attrOf(p, "bytelength", "1"), 10),
        table: tableId ? lookupTables.get(tableId) : null,
        warnMin: warnMinRaw !== "" ? parseFloat(warnMinRaw) : null,
        warnMax: warnMaxRaw !== "" ? parseFloat(warnMaxRaw) : null,
        flatAlert: attrOf(p, "flatalert", "false") === "true",
      })
    );
  });

  return { parameters, protocol: parseProtocol(doc) };
}

/** Detecta si un texto XML es XDF o ADX mirando el nodo raíz. */
export function detectFormat(xmlText) {
  if (/<XDFFORMAT/i.test(xmlText)) return "xdf";
  if (/<ADXFORMAT/i.test(xmlText)) return "adx";
  return "unknown";
}
