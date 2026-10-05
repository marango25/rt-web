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
 * Reconexión automática: a diferencia de un cable que se sale físicamente,
 * en pruebas reales el corte típico es el chip USB-serial (CH340/CP2102) del
 * NodeMCU reiniciándose solo por ruido eléctrico del auto con el motor
 * encendido (ver docs/electronica.md - el pin A del ALDL ata la tierra del
 * NodeMCU a la del vehículo, así que el ruido del motor/alternador puede
 * colarse por ahí hasta el puerto USB) - el ESP8266 en sí sigue corriendo,
 * solo se cae el enlace USB visto desde el navegador. Como el permiso del
 * puerto ya lo dio el usuario una vez, reabrir NO necesita un gesto nuevo
 * (a diferencia de requestPort()), así que tras un corte no propio de
 * disconnect() reintentamos solos: de inmediato si navigator.serial avisa
 * que el puerto volvió a aparecer, y si no, cada RECONNECT_DELAY_MS.
 *
 * Límite real (confirmado en el camión el 2026-10-02): el NodeMCU del usuario trae un
 * CH340 (USB 0x1A86:0x7523) SIN número de serie. Chrome solo reconoce como "el mismo"
 * aparato uno con vendor + producto + número de serie iguales, así que cuando el CH340
 * se reinicia y vuelve a aparecer, para el navegador es un aparato nuevo sin permiso:
 * el SerialPort viejo ya no abre y no llega ningún evento "connect". Por eso, tras
 * MAX_RECONNECT_ATTEMPTS intentos fallidos se deja de reintentar en silencio y se pasa
 * al estado "perdido", donde la UI ofrece "Reconectar USB" (un clic + elegir el puerto).
 * Si el navegador sí devuelve el aparato (getPorts() o evento "connect" con el mismo
 * vendor/producto, p. ej. con un adaptador que sí tiene número de serie), se reabre solo.
 */

const BAUD_RATE = 115200;
const FRAME_LINE = /Frame ALDL(?:\s*\((\d+)\s*baud[^)]*\))?:\s*((?:[0-9A-Fa-f]{2}\s*)+)$/;
const MAX_LINE_BUFFER = 4096; // si llega basura sin ningún salto de línea, no dejar crecer el buffer sin límite
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 3;

function sameDevice(a, b) {
  return Boolean(a && b && a.usbVendorId !== undefined && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId);
}

export class SerialBridgeClient {
  constructor({ onFrame, onStatus, reconnectDelayMs = RECONNECT_DELAY_MS, maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS }) {
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.reconnectDelayMs = reconnectDelayMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this._portInfo = null; // { usbVendorId, usbProductId } del puerto elegido, para reconocerlo si reaparece
    this._failedReopens = 0;
    this.lost = false; // true cuando ya no se puede reabrir sin un clic (ver "perdido" arriba)
    this.port = null; // solo no-null mientras el puerto está abierto y leyendo
    this.reader = null;
    this.connected = false;
    this._closing = false;
    this._loopDone = null;

    this._grantedPort = null; // puerto ya autorizado por el usuario - se conserva tras un corte
                               // para poder reabrirlo sin el diálogo de permiso (ese sí exige clic)
    this._wantConnected = false; // true desde que connect() consigue puerto hasta un disconnect() a propósito
    this._opening = false; // evita dos reaperturas al mismo tiempo (timer + evento "connect" juntos)
    this._reconnectTimer = null;

    this._onPortConnect = this._onPortConnect.bind(this);
    if (SerialBridgeClient.supported) {
      // Se dispara cuando un puerto YA autorizado reaparece en el bus USB - el caso típico
      // aquí es el chip USB-serial reiniciándose solo por ruido, no un cable real reconectado.
      navigator.serial.addEventListener("connect", this._onPortConnect);
    }
  }

  static get supported() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /** true mientras estamos entre un corte no pedido y el siguiente intento de reabrir
   * (para que la UI pueda distinguirlo de "nunca conectado" y ofrecer cancelar en vez
   * de abrir el diálogo de puerto de nuevo). */
  get reconnecting() {
    return this._wantConnected && !this.connected;
  }

