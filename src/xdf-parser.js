/**
 * xdf-parser.js
 *
 * Parser mínimo pero real para archivos XDF (definiciones de tablas de bin)
 * y ADX (definiciones de datastream en vivo) de TunerPro.
 *
 * Casi siempre son XML. La estructura difiere ligeramente:
 *  - XDF: <XDFFORMAT> con <TABLE>, <EMBEDDEDDATA offset=... />, <MATH equation=... />
 *    (los XDF viejos de TunerPro son TEXTO, no XML: ver parseLegacyXDF)
 *  - ADX: <ADXFORMAT> con <PARAMETERGROUP>, <PARAMETER> con id/units/equation
 *
 * Un <PARAMETER> de ADX puede ser un valor numérico (1 o 2 bytes big-endian,
 * con signo opcional, por ecuación o tabla de lookup) o una bandera de 1 bit
 * con `bit="0..7"` (bit 0 = LSB, la convención del .ads de TunerPro/WinALDL).
 *
 * No cubrimos aún: banks/switches complejos ni constantes/banderas/checksum
 * del XDF XML (sí los del XDF de texto viejo). Las ecuaciones aceptan
 * aritmética con + - * / y paréntesis (evalEquation).
 */

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
    const vars = {};
    for (const [letter, ref] of Object.entries(this.varRefs || {})) {
      const v = ref.value(bin);
      if (v == null) return null;
      vars[letter] = v;
    }
    return evalEquation(this.equation, raw, vars);
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
  constructor({
    id,
    name,
    units,
    equation,
    byteIndex,
    byteLength,
    table,
    warnMin,
    warnMax,
    flatAlert,
    bit,
    invert,
    trueLabel,
    falseLabel,
    signed,
    alertIf,
    validMin,
    validMax,
    spike,
    monotonic,
  }) {
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

    // --- banderas de 1 bit (lazo abierto/cerrado, códigos de falla, A/C, P/N...) ---
    // `bit` = 0..7 con bit 0 = LSB, la convención del .ads de TunerPro/WinALDL.
    this.bit = Number.isInteger(bit) && bit >= 0 && bit <= 7 ? bit : null;
    this.invert = !!invert; // algunas banderas son activas en bajo (ej. A/C Request del A040)
    this.trueLabel = trueLabel || "Sí";
    this.falseLabel = falseLabel || "No";
    this.alertIf = alertIf === true || alertIf === false ? alertIf : null; // estado que levanta la alerta
    this.signed = !!signed; // complemento a dos (ej. correcciones con signo)

    // --- frames corruptos (ver src/frame-check.js) ---
    // No son alertas del motor: marcan un FRAME como basura (ruido en la línea, bit perdido,
    // frame de apagado de llave) para sacarlo del análisis.
    this.validMin = validMin ?? null; // fuera de [validMin, validMax] = físicamente imposible
    this.validMax = validMax ?? null;
    this.spike = spike ?? null; // salto aislado: se aleja > spike de los dos vecinos, que coinciden entre sí
    this.monotonic = !!monotonic; // contador que no puede bajar y volver a subir (ej. detonación)
  }

  /** true si este parámetro es una bandera booleana de 1 bit y no un valor numérico. */
  get isFlag() {
    return this.bit !== null;
  }

  /**
   * Valor crudo del parámetro dentro de un frame ALDL. Soporta 1 y 2 bytes
   * (big-endian, como manda el ALDL) y complemento a dos si `signed`.
   * Devuelve null si el frame es más corto de lo que pide el parámetro -
   * mejor eso que un 0 silencioso que se ve como un dato real.
   */
  readRaw(bytes) {
    const hi = bytes[this.byteIndex];
    if (hi === undefined) return null;

    if (this.byteLength >= 2) {
      const lo = bytes[this.byteIndex + 1];
      if (lo === undefined) return null;
      const v = ((hi << 8) | lo) >>> 0;
      return this.signed && v & 0x8000 ? v - 0x10000 : v;
    }
    return this.signed && hi & 0x80 ? hi - 0x100 : hi;
  }

  /** Estado de la bandera en un frame. null si no es bandera o el frame es corto. */
  readFlag(bytes) {
    if (!this.isFlag) return null;
    const byte = bytes[this.byteIndex];
    if (byte === undefined) return null;
    const on = ((byte >> this.bit) & 1) === 1;
    return this.invert ? !on : on;
  }

  /**
   * Valor listo para guardar/graficar desde un frame completo. Las banderas
   * salen como 1/0 (y no como texto) para que el histórico, las gráficas y
   * el CSV sigan siendo numéricos como siempre; la etiqueta legible la pone
   * `format()` al dibujar.
   */
  read(bytes) {
    if (this.isFlag) {
      const on = this.readFlag(bytes);
      return on === null ? null : on ? 1 : 0;
    }
    const raw = this.readRaw(bytes);
    return raw === null ? null : this.evaluate(raw);
  }

  /** Texto para mostrar: la etiqueta de la bandera, o el número con decimales. */
  format(value, decimals = 2) {
    if (value === null || value === undefined) return "--";
    if (this.isFlag) return value ? this.trueLabel : this.falseLabel;
    return value.toFixed(decimals);
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
 * Evalúa una ecuación aritmética de TunerPro: números (también ".1"), X (el
 * valor crudo), variables de una letra (`vars`, p. ej. la "y" que un XDF viejo
 * enlaza a otra constante), + - * /, paréntesis y menos unario.
 * Sin eval(): tokenizador + descenso recursivo. Compartida entre
 * ParsedParameter (bytes en vivo), ParsedTable y ParsedConstant (bin).
 */
export function evalEquation(equation, rawValue, vars = {}) {
  const expr = equation.trim();
  if (expr === "X") return rawValue;

  const tokens = expr.match(/\d*\.\d+|\d+|[A-Za-z]|[-+*/()]|\S/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = () => {
    throw new Error("sintaxis");
  };

  // expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := '-' factor | número | letra | '(' expr ')'
  const parseExpr = () => {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") v = tokens[pos++] === "+" ? v + parseTerm() : v - parseTerm();
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/") v = tokens[pos++] === "*" ? v * parseFactor() : v / parseFactor();
    return v;
  };
  const parseFactor = () => {
    const t = tokens[pos++];
    if (t === undefined) fail();
    if (t === "-") return -parseFactor();
    if (t === "+") return parseFactor();
    if (t === "(") {
      const v = parseExpr();
      if (tokens[pos++] !== ")") fail();
      return v;
    }
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t === "X" || t === "x") return rawValue;
    if (/^[A-Za-z]$/.test(t) && vars[t] !== undefined) return vars[t];
    return fail();
  };

  try {
    const v = parseExpr();
    if (pos !== tokens.length) fail();
    return v;
  } catch {
    console.warn(`Ecuación no soportada aún: "${equation}", devolviendo valor crudo`);
    return rawValue;
  }
}

function textOf(el, selector, fallback = "") {
  const node = el.querySelector(selector);
  return node ? node.textContent.trim() : fallback;
}

/** Atributo numérico opcional: null si no está o no es número. */
function numAttr(el, name) {
  const v = parseFloat(attrOf(el, name, ""));
  return Number.isNaN(v) ? null : v;
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

/** Valor escalar del bin (una celda suelta): 8 o 16 bits big-endian, con signo opcional. */
export class ParsedConstant {
  constructor({ name, group, address, bits, signed, equation, units, desc, varRefs }) {
    this.name = name;
    this.group = group || "";
    this.address = address;
    this.bits = bits || 8;
    this.signed = !!signed;
    this.equation = equation || "X";
    this.units = units || "";
    this.desc = desc || "";
    this.varRefs = varRefs || {}; // letra de la ecuación -> ParsedConstant de la que sale su valor
  }

  readRaw(bin) {
    const raw = bin ? readCellRaw(bin, this.address, this.bits) : null;
    if (raw == null || !this.signed) return raw;
    const top = 1 << (this.bits > 8 ? 16 : 8);
    return raw >= top / 2 ? raw - top : raw;
  }

  /** Valor real, o null si no hay bin o la dirección cae fuera. */
  value(bin, depth = 0) {
    const raw = this.readRaw(bin);
    if (raw == null) return null;
    const vars = {};
    for (const [letter, ref] of Object.entries(this.varRefs)) {
      const v = depth < 4 ? ref.value(bin, depth + 1) : null; // tope por si un XDF trae referencias circulares
      if (v == null) return null;
      vars[letter] = v;
    }
    return evalEquation(this.equation, raw, vars);
  }
}

/** Un bit de un byte del bin. bit 0 = LSB. */
export class ParsedFlag {
  constructor({ name, group, address, bit, desc }) {
    this.name = name;
    this.group = group || "";
    this.address = address;
    this.bit = bit;
    this.desc = desc || "";
  }

  /** true/false, o null si no hay bin o la dirección cae fuera. */
  value(bin) {
    if (!bin || this.address < 0 || this.address >= bin.length) return null;
    return ((bin[this.address] >> this.bit) & 1) === 1;
  }
}

/**
 * Checksum de suma de 16 bits (CalcMethod 0 de TunerPro, el de las PROM GM):
 * suma de los bytes start..end (inclusive), módulo 65536, guardada
 * big-endian en storeAddr.
 */
export class ParsedChecksum {
  constructor({ start, end, storeAddr, method }) {
    this.start = start;
    this.end = end;
    this.storeAddr = storeAddr;
    this.method = method;
  }

  /** { supported, stored, computed, ok } — supported=false si el método no es la suma simple. */
  verify(bin) {
    if (this.method !== 0) return { supported: false };
    if (!bin || this.end >= bin.length || this.storeAddr + 1 >= bin.length) return { supported: true, ok: null };
    let sum = 0;
    for (let i = this.start; i <= this.end; i++) sum = (sum + bin[i]) & 0xffff;
    const stored = (bin[this.storeAddr] << 8) | bin[this.storeAddr + 1];
    return { supported: true, stored, computed: sum, ok: stored === sum };
  }
}

/**
 * Parsea el formato de TEXTO viejo de TunerPro ("XDF\n1.110000", bloques
 * %%HEADER%% / %%CHECKSUM%% / %%CONSTANT%% / %%FLAG%% / %%TABLE%% ... %%END%%,
 * una línea "NNNNNN Campo =valor" por campo). Es el formato del 4E.xdf de
 * Robert Saar (máscara $4E, ECM 1228062).
 *
 * Detalles que salen del propio archivo, no de documentación:
 *  - Un título que empieza con espacios ("     Spark") es un encabezado de
 *    grupo, no un dato: da nombre a lo que sigue y no se lista.
 *  - Las ecuaciones traen "fórmula,TH|0|0|0|0|" y a veces ",OB|15D9|..."
 *    para enlazar otra constante (por UniqueID) como variable. Se asume que
 *    las letras de la fórmula (salvo X) toman los OB en orden de aparición;
 *    en el 4E.xdf hay un solo caso ("X*0.3515625 -y" + OB 15D9 = "Coolant
 *    Table Bias"), y encaja.
 *  - Flags=0x1 en una constante = con signo (igual que mmedtypeflags del XDF XML).
 *  - Tablas: celdas contiguas de 8 bits, por filas; PopByCol=1 = por columnas.
 */
export function parseLegacyXDF(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^%%(\w+)%%\s*$/);
    if (marker) {
      if (marker[1] === "END") {
        if (cur) blocks.push(cur);
        cur = null;
      } else {
        cur = { kind: marker[1], f: {} };
      }
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^\s*\d{6}\s+(\w+)\s*=(.*)$/);
    if (m) cur.f[m[1]] = m[2].trim();
  }

  const str = (v) => (v || "").replace(/^"|"$/g, "");
  const num = (v, fallback = 0) => {
    if (v === undefined || v === "") return fallback;
    const n = /^0x/i.test(v) ? parseInt(v, 16) : parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
  };
  const splitEq = (v) => {
    const parts = (v || "X").split(",");
    const obIds = parts.filter((p) => /^OB\|/.test(p)).map((p) => p.split("|")[1].toUpperCase());
    return { formula: parts[0].trim() || "X", obIds };
  };
  const labels = (v, count) => {
    const vals = (v || "").split(",").map((s) => parseFloat(s));
    return Array.from({ length: count }, (_, i) => (Number.isNaN(vals[i]) ? i : vals[i]));
  };

  const header = {};
  let checksum = null;
  const tables = [];
  const constants = [];
  const flags = [];
  const byUid = new Map();
  const pendingRefs = []; // [constante, fórmula, [uids]] para resolver cuando ya existan todas
  let group = "";

  for (const b of blocks) {
    const f = b.f;
    if (b.kind === "HEADER") {
      Object.assign(header, {
        title: str(f.DefTitle),
        desc: str(f.Desc),
        author: str(f.Author),
        binSize: num(f.BinSize, null),
      });
      continue;
    }
    if (b.kind === "CHECKSUM") {
      checksum = new ParsedChecksum({
        start: num(f.DataStart),
        end: num(f.DataEnd),
        storeAddr: num(f.StoreAddr),
        method: num(f.CalcMethod),
      });
      continue;
    }

    const rawTitle = str(f.Title);
    if (/^\s/.test(rawTitle)) {
      group = rawTitle.trim();
      continue;
    }
    const name = rawTitle || "Sin nombre";
    const desc = str(f.Desc);

    if (b.kind === "CONSTANT") {
      const { formula, obIds } = splitEq(f.Equation);
      const c = new ParsedConstant({
        name,
        group,
        address: num(f.Address),
        bits: num(f.SizeInBits, 8),
        signed: (num(f.Flags) & 1) === 1,
        equation: formula,
        units: str(f.Units),
        desc,
      });
      constants.push(c);
      byUid.set(String(f.UniqueID || "").toUpperCase().replace(/^0X/, ""), c);
      if (obIds.length) pendingRefs.push([c, formula, obIds]);
    } else if (b.kind === "FLAG") {
      flags.push(new ParsedFlag({ name, group, address: num(f.Address), bit: num(f.BitNumber), desc }));
    } else if (b.kind === "TABLE") {
      const rows = num(f.Rows, 1) || 1;
      const cols = num(f.Cols, 1) || 1;
      const base = num(f.Address);
      const bits = num(f.SizeInBits, 8);
      const step = bits > 8 ? 2 : 1;
      const byCol = num(f.PopByCol) === 1;
      const cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          cells.push({ offset: base + (byCol ? c * rows + r : r * cols + c) * step, bits });
        }
      }
      const { formula, obIds } = splitEq(f.ZEq);
      const t = new ParsedTable({
        name,
        rows,
        cols,
        cells,
        units: str(f.ZUnits),
        xLabel: str(f.XUnits) || "X",
        yLabel: str(f.YUnits) || "Y",
        xAxis: labels(f.XLabels, cols),
        yAxis: labels(f.YLabels, rows),
        equation: formula,
      });
      t.group = group;
      t.desc = desc;
      if (obIds.length) pendingRefs.push([t, formula, obIds]);
      tables.push(t);
    }
  }

  // Enlaza las letras de cada fórmula con las constantes OB|uid, en orden.
  for (const [item, formula, obIds] of pendingRefs) {
    const letters = [...new Set((formula.match(/[A-Za-z]/g) || []).filter((l) => l !== "X" && l !== "x"))];
    const refs = {};
    letters.forEach((l, i) => {
      const ref = byUid.get(obIds[i]);
      if (ref) refs[l] = ref;
    });
    item.varRefs = refs;
  }

  return { tables, constants, flags, checksum, header };
}

