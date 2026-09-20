/**
 * firmware-link.js
 *
 * Apretón de manos web <-> firmware, igual sobre WebSocket que sobre USB (Serial):
 *
 *   web -> {"cmd":"hello"}                        (se repite hasta que conteste)
 *   fw  -> {"hello":{"fw":"2.0.0-alpha.1","caps":["profile"]}}
 *   web -> {"cmd":"profile","baud":"160","frameBytes":20,"promIdIndex":1,"promId":[2,39]}
 *   fw  -> {"profile":{...el perfil que aplicó...}}   o   {"profileError":"motivo"}
 *
 * Un firmware v1 ignora todo lo que le llega, así que nunca contesta el hello: tras
 * `helloTimeoutMs` la app concluye "firmware v1" y usa los valores fijos del Sonoma
 * (V1_PROFILE). Lo importante es que la app SEPA si el perfil se aplicó, en vez de
 * suponerlo: un perfil que el firmware no aplicó se traduce en frames mal alineados.
 *
 * Sin dependencias del DOM ni de timers globales (se inyectan), para probarlo con node.
 */

import { normalizeProfile, profilesEqual, profileToCommand, v1FirmwareCanRun } from "./protocol-profile.js";

/*
 * Fases:
 *  idle        sin conexión
 *  waiting     conexión abierta, esperando el hello
 *  v1          nadie contestó el hello (o contestó sin la capacidad "profile"): firmware v1
 *  sending     perfil enviado, falta la confirmación
 *  applied     el firmware confirmó exactamente el perfil pedido
 *  mismatch    el firmware confirmó OTRO perfil distinto del pedido
 *  rejected    el firmware rechazó el perfil (o no se pudo enviar)
 *  unconfirmed  se envió y no hubo respuesta a tiempo
 */
export class FirmwareLink {
  constructor({
    send,
    getProfile,
    onChange,
    helloTimeoutMs = 3000, // ojo: por USB la placa puede reiniciarse al abrir el puerto y tarda ~1-2 s en volver a hablar
    helloRetryMs = 1000,
    ackTimeoutMs = 6000, // el firmware aplica el perfil entre frames, y esperar un frame puede tardar hasta ~3 s con la llave apagada
    // Envueltos en flechas a propósito: llamar this.setTimer(...) invocaría setTimeout con `this` = esta
    // instancia, y el navegador lo rechaza con "Illegal invocation" (node no, por eso pasó las pruebas).
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  }) {
    this.send = send; // (obj) => boolean: false si no hay conexión abierta
    this.getProfile = getProfile; // () => perfil que la definición cargada quiere en este momento
    this.onChange = onChange || (() => {});
    this.helloTimeoutMs = helloTimeoutMs;
    this.helloRetryMs = helloRetryMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._timer = null;
    this._helloAttempts = 0;
    this.state = this._blankState();
  }

  _blankState() {
    return { phase: "idle", fw: null, requested: null, applied: null, error: "", canRunOnV1: true };
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.state);
  }

  _stopTimer() {
    this.clearTimer(this._timer);
    this._timer = null;
  }

  /** La conexión (WebSocket o USB) acaba de abrirse. */
  begin() {
    this._stopTimer();
    this._helloAttempts = 0;
    this.state = this._blankState();
    this._set({ phase: "waiting" });
    this._pingHello();
  }

  /** La conexión se cerró. */
  reset() {
    this._stopTimer();
    this.state = this._blankState();
    this.onChange(this.state);
  }

  _pingHello() {
    this.send({ cmd: "hello" });
    this._helloAttempts++;
    this._timer = this.setTimer(() => {
      if (this.state.phase !== "waiting") return;
      if (this._helloAttempts * this.helloRetryMs >= this.helloTimeoutMs) this._assumeV1();
      else this._pingHello();
    }, this.helloRetryMs);
  }

  _assumeV1() {
    this._stopTimer();
    this._set({ phase: "v1", fw: null, canRunOnV1: v1FirmwareCanRun(this.getProfile()) });
  }

  handleControl(msg) {
    if (this.state.phase === "idle") return; // llegó tarde, ya cerramos la conexión
    if (msg.hello && typeof msg.hello === "object") {
      // Cualquier hello (también uno tardío o repetido) reinicia el envío: si la placa se
      // reinició a mitad de sesión, volvió a los valores compilados y hay que reenviar el perfil.
      const caps = Array.isArray(msg.hello.caps) ? msg.hello.caps : [];
      const fw = String(msg.hello.fw ?? "desconocido");
      this._stopTimer();
      if (caps.includes("profile")) {
        this.state.fw = fw;
        this._sendProfile();
      } else {
        this._set({ phase: "v1", fw, canRunOnV1: v1FirmwareCanRun(this.getProfile()) });
      }
    } else if (msg.profile && typeof msg.profile === "object") {
      this._handleProfileEcho(msg.profile);
    } else if (typeof msg.profileError === "string") {
      this._stopTimer();
      this._set({ phase: "rejected", error: msg.profileError });
    }
  }

  _handleProfileEcho(echo) {
    this._stopTimer();
    let applied;
    try {
      applied = normalizeProfile(echo);
    } catch (err) {
      this._set({ phase: "rejected", error: `el firmware devolvió un perfil ilegible (${err.message})` });
      return;
    }
    const same = this.state.requested && profilesEqual(applied, this.state.requested);
    this._set({ phase: same ? "applied" : "mismatch", applied, error: "" });
  }

  /** Se cargó otra definición con la conexión abierta: si hay un firmware v2, hay que mandarle el perfil nuevo. */
  profileChanged() {
    const { phase } = this.state;
    if (["sending", "applied", "mismatch", "rejected", "unconfirmed"].includes(phase)) {
      this._sendProfile();
    } else if (phase === "v1") {
      this._set({ canRunOnV1: v1FirmwareCanRun(this.getProfile()) });
    }
    // waiting / idle: el hello (o el veredicto v1) leerá getProfile() cuando llegue.
  }

  _sendProfile() {
    this._stopTimer();
    const requested = this.getProfile();
    if (!this.send(profileToCommand(requested))) {
      this._set({ phase: "rejected", requested, applied: null, error: "no se pudo enviar el perfil (sin conexión)" });
      return;
    }
    this._set({ phase: "sending", requested, applied: null, error: "" });
    this._timer = this.setTimer(() => {
      if (this.state.phase === "sending") this._set({ phase: "unconfirmed" });
    }, this.ackTimeoutMs);
  }
}
