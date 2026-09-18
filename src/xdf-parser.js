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

export class ParsedTable {
  constructor({ name, rows, cols, cells, units, xLabel, yLabel }) {
    this.name = name;
    this.rows = rows;
    this.cols = cols;
    this.cells = cells; // array plano rows*cols de {rawOffset, equation}
    this.units = units;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
  }
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

    // Soporta expresiones lineales simples: X*a+b, X*a-b, X-a, X*a, X/a, X
    // Se evita eval() real por seguridad; parseo manual de un patrón fijo.
    const expr = this.equation.trim().replace(/\s+/g, "");
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

    console.warn(`Ecuación no soportada aún: "${this.equation}", devolviendo valor crudo`);
    return rawValue;
  }
}

function textOf(el, selector, fallback = "") {
  const node = el.querySelector(selector);
  return node ? node.textContent.trim() : fallback;
}

function attrOf(el, name, fallback = "") {
  return el.hasAttribute(name) ? el.getAttribute(name) : fallback;
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
    const name = attrOf(tableNode, "uniqueid") || textOf(tableNode, "title", "Tabla sin nombre");
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
      })
    );

    tables[tables.length - 1].equation = equation;
  });

  return { tables };
}

/** Parsea un ADX (definición de datastream en vivo). Devuelve { parameters: ParsedParameter[] } */
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

  return { parameters };
}

/** Detecta si un texto XML es XDF o ADX mirando el nodo raíz. */
export function detectFormat(xmlText) {
  if (/<XDFFORMAT/i.test(xmlText)) return "xdf";
  if (/<ADXFORMAT/i.test(xmlText)) return "adx";
  return "unknown";
}
