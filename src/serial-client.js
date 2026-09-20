/**
 * serial-client.js
 *
 * Alternativa al WebSocket (ws-client.js) para cuando el ESP8266 está conectado
 * por USB: lee los frames directo del puerto serial con la Web Serial API.
 * No usa ninguna red WiFi, así que la computadora conserva su internet normal.
 *
 * Solo funciona en Chrome/Edge, y solo en contexto seguro (https o
 * http://localhost) - en cualquier otro caso navigator.serial no existe.
 *
 * El firmware ya imprime cada frame válido por serial (115200 baud) como una
 * línea de texto:
 *   Frame ALDL (160 baud): 20 02 27 6A 39 00 4C 18 16 80 6E 00 00 00 00 90 83 06 80 4B
 * (las versiones viejas del firmware la imprimen sin el "(160 baud)"). Todo lo
 * demás que salga por el puerto (mensajes de arranque, "Sin datos ALDL...")
 * se ignora. Se llama onFrame(bytes, t, proto) igual que ws-client.js.
 *
 * Un firmware v2 además habla JSON por líneas en ambos sentidos: las líneas que
 * empiezan con "{" ({"hello":...}, {"profile":...}, ver firmware-link.js) se
 * entregan a onControl(msg), y send(obj) escribe un comando como una línea. Un
 * firmware v1 no lee el puerto, así que nunca contesta.
 */

const BAUD_RATE = 115200;
const FRAME_LINE = /Frame ALDL(?:\s*\((\d+)\s*baud[^)]*\))?:\s*((?:[0-9A-Fa-f]{2}\s*)+)$/;
const MAX_LINE_BUFFER = 4096; // si llega basura sin ningún salto de línea, no dejar crecer el buffer sin límite

export class SerialBridgeClient {
  constructor({ onFrame, onControl, onStatus }) {
    this.onFrame = onFrame || (() => {});
    this.onControl = onControl || (() => {});
    this.onStatus = onStatus || (() => {});
    this.port = null;
    this.reader = null;
    this.connected = false;
    this._closing = false;
    this._loopDone = null;
    this._writeChain = Promise.resolve(); // un getWriter() a la vez: si está bloqueado, write() lanza TypeError
  }

  /** Devuelve false si no hay puerto abierto. La escritura en sí es asíncrona y sus errores no se propagan. */
  send(obj) {
    const port = this.port;
    if (!this.connected || !port?.writable) return false;
    const line = new TextEncoder().encode(JSON.stringify(obj) + "\n");
    this._writeChain = this._writeChain
      .then(async () => {
        const writer = port.writable.getWriter();
        try {
          await writer.write(line);
        } finally {
          writer.releaseLock();
        }
      })
      .catch((err) => console.warn("Web Serial write() falló:", err));
    return true;
  }

  static get supported() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /** Debe llamarse desde un click: requestPort() exige un gesto del usuario. */
  async connect() {
    if (!SerialBridgeClient.supported) {
      this.onStatus("error", "Web Serial no disponible: usa Chrome/Edge en http://localhost");
      return;
    }

    this.onStatus("conectando", "USB");
    let port;
    try {
      port = await navigator.serial.requestPort();
    } catch (err) {
      // Cerrar el selector de puertos sin elegir ninguno no es un error.
      if (err.name === "NotFoundError") this.onStatus("sin conectar");
      else this.onStatus("error", err.message);
      return;
    }

    try {
      await port.open({ baudRate: BAUD_RATE });
    } catch (err) {
      this.onStatus("error", "no se pudo abrir el puerto - ¿lo tiene abierto el Monitor Serie de Arduino?");
      console.warn("Web Serial open() falló:", err);
      return;
    }

    this.port = port;
    this.connected = true;
    this._closing = false;
    this.onStatus("conectado", "USB");
    this._loopDone = this._readLoop(port);
  }

  async disconnect() {
    if (!this.port) return;
    this._closing = true;
    try {
      await this.reader?.cancel(); // hace que read() devuelva done=true y termine el loop de lectura
    } catch {
      // si ya estaba cancelado/cerrado, no hay nada más que hacer
    }
    await this._loopDone;
  }

  async _readLoop(port) {
    const decoder = new TextDecoder();
    let buffer = "";

    // Patrón canónico de Web Serial: los errores no fatales (framing, overrun) dejan
    // port.readable vivo y se reintenta con un reader nuevo; los fatales (cable
    // desconectado) lo dejan en null y el while termina.
    while (port.readable && !this._closing) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            this._handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
          if (buffer.length > MAX_LINE_BUFFER) buffer = "";
        }
      } catch (err) {
        console.warn("Error de lectura serial:", err);
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }

    const userInitiated = this._closing;
    try {
      await port.close();
    } catch {
      // ya estaba cerrado (típico si se desconectó el cable)
    }
    this.port = null;
    this.connected = false;
    this._closing = false;

    if (userInitiated) this.onStatus("desconectado", "USB");
    else this.onStatus("error", "USB desconectado");
  }

  _handleLine(line) {
    const text = line.trim();
    if (text.startsWith("{")) {
      try {
        this.onControl(JSON.parse(text));
      } catch {
        console.warn("Línea de control no parseable:", text);
      }
      return;
    }

    const m = text.match(FRAME_LINE);
    if (!m) return;
    const bytes = m[2].trim().split(/\s+/).map((h) => parseInt(h, 16));
    this.onFrame(bytes, Math.round(performance.now()), m[1]); // m[1]: "160"/"8192", o undefined en firmwares viejos
  }
}
