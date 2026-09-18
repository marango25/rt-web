import { parseXDF, parseADX, detectFormat } from "./xdf-parser.js";
import { RTBridgeClient } from "./ws-client.js";
import { SimSource } from "./sim-source.js";
import { saveSession, listSessions, deleteSession } from "./db.js";

let loadedTables = [];
let loadedParams = [];
let currentValues = {}; // id -> valor calculado
let paramHistory = {}; // id -> number[] (ventana reciente, para la gráfica)
let paramHistoryTimes = {}; // id -> number[] (mismos índices que paramHistory, timestamp ms) - para el tooltip al pasar el cursor
let paramMeta = {}; // id -> { lastValue, lastChangeTs } - para detectar valores "congelados"
let expandedParamId = null; // id del parámetro con vista de gráfica grande abierta, o null
let sessionLog = []; // { t, values, raw, evento } por cada frame recibido - sin límite, para descargar como CSV
let activeFlags = new Set(); // accesorios marcados como encendidos ahora mismo (checkboxes)
let otherFlagText = ""; // texto libre del campo "Otro"
let viewMode = "live"; // "live" | "replay" - replay se activa al cargar un CSV guardado
let replayLogs = { A: null, B: null }; // { name, columns: [{key, units}], rows: [{t, values}] }
let replayZoom = { start: 0, end: 1 }; // fracciones 0..1 - ventana visible, compartida por todas las gráficas del replay
let replayDragState = null; // { startX, startZoom, canvas } mientras se arrastra, o null
let currentReplayCanvases = []; // [{ key, canvas }] de la sesión de replay activa (para redibujar sin reconstruir el DOM)
let currentSessionId = null; // id de la sesión que se está autoguardando en IndexedDB
let sessionStartedAt = 0;
let loadedBin = null; // Uint8Array del .bin de calibración cargado, o null (las tablas se ven "vacías" sin esto)
let axisOverrides = {}; // `${tableIdx}:${axis}` -> id de parámetro elegido a mano, o "" para usar el auto-match
let vehicleTag = "";
try {
  vehicleTag = localStorage.getItem("rtweb_vehicle_tag") || "";
} catch {
  // localStorage puede fallar en navegación privada - no es crítico, solo se pierde el recordar el último valor
}
let lastAutosaveAt = 0;
const MAX_HISTORY = 600;
const STUCK_ALERT_MS = 8000; // tiempo sin cambio para marcar un parámetro con flatalert="true" como "congelado"
const AUTOSAVE_INTERVAL_MS = 5000;

const el = {
  fileInput: document.getElementById("file-input"),
  binInput: document.getElementById("bin-input"),
  hostInput: document.getElementById("host-input"),
  connectBtn: document.getElementById("connect-btn"),
  simBtn: document.getElementById("sim-btn"),
  downloadLogBtn: document.getElementById("download-log-btn"),
  clearLogBtn: document.getElementById("clear-log-btn"),
  logCount: document.getElementById("log-count"),
  markerOther: document.getElementById("marker-other"),
  markerStatus: document.getElementById("marker-status"),
  replayInputA: document.getElementById("replay-input-a"),
  replayInputB: document.getElementById("replay-input-b"),
  replayClearBtn: document.getElementById("replay-clear-btn"),
  vehicleTagInput: document.getElementById("vehicle-tag-input"),
  sessionVehicleFilter: document.getElementById("session-vehicle-filter"),
  sessionList: document.getElementById("session-list"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  main: document.getElementById("main"),
};

function setStatus(state, detail) {
  el.statusDot.className =
    "status-dot" + (state === "conectado" ? " ok" : state === "simulado" ? " sim" : state === "error" ? " bad" : "");
  el.statusText.textContent = detail ? `${state} (${detail})` : state;
}

function bytesToHex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(" ");
}

function applyFrame(rawBytes) {
  const now = Date.now();
  const outOfRangeLabels = []; // columna propia "fuera_de_rango" en el CSV
  const stuckLabels = []; // se suman a la columna "evento", junto a lo marcado manualmente

  loadedParams.forEach((p) => {
    const raw = rawBytes[p.byteIndex] ?? 0;
    const value = p.evaluate(raw);
    currentValues[p.id] = value;

    const hist = paramHistory[p.id] || (paramHistory[p.id] = []);
    const histT = paramHistoryTimes[p.id] || (paramHistoryTimes[p.id] = []);
    hist.push(value);
    histT.push(now);
    if (hist.length > MAX_HISTORY) {
      hist.shift();
      histT.shift();
    }

    const meta = paramMeta[p.id] || (paramMeta[p.id] = { lastValue: value, lastChangeTs: now });
    if (meta.lastValue !== value) {
      meta.lastValue = value;
      meta.lastChangeTs = now;
    }

    const { outOfRange, isStuck } = evaluateAlerts(p, value, now);
    if (outOfRange) outOfRangeLabels.push(p.name);
    if (isStuck) stuckLabels.push(`${p.name} congelado`);
  });

  if (loadedParams.length) {
    sessionLog.push({
      t: now,
      values: { ...currentValues },
      raw: rawBytes.slice(),
      evento: currentEventoText(stuckLabels),
      fueraDeRango: outOfRangeLabels.join(", "),
    });
    updateLogCount();
  }

  maybeAutosaveSession();

  if (viewMode !== "replay") renderMain();
}

function updateLogCount() {
  if (el.logCount) el.logCount.textContent = `${sessionLog.length} muestras registradas`;
}

