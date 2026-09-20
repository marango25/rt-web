/**
 * ws-client.js
 *
 * Cliente WebSocket hacia el ESP8266. El firmware manda frames así:
 *   { "t": <millis>, "proto": "160"|"8192", "raw": [byte0, byte1, ...] }
 *
 * "proto" indica en qué protocolo el firmware autodetectó y leyó ese frame
 * (ver esp8266_aldl_bridge.ino). "8192" son bytes crudos sin frame/checksum
 * validado todavía - quien use este cliente debería avisar al usuario en
 * vez de decodificarlos como si fueran del A040 (160 baud).
 *
 * onFrame(frameBytes, t, proto) se llama por cada frame crudo recibido;
 * quien use este cliente decide cómo decodificarlo (con el ADX cargado).
 *
 * Los mensajes que no son frames ({"hello":...}, {"profile":...}, {"profileError":...},
 * ver firmware-link.js) se entregan a onControl(msg). Un firmware v1 nunca los manda.
 * send(obj) manda un comando al firmware; un firmware v1 lo ignora.
 */
export class RTBridgeClient {
  constructor({ onFrame, onControl, onStatus }) {
    this.ws = null;
    this.onFrame = onFrame || (() => {});
    this.onControl = onControl || (() => {});
    this.onStatus = onStatus || (() => {});
    this._reconnectTimer = null;
  }

  /** Devuelve false si no hay un WebSocket abierto (el comando no se mandó). */
  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  connect(host) {
    this.disconnect();
    const url = `ws://${host}/ws`;
    this.onStatus("conectando", url);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.onStatus("error", err.message);
      return;
    }

    this.ws.onopen = () => this.onStatus("conectado", url);
    this.ws.onclose = () => {
      this.onStatus("desconectado", url);
      this._scheduleReconnect(host);
    };
    this.ws.onerror = () => this.onStatus("error", url);

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (Array.isArray(msg.raw)) this.onFrame(msg.raw, msg.t, msg.proto);
        else if (msg && typeof msg === "object") this.onControl(msg);
      } catch (err) {
        console.warn("Frame no parseable:", evt.data);
      }
    };
  }

  _scheduleReconnect(host) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(host), 3000);
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null; // evita auto-reconexión al cerrar a propósito
      this.ws.close();
      this.ws = null;
    }
  }
}
