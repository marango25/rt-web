// Pruebas de src/firmware-link.js con un reloj falso: sin timers reales, sin red, sin firmware.
import test from "node:test";
import assert from "node:assert/strict";
import { FirmwareLink } from "../src/firmware-link.js";
import { normalizeProfile, V1_PROFILE } from "../src/protocol-profile.js";

const A040 = normalizeProfile({ baud: "160", frameBytes: "20", promIdIndex: "1", promId: "02 27" });
const OTHER_ECM = normalizeProfile({ baud: "160", frameBytes: "25", promIdIndex: "1", promId: "0A 0B" });
const HELLO_V2 = { hello: { fw: "2.0.0-alpha.1", caps: ["profile"] } };
const ECHO_A040 = { profile: { baud: "160", frameBytes: 20, promIdIndex: 1, promId: [2, 39] } };

function harness(initialProfile = A040) {
  const h = { profile: initialProfile, sent: [], phases: [], open: true, now: 0, timers: new Map(), nextId: 1 };
  h.setTimer = (fn, ms) => {
    const id = h.nextId++;
    h.timers.set(id, { fn, at: h.now + ms });
    return id;
  };
  h.clearTimer = (id) => h.timers.delete(id);
  h.advance = (ms) => {
    const target = h.now + ms;
    for (;;) {
      const due = [...h.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      h.timers.delete(due[0]);
      h.now = due[1].at;
      due[1].fn();
    }
    h.now = target;
  };
  h.link = new FirmwareLink({
    send: (msg) => (h.open ? (h.sent.push(msg), true) : false),
    getProfile: () => h.profile,
    onChange: (s) => h.phases.push(s.phase),
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  h.commands = () => h.sent.filter((m) => m.cmd === "profile");
  return h;
}

test("firmware v1: nadie contesta el hello y tras 3 s se asume v1, con el Sonoma sin advertencia", () => {
  const h = harness();
  h.link.begin();
  assert.equal(h.link.state.phase, "waiting");
  h.advance(2999);
  assert.equal(h.link.state.phase, "waiting");
  h.advance(1);
  assert.equal(h.link.state.phase, "v1");
  assert.equal(h.link.state.canRunOnV1, true);
  assert.deepEqual(h.sent, [{ cmd: "hello" }, { cmd: "hello" }, { cmd: "hello" }]); // t = 0, 1 s, 2 s
  assert.equal(h.commands().length, 0); // nunca se manda un perfil a ciegas a un firmware que no lo entiende
  assert.equal(h.timers.size, 0);
});

test("firmware v1 con una definición de otro ECM: avisa que no puede aplicarla", () => {
  const h = harness(OTHER_ECM);
  h.link.begin();
  h.advance(3000);
  assert.equal(h.link.state.phase, "v1");
  assert.equal(h.link.state.canRunOnV1, false);
});

test("sin bloque <PROTOCOL> (V1_PROFILE) un firmware v1 puede correrlo", () => {
  const h = harness(V1_PROFILE);
  h.link.begin();
  h.advance(3000);
  assert.equal(h.link.state.canRunOnV1, true);
});

test("firmware v2: hello -> perfil -> confirmación exacta = applied", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  assert.equal(h.link.state.phase, "sending");
  assert.equal(h.link.state.fw, "2.0.0-alpha.1");
  assert.deepEqual(h.commands(), [{ cmd: "profile", baud: "160", frameBytes: 20, promIdIndex: 1, promId: [2, 39] }]);

  h.link.handleControl(ECHO_A040);
  assert.equal(h.link.state.phase, "applied");
  assert.deepEqual(h.link.state.applied, A040);
  h.advance(60000);
  assert.equal(h.link.state.phase, "applied"); // ningún temporizador pendiente lo pisa
});

test("el firmware confirma un perfil distinto del pedido = mismatch", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.link.handleControl({ profile: { ...ECHO_A040.profile, frameBytes: 21 } });
  assert.equal(h.link.state.phase, "mismatch");
  assert.equal(h.link.state.applied.frameBytes, 21);
});

test("el firmware rechaza el perfil = rejected con su motivo", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.link.handleControl({ profileError: "frameBytes fuera de rango (1 a 64)" });
  assert.equal(h.link.state.phase, "rejected");
  assert.match(h.link.state.error, /frameBytes/);
});

