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
        if (Array.isArray(msg.raw)) this.onFrame(msg.raw, msg.t, msg.proto);
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