/** Parsea un XDF (definición de tablas de bin), XML o de texto viejo. Devuelve { tables, constants, flags, checksum, header }. */
export function parseXDF(xmlText) {
  if (isLegacyXDF(xmlText)) return parseLegacyXDF(xmlText);

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

  return { tables, constants: [], flags: [], checksum: null, header: {} };
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
    const bitRaw = attrOf(p, "bit", "");
    const alertIfRaw = attrOf(p, "alertif", "");
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
        validMin: numAttr(p, "validmin"),
        validMax: numAttr(p, "validmax"),
        spike: numAttr(p, "spike"),
        monotonic: attrOf(p, "monotonic", "false") === "true",
        flatAlert: attrOf(p, "flatalert", "false") === "true",
        bit: bitRaw !== "" ? parseInt(bitRaw, 10) : null,
        invert: attrOf(p, "invert", "false") === "true",
        trueLabel: attrOf(p, "truelabel", "Sí"),
        falseLabel: attrOf(p, "falselabel", "No"),
        alertIf: alertIfRaw === "true" ? true : alertIfRaw === "false" ? false : null,
        signed: attrOf(p, "signed", "false") === "true",
      })
    );
  });

  return { parameters };
}

/** XDF de texto viejo de TunerPro: arranca con "XDF" y la versión en la línea siguiente. */
function isLegacyXDF(text) {
  return /^\uFEFF?XDF\s*\r?\n\s*\d+\.\d+/.test(text);
}

/** Detecta si un texto es XDF (XML o texto viejo) o ADX. */
export function detectFormat(xmlText) {
  if (/<XDFFORMAT/i.test(xmlText) || isLegacyXDF(xmlText)) return "xdf";
  if (/<ADXFORMAT/i.test(xmlText)) return "adx";
  return "unknown";
}