test("una confirmación ilegible no se toma por buena", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.link.handleControl({ profile: { baud: "9600" } });
  assert.equal(h.link.state.phase, "rejected");
  assert.match(h.link.state.error, /ilegible/);
});

test("sin confirmación en 6 s = unconfirmed (no se da por aplicado)", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.advance(5999);
  assert.equal(h.link.state.phase, "sending");
  h.advance(1);
  assert.equal(h.link.state.phase, "unconfirmed");
});

test("un hello sin la capacidad 'profile' se trata como v1, pero con su versión", () => {
  const h = harness(OTHER_ECM);
  h.link.begin();
  h.link.handleControl({ hello: { fw: "2.1.0", caps: [] } });
  assert.equal(h.link.state.phase, "v1");
  assert.equal(h.link.state.fw, "2.1.0");
  assert.equal(h.link.state.canRunOnV1, false);
  assert.equal(h.commands().length, 0);
});

test("un hello tardío (la placa se reinició al abrir el USB) mejora el veredicto v1", () => {
  const h = harness();
  h.link.begin();
  h.advance(3000);
  assert.equal(h.link.state.phase, "v1");
  h.link.handleControl(HELLO_V2);
  assert.equal(h.link.state.phase, "sending");
  assert.equal(h.commands().length, 1);
});

test("un segundo hello a mitad de sesión (la placa se reinició) reenvía el perfil", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.link.handleControl(ECHO_A040);
  assert.equal(h.link.state.phase, "applied");
  h.link.handleControl(HELLO_V2);
  assert.equal(h.link.state.phase, "sending");
  assert.equal(h.commands().length, 2);
});

test("cargar otra definición con un firmware v2 conectado reenvía el perfil nuevo", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.link.handleControl(ECHO_A040);
  h.profile = OTHER_ECM;
  h.link.profileChanged();
  assert.equal(h.link.state.phase, "sending");
  assert.deepEqual(h.commands().at(-1), { cmd: "profile", baud: "160", frameBytes: 25, promIdIndex: 1, promId: [10, 11] });
});

test("cargar otra definición con un firmware v1 solo recalcula la advertencia; en 'waiting' no manda nada", () => {
  const h = harness();
  h.link.begin();
  h.profile = OTHER_ECM;
  h.link.profileChanged(); // todavía esperando el hello
  assert.equal(h.link.state.phase, "waiting");
  assert.equal(h.commands().length, 0);
  h.advance(3000);
  assert.equal(h.link.state.canRunOnV1, false); // el veredicto usa el perfil de ese momento

  h.profile = A040;
  h.link.profileChanged();
  assert.equal(h.link.state.canRunOnV1, true);
  assert.equal(h.commands().length, 0);
});

test("si el hello llega tras cambiar de definición, se manda el perfil vigente, no el viejo", () => {
  const h = harness();
  h.link.begin();
  h.profile = OTHER_ECM;
  h.link.profileChanged();
  h.link.handleControl(HELLO_V2);
  assert.equal(h.commands().at(-1).frameBytes, 25);
});

test("sin conexión abierta al enviar el perfil = rejected", () => {
  const h = harness();
  h.link.begin();
  h.open = false;
  h.link.handleControl(HELLO_V2);
  assert.equal(h.link.state.phase, "rejected");
  assert.match(h.link.state.error, /sin conexión/);
});

test("reset() limpia todo, cancela temporizadores e ignora mensajes que lleguen tarde", () => {
  const h = harness();
  h.link.begin();
  h.link.reset();
  assert.equal(h.link.state.phase, "idle");
  assert.equal(h.timers.size, 0);
  const sentBefore = h.sent.length;
  h.link.handleControl(HELLO_V2);
  assert.equal(h.link.state.phase, "idle");
  assert.equal(h.sent.length, sentBefore);
});

test("begin() otra vez (reconexión) empieza de cero", () => {
  const h = harness();
  h.link.begin();
  h.link.handleControl(HELLO_V2);
  h.link.handleControl(ECHO_A040);
  h.link.begin();
  assert.equal(h.link.state.phase, "waiting");
  assert.equal(h.link.state.fw, null);
  assert.equal(h.link.state.applied, null);
});
