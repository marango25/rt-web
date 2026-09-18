/**
 * ws-client.js
 *
 * Cliente WebSocket hacia el ESP8266. El firmware manda frames así:
 *   { "t": <millis>, "raw": [byte0, byte1, ...] }
 *
 * onFrame(frameBytes) se llama por cada frame crudo recibido; quien use
 * este cliente decide cómo decodificarlo (con el ADX cargado).
 */
export class RTBridgeClient {
  constructor({ onFrame, onStatus }) {
    this.ws = null;
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this._reconnectTimer = null;
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
        if (Array.isArray(msg.raw)) this.onFrame(msg.raw, msg.t);
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