  /** Debe llamarse desde un click: requestPort() exige un gesto del usuario. */
  async connect() {
    if (!SerialBridgeClient.supported) {
      this.onStatus("error", "Web Serial no disponible: usa Chrome/Edge en http://localhost");
      return;
    }

    clearTimeout(this._reconnectTimer);
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

    this._grantedPort = port;
    this._portInfo = typeof port.getInfo === "function" ? port.getInfo() : null;
    this._wantConnected = true;
    this.lost = false;
    this._failedReopens = 0;
    await this._openPort(port, false);
  }

  /** Abre (o reabre) un puerto ya autorizado. No pide permiso - sirve tanto para la
   * primera conexión (llamada desde connect(), isReconnect=false) como para las
   * reconexiones automáticas. */
  async _openPort(port, isReconnect = true) {
    if (this._opening || this.connected) return;
    this._opening = true;
    try {
      await port.open({ baudRate: BAUD_RATE });
    } catch (err) {
      this._opening = false;
      console.warn("Web Serial open() falló:", err);
      if (isReconnect) {
        this._failedReopens++;
        if (this._failedReopens >= this.maxReconnectAttempts) {
          this._giveUp();
        } else {
          this.onStatus("reconectando", "USB - reintentando...");
          this._scheduleReconnect();
        }
      } else {
        // Primer intento tras el clic: el fallo casi siempre tiene una causa
        // concreta y accionable (otro programa con el puerto abierto). Reintentar
        // en silencio la esconde detrás de un "reconectando..." eterno, así que
        // aquí se muestra el motivo y se cancela la reconexión automática.
        this._wantConnected = false;
        this.onStatus("error", "no se pudo abrir el puerto - ¿lo tiene abierto el Monitor Serie de Arduino?");
      }
      return;
    }

    this._opening = false;
    this.port = port;
    this.connected = true;
    this._closing = false;
    this._failedReopens = 0;
    this.lost = false;
    this.onStatus("conectado", "USB");
    this._loopDone = this._readLoop(port);
  }

  /** Ya no hay forma de reabrir sin que el usuario elija el puerto otra vez. */
  _giveUp() {
    clearTimeout(this._reconnectTimer);
    this._wantConnected = false;
    this.lost = true;
    this.onStatus("perdido", "USB: haz clic en Reconectar USB y elige el puerto");
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (!this._wantConnected) return;
      // Si el navegador ya nos devuelve el aparato (mismo vendor/producto) como otro
      // SerialPort, usar ese: el objeto viejo no vuelve a abrir tras un reinicio del chip.
      try {
        const ports = await navigator.serial.getPorts();
        const again = ports.find((p) => p !== this._grantedPort && sameDevice(p.getInfo?.(), this._portInfo));
        if (again) this._grantedPort = again;
      } catch {
        // sin getPorts(): seguir con el puerto que ya teníamos
      }
      if (this._wantConnected && this._grantedPort) this._openPort(this._grantedPort);
    }, this.reconnectDelayMs);
  }

  _onPortConnect(evt) {
    if (this.connected || !(this._wantConnected || this.lost)) return;
    const port = evt.target;
    if (port !== this._grantedPort && !sameDevice(port?.getInfo?.(), this._portInfo)) return;
    clearTimeout(this._reconnectTimer);
    this._grantedPort = port;
    this._wantConnected = true;
    this.lost = false;
    this._failedReopens = 0;
    this._openPort(port);
  }

  async disconnect() {
    this._wantConnected = false;
    clearTimeout(this._reconnectTimer);
    if (this.lost) {
      this.lost = false;
      this.onStatus("desconectado", "USB");
      return;
    }
    if (!this.port) {
      // No hay lectura activa que cerrar - o nunca se conectó, o esto cancela un
      // reintento automático en curso (ver reconnecting). En ese segundo caso avisa,
      // porque si no la UI se queda mostrando "reconectando" para siempre.
      if (this.connected === false) this.onStatus("desconectado", "USB");
      return;
    }
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
    // desconectado, o el chip USB-serial reiniciándose solo) lo dejan en null y el while termina.
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

    if (userInitiated) {
      this.onStatus("desconectado", "USB");
    } else {
      this.onStatus("reconectando", "USB desconectado - reintentando...");
      if (this._wantConnected) this._scheduleReconnect();
    }
  }

  _handleLine(line) {
    const m = line.trim().match(FRAME_LINE);
    if (!m) return;
    const bytes = m[2].trim().split(/\s+/).map((h) => parseInt(h, 16));
    this.onFrame(bytes, Math.round(performance.now()), m[1]); // m[1]: "160"/"8192", o undefined en firmwares viejos
  }
}
