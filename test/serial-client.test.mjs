// Reconexión del modo USB con un navigator.serial falso: el CH340 del NodeMCU no tiene
// número de serie, así que tras reiniciarse el navegador ya no lo reabre solo.
import { test } from "node:test";
import assert from "node:assert/strict";

const INFO = { usbVendorId: 0x1a86, usbProductId: 0x7523 };

class FakePort {
  constructor(info = INFO) {
    this.info = info;
    this.openFails = false;
    this.readable = null;
    this._ctrl = null;
  }
  getInfo() {
    return this.info;
  }
  async open() {
    if (this.openFails) throw new Error("The device has been lost.");
    this.readable = new ReadableStream({ start: (c) => (this._ctrl = c) });
  }
  async close() {
    this.readable = null;
  }
  sendLine(text) {
    this._ctrl.enqueue(new TextEncoder().encode(text + "\n"));
  }
  /** Simula que el chip USB-serial se reinicia: el stream muere y el objeto ya no abre. */
  drop() {
    this.openFails = true;
    const c = this._ctrl;
    this.readable = null;
    c.error(new Error("device lost"));
  }
}

function fakeSerial() {
  const listeners = [];
  const serial = {
    ports: [],
    nextPick: null,
    async requestPort() {
      return serial.nextPick;
    },
    async getPorts() {
      return serial.ports;
    },
    addEventListener(type, fn) {
      if (type === "connect") listeners.push(fn);
    },
    fireConnect(port) {
      for (const fn of listeners) fn({ target: port });
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true, writable: true });
  return serial;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const serial = fakeSerial();
  const { SerialBridgeClient } = await import("../src/serial-client.js");
  const statuses = [];
  const frames = [];
  const client = new SerialBridgeClient({
    onFrame: (b) => frames.push(b),
    onStatus: (s) => statuses.push(s),
    reconnectDelayMs: 5,
    maxReconnectAttempts: 3,
  });
  const port = new FakePort();
  serial.nextPick = port;
  serial.ports = [port];
  await client.connect();
  return { serial, client, port, statuses, frames };
}

test("lee frames por USB", async () => {
  const { client, port, frames } = await setup();
  port.sendLine("Frame ALDL (160 baud): 00 02 27 0E");
  await tick(5);
  assert.deepEqual(frames, [[0x00, 0x02, 0x27, 0x0e]]);
  await client.disconnect();
});

test("si el puerto no vuelve, pasa a 'perdido' en vez de reintentar para siempre", async () => {
  const { client, port, statuses } = await setup();
  port.drop();
  await tick(80);
  assert.equal(statuses.at(-1), "perdido");
  assert.equal(client.lost, true);
  assert.equal(client.reconnecting, false); // el botón ya no ofrece "Cancelar reconexión"
  await client.disconnect();
  assert.equal(statuses.at(-1), "desconectado");
});

test("si el navegador devuelve el mismo aparato como otro objeto, se reabre solo", async () => {
  const { serial, client, port, statuses, frames } = await setup();
  port.drop();
  const again = new FakePort();
  serial.ports = [again]; // getPorts() lo entrega con el mismo vendor/producto
  await tick(30);
  assert.equal(client.connected, true);
  assert.equal(statuses.at(-1), "conectado");
  again.sendLine("Frame ALDL (160 baud): 04 02 27");
  await tick(5);
  assert.deepEqual(frames.at(-1), [0x04, 0x02, 0x27]);
  await client.disconnect();
});

test("un evento 'connect' del mismo aparato lo reabre aun estando 'perdido'", async () => {
  const { serial, client, port, statuses } = await setup();
  port.drop();
  await tick(80);
  assert.equal(statuses.at(-1), "perdido");
  const again = new FakePort();
  serial.fireConnect(again);
  await tick(5);
  assert.equal(client.connected, true);
  assert.equal(client.lost, false);
  await client.disconnect();
});

test("ignora el 'connect' de otro aparato USB", async () => {
  const { serial, client, port, statuses } = await setup();
  port.drop();
  await tick(80);
  serial.fireConnect(new FakePort({ usbVendorId: 0x10c4, usbProductId: 0xea60 }));
  await tick(5);
  assert.equal(client.connected, false);
  assert.equal(statuses.at(-1), "perdido");
});