function csvField(v) {
  const s = String(v);
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadLog() {
  if (!sessionLog.length || !loadedParams.length) {
    alert("No hay datos registrados todavía.");
    return;
  }

  const headers = [
    "timestamp_iso",
    ...loadedParams.map((p) => csvField(`${p.name} (${p.units})`)),
    "evento",
    "fuera_de_rango",
    "raw_frame",
  ];
  const rows = sessionLog.map((entry) => {
    const iso = new Date(entry.t).toISOString();
    const vals = loadedParams.map((p) => (entry.values[p.id] !== undefined ? entry.values[p.id].toFixed(3) : ""));
    const evento = csvField(entry.evento || "");
    const fueraDeRango = csvField(entry.fueraDeRango || "");
    const rawHex = csvField(entry.raw ? bytesToHex(entry.raw) : "");
    return [iso, ...vals, evento, fueraDeRango, rawHex].join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rtweb-log-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Base de datos de sesiones (IndexedDB) ----------------------------------
// Autoguarda la sesión actual cada pocos segundos mientras hay datos
// entrando, etiquetada con el vehículo, para no perderla si se cierra la
// pestaña por accidente y para poder filtrar/recargar sesiones pasadas.

/**
 * Id simple sin depender de crypto.randomUUID(): ese método requiere un
 * "contexto seguro" (https o localhost), y este proyecto se sirve típicamente
 * por http plano desde el ESP8266/una IP de LAN (ej. http://192.168.0.167),
 * donde randomUUID() no existe.
 */
function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function startNewSession() {
  currentSessionId = newId();
  sessionStartedAt = Date.now();
  lastAutosaveAt = 0;
}

function currentParamsSnapshot() {
  return loadedParams.map((p) => ({ id: p.id, name: p.name, units: p.units }));
}

async function persistCurrentSession() {
  if (!currentSessionId || !sessionLog.length) return;
  const session = {
    id: currentSessionId,
    vehicleTag: vehicleTag || "(sin vehículo)",
    startedAt: sessionStartedAt,
    updatedAt: Date.now(),
    paramsSnapshot: currentParamsSnapshot(),
    rows: sessionLog,
  };
  try {
    await saveSession(session);
    refreshSessionList();
  } catch (err) {
    console.warn("No se pudo guardar la sesión en la base de datos:", err);
  }
}

function maybeAutosaveSession() {
  const now = Date.now();
  if (now - lastAutosaveAt < AUTOSAVE_INTERVAL_MS) return;
  lastAutosaveAt = now;
  persistCurrentSession();
}

/** Convierte una sesión guardada al mismo formato {name, columns, rows} que usa el replay de CSV. */
function sessionToReplayLog(session) {
  const columns = session.paramsSnapshot.map((p) => ({ key: p.name, units: p.units }));
  const rows = session.rows.map((r) => {
    const values = {};
    session.paramsSnapshot.forEach((p) => {
      if (r.values[p.id] !== undefined) values[p.name] = r.values[p.id];
    });
    return { t: r.t, values };
  });
  return { name: `${session.vehicleTag} · ${new Date(session.startedAt).toLocaleString()}`, columns, rows };
}

async function refreshSessionList() {
  let sessions;
  try {
    sessions = await listSessions();
  } catch (err) {
    console.warn("No se pudo leer la base de datos de sesiones:", err);
    return;
  }

  const tags = [...new Set(sessions.map((s) => s.vehicleTag).filter(Boolean))];
  const filterVal = el.sessionVehicleFilter.value;
  el.sessionVehicleFilter.innerHTML =
    `<option value="">Todos los vehículos</option>` +
    tags.map((t) => `<option value="${t}"${t === filterVal ? " selected" : ""}>${t}</option>`).join("");

  const filtered = filterVal ? sessions.filter((s) => s.vehicleTag === filterVal) : sessions;

  if (!filtered.length) {
    el.sessionList.innerHTML = `<div class="hint">Sin sesiones guardadas todavía.</div>`;
    return;
  }

  el.sessionList.innerHTML = filtered
    .map(
      (s) => `
    <div class="session-item">
      <div class="session-info">
        <div class="session-tag">${s.vehicleTag}</div>
        <div class="hint">${new Date(s.startedAt).toLocaleString()} · ${s.rows.length} muestras</div>
      </div>
      <div class="session-actions">
        <button type="button" class="load-session" data-id="${s.id}">Cargar</button>
        <button type="button" class="delete-session" data-id="${s.id}">✕</button>
      </div>
    </div>
  `
    )
    .join("");
}

el.vehicleTagInput.value = vehicleTag;
el.vehicleTagInput.addEventListener("input", () => {
  vehicleTag = el.vehicleTagInput.value.trim();
  try {
    localStorage.setItem("rtweb_vehicle_tag", vehicleTag);
  } catch {
    // no crítico si falla (navegación privada, storage bloqueado, etc.)
  }
});

el.sessionVehicleFilter.addEventListener("change", refreshSessionList);

el.sessionList.addEventListener("click", async (evt) => {
  const loadBtn = evt.target.closest(".load-session");
  const delBtn = evt.target.closest(".delete-session");
  if (loadBtn) {
    let sessions;
    try {
      sessions = await listSessions();
    } catch (err) {
      console.warn(err);
      return;
    }
    const session = sessions.find((s) => s.id === loadBtn.dataset.id);
    if (session) {
      replayLogs.A = sessionToReplayLog(session);
      renderReplay();
    }
  } else if (delBtn) {
    try {
      await deleteSession(delBtn.dataset.id);
    } catch (err) {
      console.warn(err);
    }
    refreshSessionList();
  }
});

const bridge = new RTBridgeClient({
  onStatus: setStatus,
  onFrame: applyFrame,
});

const sim = new SimSource({ onFrame: applyFrame });

function frameLengthForParams() {
  if (!loadedParams.length) return 16;
  return Math.max(...loadedParams.map((p) => p.byteIndex + p.byteLength)) + 1;
}

el.connectBtn.addEventListener("click", () => {
  sim.stop();
  el.simBtn.textContent = "Modo simulado";
  const host = el.hostInput.value.trim() || "rtweb.local";
  bridge.connect(host);
});

el.simBtn.addEventListener("click", () => {
  if (sim.running) {
    sim.stop();
    el.simBtn.textContent = "Modo simulado";
    setStatus("sin conectar");
  } else {
    bridge.disconnect();
    sim.start(frameLengthForParams());
    el.simBtn.textContent = "Detener simulado";
    setStatus("simulado");
  }
});

el.fileInput.addEventListener("change", async (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  const text = await file.text();
  const format = detectFormat(text);

  try {
    if (format === "xdf") {
      // Aditivo a propósito: no borra loadedParams. Así puedes cargar un
      // .xdf (tablas) y un .adx (parámetros en vivo) juntos y ver el
      // resaltado de "posición actual" sobre la tabla (overlay en vivo).
      loadedTables = parseXDF(text).tables;
      axisOverrides = {}; // los índices de tabla cambiaron, cualquier override viejo ya no aplica
      renderMain();
    } else if (format === "adx") {
      await persistCurrentSession(); // guarda lo que quedó pendiente de la sesión anterior antes de reiniciar
      loadedParams = parseADX(text).parameters;
      paramHistory = {};
      paramHistoryTimes = {};
      paramMeta = {};
      sessionLog = [];
      updateLogCount();
      startNewSession();
      if (sim.running) sim.start(frameLengthForParams());
      renderMain();
    } else {
      alert("No reconozco el formato del archivo (¿es un .xdf o .adx válido?)");
    }
  } catch (err) {
    alert("Error al parsear: " + err.message);
    console.error(err);
  }
});

el.binInput.addEventListener("change", async (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  try {
    loadedBin = new Uint8Array(await file.arrayBuffer());
    renderMain();
  } catch (err) {
    alert("Error al leer el binario: " + err.message);
    console.error(err);
  }
});

// --- Overlay: resaltar en la tabla el punto de operación actual -------------
// La feature "estrella" original de TunerPro RT: mientras el motor corre (en
// vivo o en modo simulado), ¿en qué celda de esta tabla está operando ahora
// mismo el motor? Emparejamos cada eje (por su título, ej. "RPM") con un
// parámetro del .adx cargado por nombre (auto-match), o el usuario lo elige
// a mano si el auto-match falla o adivina mal.

/** Quita acentos/puntuación y normaliza a minúsculas para comparar nombres de forma tolerante. */
function normalizeLabel(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Busca el parámetro en vivo cuyo nombre se parece más al título de un eje. null si no hay nada razonable. */
function matchParamForAxisLabel(label) {
  const norm = normalizeLabel(label);
  if (!norm || !loadedParams.length) return null;

  const normWords = norm.split(" ").filter(Boolean);
  let best = null;
  let bestScore = 0;
  loadedParams.forEach((p) => {
    const pNorm = normalizeLabel(p.name);
    if (!pNorm) return;
    let score = 0;
    if (pNorm === norm) score = 100;
    else if (pNorm.includes(norm) || norm.includes(pNorm)) score = 60;
    else {
      const pWords = new Set(pNorm.split(" ").filter(Boolean));
      const overlap = normWords.filter((w) => pWords.has(w)).length;
      if (overlap) score = 20 + overlap * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return bestScore >= 20 ? best : null;
}

/** Elección final de parámetro para un eje: lo que el usuario eligió a mano, si lo hizo; si no, el auto-match. */
function resolveAxisParam(tableIdx, axis, autoMatch) {
  const overrideId = axisOverrides[`${tableIdx}:${axis}`];
  if (!overrideId) return autoMatch;
  return loadedParams.find((p) => p.id === overrideId) || autoMatch;
}

/** Índice del breakpoint más cercano a `value` en un eje (array de números reales, ej. RPM). -1 si no aplica. */
function nearestIndex(breakpoints, value) {
  if (!breakpoints || !breakpoints.length || value === undefined || value === null || Number.isNaN(value)) return -1;
  let bestI = -1;
  let bestD = Infinity;
  breakpoints.forEach((b, i) => {
    const d = Math.abs(b - value);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  });
  return bestI;
}

function buildTablesHtml() {
  return loadedTables
    .map((t, idx) => {
      const autoX = matchParamForAxisLabel(t.xLabel);
      const autoY = matchParamForAxisLabel(t.yLabel);
      const xParam = resolveAxisParam(idx, "x", autoX);
      const yParam = resolveAxisParam(idx, "y", autoY);

      const xVal = xParam ? currentValues[xParam.id] : undefined;
      const yVal = yParam ? currentValues[yParam.id] : undefined;
      const activeCol = xVal !== undefined ? nearestIndex(t.xAxis, xVal) : -1;
      const activeRow = yVal !== undefined ? nearestIndex(t.yAxis, yVal) : -1;

      const hint =
        xParam && yParam && xVal !== undefined && yVal !== undefined
          ? `Posición actual: ${t.xLabel} = ${xVal.toFixed(2)} ${xParam.units} (columna ${activeCol + 1}) · ${t.yLabel} = ${yVal.toFixed(2)} ${yParam.units} (fila ${activeRow + 1})`
          : `Sin datos en vivo para resaltar esta tabla todavía — elige el parámetro de cada eje abajo, o carga un .adx con nombres parecidos a "${t.xLabel}" / "${t.yLabel}".`;

      const paramOptionsHtml = (selectedId) =>
        `<option value="">(auto)</option>` +
        loadedParams.map((p) => `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${p.name}</option>`).join("");

      const headerRow = `<tr><th></th>${t.xAxis.map((v) => `<th>${v}</th>`).join("")}</tr>`;

      let bodyRows = "";
      for (let r = 0; r < t.rows; r++) {
        bodyRows += `<tr><th>${t.yAxis[r]}</th>`;
        for (let c = 0; c < t.cols; c++) {
          const val = t.valueAt(r, c, loadedBin);
          const cell = t.cells[r * t.cols + c];
          const display = val !== null ? val.toFixed(1) : cell ? `<span class="cell-empty">off ${cell.offset}</span>` : "-";
          const classes = ["td-cell"];
          if (r === activeRow && c === activeCol) classes.push("active-cell");
          else if (r === activeRow) classes.push("active-row");
          else if (c === activeCol) classes.push("active-col");
          bodyRows += `<td class="${classes.join(" ")}">${display}</td>`;
        }
        bodyRows += "</tr>";
      }

      return `
        <div class="table-block">
          <h3>${t.name} <span style="color:var(--text-dim);font-size:12px;">(${t.units || "sin unidad"})</span></h3>
          <div class="table-position-hint">${hint}</div>
          <div class="axis-match-controls">
            <label>Eje X (${t.xLabel}):
              <select class="axis-select" data-table-idx="${idx}" data-axis="x">${paramOptionsHtml(axisOverrides[`${idx}:x`] || "")}</select>
            </label>
            <label>Eje Y (${t.yLabel}):
              <select class="axis-select" data-table-idx="${idx}" data-axis="y">${paramOptionsHtml(axisOverrides[`${idx}:y`] || "")}</select>
            </label>
          </div>
          <table class="data-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>
          ${!loadedBin ? `<div class="hint">Sin binario (.bin) cargado — mostrando offsets, no valores reales de calibración.</div>` : ""}
        </div>
      `;
    })
    .join("");
}

/** Evalúa alertas de rango y "valor congelado" para un parámetro. Devuelve { outOfRange, isStuck, stuckSec }. */
function evaluateAlerts(p, value, now) {
  const outOfRange = value !== undefined && ((p.warnMin != null && value < p.warnMin) || (p.warnMax != null && value > p.warnMax));

  let isStuck = false;
  let stuckSec = 0;
  if (p.flatAlert) {
    const meta = paramMeta[p.id];
    const hist = paramHistory[p.id];
    if (meta && hist && hist.length >= 5) {
      const elapsed = now - meta.lastChangeTs;
      if (elapsed >= STUCK_ALERT_MS) {
        isStuck = true;
        stuckSec = Math.round(elapsed / 1000);
      }
    }
  }

  return { outOfRange, isStuck, stuckSec };
}

function buildLiveHtml() {
  const now = Date.now();
  const expanded = loadedParams.find((p) => p.id === expandedParamId);
  const alerts = [];

  const cardsHtml = loadedParams
    .map((p) => {
      const v = currentValues[p.id];
      const isExpanded = p.id === expandedParamId;
      const { outOfRange, isStuck, stuckSec } = evaluateAlerts(p, v, now);

      if (outOfRange) alerts.push({ type: "range", text: `${p.name}: ${v.toFixed(2)} ${p.units} fuera del rango esperado (${p.warnMin ?? "-∞"} a ${p.warnMax ?? "∞"})` });
      if (isStuck) alerts.push({ type: "stuck", text: `${p.name}: sin cambios hace ${stuckSec}s (valor congelado en ${v.toFixed(2)} ${p.units})` });

      const cardClasses = ["param-card"];
      if (isExpanded) cardClasses.push("active");
      if (outOfRange) cardClasses.push("warn-range");
      if (isStuck) cardClasses.push("warn-stuck");

      const badges = [
        outOfRange ? `<span class="card-badge range">rango</span>` : "",
        isStuck ? `<span class="card-badge stuck">congelado</span>` : "",
      ].join("");

      return `
        <div class="${cardClasses.join(" ")}" data-param-id="${p.id}">
          <div class="name">${p.name}${badges}</div>
          <div class="value">${v !== undefined ? v.toFixed(2) : "--"}<span class="units">${p.units}</span></div>
          <canvas class="sparkline" width="300" height="48"></canvas>
        </div>
      `;
    })
    .join("");

  updateAlertBanner(alerts);

  return `
    <h3>Parámetros en vivo <span style="color:var(--text-dim);font-size:12px;font-weight:400;">(clic en una tarjeta para ampliar su gráfica)</span></h3>
    ${
      expanded
        ? `
      <div class="chart-expanded">
        <div class="chart-expanded-header">
          <span>${expanded.name} <span class="units">${expanded.units}</span></span>
          <button class="close-chart" type="button">Cerrar ✕</button>
        </div>
        <canvas class="sparkline-big" width="900" height="220"></canvas>
      </div>
    `
        : ""
    }
    <div class="param-list">
      ${cardsHtml}
    </div>
  `;
}

function wireLiveSection() {
  loadedParams.forEach((p) => {
    const canvas = el.main.querySelector(`.param-card[data-param-id="${CSS.escape(p.id)}"] canvas.sparkline`);
    drawChart(canvas, paramHistory[p.id]);
  });

  const expanded = loadedParams.find((p) => p.id === expandedParamId);
  if (expanded) {
    const bigCanvas = el.main.querySelector("canvas.sparkline-big");
    drawChart(bigCanvas, paramHistory[expanded.id], { showLabels: true });
    el.main.querySelector(".close-chart").addEventListener("click", (e) => {
      e.stopPropagation();
      expandedParamId = null;
      renderMain();
    });
  }
}

/**
 * Punto de entrada único de render para las vistas "en vivo"/"tablas" (todo
 * lo que no sea replay, que tiene su propio renderReplay()). Muestra tablas
 * y parámetros en vivo a la vez cuando ambos están cargados - así la tabla
 * puede resaltar la celda donde está operando el motor ahora mismo.
 */
function renderMain() {
  if (!loadedTables.length && !loadedParams.length) {
    el.main.innerHTML = `<div class="empty-state">Carga una definición para empezar.</div>`;
    updateAlertBanner([]);
    return;
  }

  const tablesHtml = loadedTables.length ? buildTablesHtml() : "";
  const liveHtml = loadedParams.length ? buildLiveHtml() : "";
  el.main.innerHTML = tablesHtml + (tablesHtml && liveHtml ? `<hr class="section-divider" />` : "") + liveHtml;

  if (loadedParams.length) wireLiveSection();
  else updateAlertBanner([]);
}

// --- Banner de alertas flotante ---------------------------------------------
// Vive fuera del innerHTML de el.main (igual que el tooltip) para que
// aparecer/desaparecer o cambiar de tamaño NUNCA empuje el resto del
// contenido - antes estaba insertado arriba de la lista de tarjetas y cada
// vez que un parámetro entraba/salía de alerta todo el body saltaba.

const alertBannerEl = document.createElement("div");
alertBannerEl.id = "alert-banner";
alertBannerEl.hidden = true;
document.body.appendChild(alertBannerEl);

function updateAlertBanner(alerts) {
  if (!alerts.length) {
    alertBannerEl.hidden = true;
    alertBannerEl.innerHTML = "";
    return;
  }
  alertBannerEl.innerHTML = alerts.map((a) => `<div class="alert-row ${a.type}">⚠ ${a.text}</div>`).join("");
  alertBannerEl.hidden = false;
}

// --- Tooltip al pasar el cursor sobre una gráfica ---------------------------

const tooltipEl = document.createElement("div");
tooltipEl.id = "chart-tooltip";
tooltipEl.hidden = true;
document.body.appendChild(tooltipEl);

/** x del mouse como fracción 0..1 del ancho CSS del canvas, o null si no aplica. */
function fracXFromEvent(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  return Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
}

/** rows: [{ label, value, units, t (ms epoch, opcional), color }] */
function showTooltip(clientX, clientY, rows) {
  tooltipEl.innerHTML = rows
    .map((r) => {
      const valStr =
        r.value !== undefined && !Number.isNaN(r.value) ? `${r.value.toFixed(2)} ${r.units || ""}`.trim() : "sin dato";
      const timeStr = r.t ? `<span class="tt-time">${new Date(r.t).toLocaleTimeString()}</span>` : "";
      return `<div class="row"><span class="dot" style="background:${r.color}"></span><span class="tt-label">${r.label}:</span> <b>${valStr}</b> ${timeStr}</div>`;
    })
    .join("");
  tooltipEl.hidden = false;
  positionTooltip(clientX, clientY);
}

function positionTooltip(clientX, clientY) {
  const offset = 14;
  tooltipEl.style.left = "0px";
  tooltipEl.style.top = "0px";
  const rect = tooltipEl.getBoundingClientRect();
  let x = clientX + offset;
  let y = clientY + offset;
  if (x + rect.width > window.innerWidth) x = clientX - rect.width - offset;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height - offset;
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y}px`;
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

// --- Utilidades de gráfica compartidas (vivo + replay) ---------------------

/**
 * Ajusta el buffer de píxeles del canvas al tamaño real en pantalla (CSS)
 * multiplicado por devicePixelRatio, y escala el contexto para poder seguir
 * dibujando en coordenadas CSS. Sin esto, un canvas con width/height fijos
 * en el HTML se ve borroso/pixelado al estirarlo con CSS a un tamaño mayor
 * (que es justo lo que pasaba: 900x180 estirado a ~1900px de ancho real).
 */
function fitCanvasToDisplay(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth || canvas.width;
  const h = rect.height || canvas.clientHeight || canvas.height;
  const targetW = Math.max(1, Math.round(w * dpr));
  const targetH = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * Rango para el eje Y que ignora el 2% más extremo de los valores a cada
 * lado, en vez de min/max puro. Un solo frame corrupto (ej. el "salto" a
 * 2000 RPM que es ruido de sincronización, no el motor real) ya no aplasta
 * el resto de la gráfica a una franja delgada - los picos fuera de rango
 * simplemente se recortan visualmente contra el borde.
 */
function robustRange(values) {
  if (values.length < 8) {
    return { min: Math.min(...values), max: Math.max(...values) };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const p2 = at(0.02);
  const p98 = at(0.98);
  if (p98 - p2 < 1e-9) return { min: sorted[0], max: sorted[sorted.length - 1] };
  return { min: p2, max: p98 };
}

function drawChart(canvas, hist, { showLabels = false, hoverFrac = null } = {}) {
  if (!canvas || !hist || hist.length < 2) return;

  const { ctx, w, h } = fitCanvasToDisplay(canvas);
  ctx.clearRect(0, 0, w, h);

  const { min, max } = robustRange(hist);
  const range = max - min || 1;
  const padTop = showLabels ? 20 : 3;
  const padBottom = showLabels ? 20 : 3;

  if (showLabels) {
    ctx.strokeStyle = "#2a2f34";
    ctx.lineWidth = 1;
    [0, 0.5, 1].forEach((f) => {
      const y = padTop + f * (h - padTop - padBottom);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });

    ctx.fillStyle = "#8b939a";
    ctx.font = "12px -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(`max ${max.toFixed(2)}`, 6, padTop);
    ctx.fillText(`min ${min.toFixed(2)}`, 6, h - padBottom);
  }

  const plotY = (v) => {
    const y = h - padBottom - ((v - min) / range) * (h - padTop - padBottom);
    return Math.max(padTop, Math.min(h - padBottom, y));
  };

  ctx.beginPath();
  hist.forEach((v, i) => {
    const x = (i / (hist.length - 1)) * w;
    const y = plotY(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#5fb3a3";
  ctx.lineWidth = showLabels ? 2 : 1.5;
  ctx.stroke();

  if (hoverFrac != null) {
    const idx = Math.round(hoverFrac * (hist.length - 1));
    const x = (idx / (hist.length - 1)) * w;
    const y = plotY(hist[idx]);
    ctx.strokeStyle = "#8b939a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, h - padBottom);
    ctx.stroke();
    ctx.fillStyle = "#5fb3a3";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- Accesorios encendidos (checkboxes) -----------------------------------
// Mientras un check esté marcado, su etiqueta se escribe en la columna
// "evento" de CADA fila registrada (separadas por coma), no solo una vez.

function currentEventoText(autoAlertLabels = []) {
  const list = [...activeFlags, ...autoAlertLabels];
  if (otherFlagText.trim()) list.push(otherFlagText.trim());
  return list.join(", ");
}

function updateMarkerStatus() {
  if (!el.markerStatus) return;
  const text = currentEventoText();
  el.markerStatus.textContent = text ? `Marcando en el log: ${text}` : "Nada marcado como encendido.";
}

document.querySelectorAll(".checklist input[type='checkbox']").forEach((cb) => {
  cb.addEventListener("change", () => {
    if (cb.checked) activeFlags.add(cb.dataset.flag);
    else activeFlags.delete(cb.dataset.flag);
    updateMarkerStatus();
  });
});

el.markerOther.addEventListener("input", () => {
  otherFlagText = el.markerOther.value;
  updateMarkerStatus();
});

updateMarkerStatus();

// --- Replay / comparación de logs CSV -------------------------------------

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvLog(text, filename) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) throw new Error("El CSV está vacío o no tiene filas de datos.");

  const headerCells = splitCsvLine(lines[0]);
  const columns = [];
  headerCells.forEach((h, idx) => {
    if (idx === 0) return; // timestamp_iso
    if (/^evento$/i.test(h) || /^fuera_de_rango$/i.test(h) || /^raw_frame$/i.test(h)) return;
    const m = h.match(/^(.*)\s\((.*)\)$/);
    columns.push({ idx, key: m ? m[1] : h, units: m ? m[2] : "" });
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const t = Date.parse(cells[0]);
    const values = {};
    columns.forEach((c) => {
      const raw = cells[c.idx];
      if (raw !== undefined && raw !== "") values[c.key] = parseFloat(raw);
    });
    rows.push({ t, values });
  }

  return { name: filename, columns, rows };
}

function drawOverlayChart(canvas, seriesA, seriesB, { hoverFrac = null } = {}) {
  if (!canvas || seriesA.length < 2) return;
  const { ctx, w, h } = fitCanvasToDisplay(canvas);
  ctx.clearRect(0, 0, w, h);

  const all = seriesB && seriesB.length ? seriesA.concat(seriesB) : seriesA;
  const { min, max } = robustRange(all);
  const range = max - min || 1;
  const padTop = 20;
  const padBottom = 20;

  ctx.strokeStyle = "#2a2f34";
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach((f) => {
    const y = padTop + f * (h - padTop - padBottom);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  });
  ctx.fillStyle = "#8b939a";
  ctx.font = "12px -apple-system, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(`max ${max.toFixed(2)}`, 6, padTop);
  ctx.fillText(`min ${min.toFixed(2)}`, 6, h - padBottom);

  const plotY = (v) => {
    const y = h - padBottom - ((v - min) / range) * (h - padTop - padBottom);
    return Math.max(padTop, Math.min(h - padBottom, y));
  };

  const plot = (series, color) => {
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = plotY(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  plot(seriesA, "#5fb3a3");
  if (seriesB && seriesB.length > 1) plot(seriesB, "#e0b84c");

  if (hoverFrac != null) {
    const idxA = Math.round(hoverFrac * (seriesA.length - 1));
    const x = (idxA / (seriesA.length - 1)) * w;
    ctx.strokeStyle = "#8b939a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, h - padBottom);
    ctx.stroke();

    const dot = (series, color) => {
      if (!series || series.length < 2) return;
      const idx = Math.round(hoverFrac * (series.length - 1));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, plotY(series[idx]), 3.5, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(seriesA, "#5fb3a3");
    dot(seriesB, "#e0b84c");
  }
}

// --- Zoom / pan en las gráficas de replay -----------------------------------
// Ventana compartida por todas las gráficas del replay: rueda del mouse para
// acercar/alejar (centrado en el cursor), arrastrar para mover, doble clic
// para resetear. Redibuja solo los canvas (no reconstruye el DOM), así el
// arrastre se siente fluido.

/** Extrae {values, times} de una columna, manteniendo values[i]/times[i] alineados. */
function seriesWithTimes(rows, key) {
  const values = [];
  const times = [];
  rows.forEach((r) => {
    const v = r.values[key];
    if (v !== undefined && !Number.isNaN(v)) {
      values.push(v);
      times.push(r.t);
    }
  });
  return { values, times };
}

function sliceByZoom(values, times, zoom) {
  if (values.length < 2) return { values, times };
  const startIdx = Math.max(0, Math.floor(zoom.start * (values.length - 1)));
  const endIdx = Math.min(values.length - 1, Math.ceil(zoom.end * (values.length - 1)));
  const v = values.slice(startIdx, endIdx + 1);
  const t = times.slice(startIdx, endIdx + 1);
  return v.length >= 2 ? { values: v, times: t } : { values, times };
}

function redrawReplayCharts() {
  const a = replayLogs.A;
  const b = replayLogs.B;
  if (!a) return;

  currentReplayCanvases.forEach((entry) => {
    const fullA = seriesWithTimes(a.rows, entry.key);
    const fullB = b ? seriesWithTimes(b.rows, entry.key) : null;
    const slicedA = sliceByZoom(fullA.values, fullA.times, replayZoom);
    const slicedB = fullB ? sliceByZoom(fullB.values, fullB.times, replayZoom) : null;

    entry.seriesA = slicedA.values;
    entry.timesA = slicedA.times;
    entry.seriesB = slicedB ? slicedB.values : null;
    entry.timesB = slicedB ? slicedB.times : null;

    drawOverlayChart(entry.canvas, entry.seriesA, entry.seriesB);
  });

  const hint = document.getElementById("replay-zoom-hint");
  if (hint) {
    const pct = Math.round((replayZoom.end - replayZoom.start) * 100);
    hint.textContent = pct >= 100 ? "" : `Mostrando ${pct}% de la sesión`;
  }
}

function zoomReplayAt(canvas, clientX, factor) {
  const rect = canvas.getBoundingClientRect();
  const cursorFrac = rect.width ? (clientX - rect.left) / rect.width : 0.5;
  const pointFrac = replayZoom.start + cursorFrac * (replayZoom.end - replayZoom.start);
  const currentWidth = replayZoom.end - replayZoom.start;
  const newWidth = Math.max(0.02, Math.min(1, currentWidth * factor));
  let newStart = pointFrac - (pointFrac - replayZoom.start) * (newWidth / currentWidth);
  let newEnd = newStart + newWidth;
  if (newStart < 0) {
    newEnd -= newStart;
    newStart = 0;
  }
  if (newEnd > 1) {
    newStart -= newEnd - 1;
    newEnd = 1;
  }
  replayZoom = { start: Math.max(0, newStart), end: Math.min(1, newEnd) };
  redrawReplayCharts();
}

function attachZoomPan(entry) {
  const canvas = entry.canvas;
  if (!canvas) return;
  canvas.style.cursor = "grab";
  canvas.addEventListener(
    "wheel",
    (evt) => {
      evt.preventDefault();
      zoomReplayAt(canvas, evt.clientX, evt.deltaY < 0 ? 0.85 : 1 / 0.85);
    },
    { passive: false }
  );
  canvas.addEventListener("mousedown", (evt) => {
    replayDragState = { startX: evt.clientX, startZoom: { ...replayZoom }, canvas };
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("dblclick", () => {
    replayZoom = { start: 0, end: 1 };
    redrawReplayCharts();
  });

  canvas.addEventListener("mousemove", (evt) => {
    if (replayDragState || !entry.seriesA || entry.seriesA.length < 2) return;
    const frac = fracXFromEvent(canvas, evt);
    if (frac == null) return;

    const idxA = Math.round(frac * (entry.seriesA.length - 1));
    const rows = [
      { label: replayLogs.A.name, value: entry.seriesA[idxA], units: entry.units, t: entry.timesA[idxA], color: "#5fb3a3" },
    ];
    if (entry.seriesB && entry.seriesB.length > 1) {
      const idxB = Math.round(frac * (entry.seriesB.length - 1));
      rows.push({
        label: replayLogs.B.name,
        value: entry.seriesB[idxB],
        units: entry.units,
        t: entry.timesB[idxB],
        color: "#e0b84c",
      });
    }
    showTooltip(evt.clientX, evt.clientY, rows);
    drawOverlayChart(canvas, entry.seriesA, entry.seriesB, { hoverFrac: frac });
  });

  canvas.addEventListener("mouseleave", () => {
    hideTooltip();
    if (entry.seriesA) drawOverlayChart(canvas, entry.seriesA, entry.seriesB);
  });
}

window.addEventListener("mousemove", (evt) => {
  if (!replayDragState) return;
  const rect = replayDragState.canvas.getBoundingClientRect();
  const width = replayDragState.startZoom.end - replayDragState.startZoom.start;
  const deltaFrac = rect.width ? ((evt.clientX - replayDragState.startX) / rect.width) * width : 0;
  let newStart = replayDragState.startZoom.start - deltaFrac;
  let newEnd = replayDragState.startZoom.end - deltaFrac;
  if (newStart < 0) {
    newStart = 0;
    newEnd = width;
  }
  if (newEnd > 1) {
    newEnd = 1;
    newStart = 1 - width;
  }
  replayZoom = { start: newStart, end: newEnd };
  redrawReplayCharts();
});

window.addEventListener("mouseup", () => {
  if (replayDragState) {
    replayDragState.canvas.style.cursor = "grab";
    replayDragState = null;
  }
});

function renderReplay() {
  const a = replayLogs.A;
  const b = replayLogs.B;
  if (!a) {
    viewMode = "live";
    currentReplayCanvases = [];
    renderMain();
    return;
  }

  viewMode = "replay";
  replayZoom = { start: 0, end: 1 };
  updateAlertBanner([]);

  el.main.innerHTML = `
    <h3>Replay: ${a.name}${b ? ` vs ${b.name}` : ""}</h3>
    <div class="replay-legend">
      <span><span class="dot" style="background:#5fb3a3;"></span>${a.name} (${a.rows.length} muestras)</span>
      ${b ? `<span><span class="dot" style="background:#e0b84c;"></span>${b.name} (${b.rows.length} muestras)</span>` : ""}
      <span class="replay-zoom-controls">
        <button id="replay-zoom-reset" type="button" class="close-chart">Reset zoom</button>
        <span id="replay-zoom-hint" class="hint"></span>
      </span>
    </div>
    <div class="hint" style="margin-bottom:12px;">Rueda del mouse: zoom · arrastrar: mover · doble clic: reset.${
      !b ? " Carga un segundo log (Log B) para comparar ambos superpuestos." : ""
    }</div>
    <div class="param-list replay-list">
      ${a.columns
        .map(
          (c) => `
        <div class="chart-expanded replay-card">
          <div class="chart-expanded-header">
            <span>${c.key} <span class="units">${c.units}</span></span>
          </div>
          <canvas class="sparkline-big" data-key="${c.key}"></canvas>
        </div>
      `
        )
        .join("")}
    </div>
  `;

  currentReplayCanvases = a.columns.map((c) => ({
    key: c.key,
    units: c.units,
    canvas: el.main.querySelector(`canvas[data-key="${CSS.escape(c.key)}"]`),
    seriesA: null,
    seriesB: null,
    timesA: null,
    timesB: null,
  }));
  currentReplayCanvases.forEach((entry) => attachZoomPan(entry));
  document.getElementById("replay-zoom-reset").addEventListener("click", () => {
    replayZoom = { start: 0, end: 1 };
    redrawReplayCharts();
  });

  redrawReplayCharts();
}

async function handleReplayFile(file, slot) {
  if (!file) return;
  try {
    const text = await file.text();
    replayLogs[slot] = parseCsvLog(text, file.name);
    renderReplay();
  } catch (err) {
    alert("Error al leer el CSV: " + err.message);
    console.error(err);
  }
}

el.replayInputA.addEventListener("change", (evt) => handleReplayFile(evt.target.files[0], "A"));
el.replayInputB.addEventListener("change", (evt) => handleReplayFile(evt.target.files[0], "B"));

el.replayClearBtn.addEventListener("click", () => {
  replayLogs = { A: null, B: null };
  el.replayInputA.value = "";
  el.replayInputB.value = "";
  renderReplay();
});

// --- Log de sesión ---------------------------------------------------------

el.downloadLogBtn.addEventListener("click", downloadLog);

el.clearLogBtn.addEventListener("click", async () => {
  await persistCurrentSession();
  sessionLog = [];
  updateLogCount();
  startNewSession();
});

el.main.addEventListener("click", (evt) => {
  if (viewMode === "replay") return;
  const card = evt.target.closest(".param-card");
  if (!card) return;
  const id = card.dataset.paramId;
  expandedParamId = expandedParamId === id ? null : id;
  renderMain();
});

// Selector manual de a qué parámetro en vivo corresponde cada eje de una
// tabla, para cuando el auto-match (por nombre) falla o adivina mal.
el.main.addEventListener("change", (evt) => {
  const sel = evt.target.closest(".axis-select");
  if (!sel) return;
  axisOverrides[`${sel.dataset.tableIdx}:${sel.dataset.axis}`] = sel.value;
  renderMain();
});

// Tooltip al pasar el cursor sobre las gráficas en vivo (tarjetas pequeñas y
// la grande expandida). Delegado en el.main (que no se reemplaza en cada
// render, solo su contenido) para no tener que reenganchar listeners en
// cada actualización de datos.
function liveParamForCanvas(canvas) {
  if (canvas.classList.contains("sparkline-big")) {
    return loadedParams.find((p) => p.id === expandedParamId) || null;
  }
  const card = canvas.closest(".param-card");
  return card ? loadedParams.find((p) => p.id === card.dataset.paramId) || null : null;
}

el.main.addEventListener("mousemove", (evt) => {
  if (viewMode === "replay") return;
  const canvas = evt.target.closest("canvas.sparkline, canvas.sparkline-big");
  if (!canvas) return;
  const param = liveParamForCanvas(canvas);
  const hist = param && paramHistory[param.id];
  if (!param || !hist || hist.length < 2) return;

  const frac = fracXFromEvent(canvas, evt);
  if (frac == null) return;
  const idx = Math.round(frac * (hist.length - 1));
  const times = paramHistoryTimes[param.id];
  showTooltip(evt.clientX, evt.clientY, [
    { label: param.name, value: hist[idx], units: param.units, t: times ? times[idx] : null, color: "#5fb3a3" },
  ]);
  drawChart(canvas, hist, { showLabels: canvas.classList.contains("sparkline-big"), hoverFrac: frac });
});

el.main.addEventListener("mouseout", (evt) => {
  const canvas = evt.target.closest("canvas.sparkline, canvas.sparkline-big");
  if (!canvas || canvas.contains(evt.relatedTarget)) return;
  hideTooltip();
  const param = liveParamForCanvas(canvas);
  if (param && paramHistory[param.id]) {
    drawChart(canvas, paramHistory[param.id], { showLabels: canvas.classList.contains("sparkline-big") });
  }
});

updateLogCount();
renderMain();
startNewSession();
refreshSessionList();
