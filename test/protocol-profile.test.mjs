// Pruebas de src/protocol-profile.js. Sin dependencias: `node --test` desde la raíz del repo (Node 22.7 o más nuevo,
// que detecta solo que src/*.js son ES modules).
import test from "node:test";
import assert from "node:assert/strict";
import {
  V1_PROFILE,
  MAX_FRAME_BYTES,
  normalizeProfile,
  profilesEqual,
  v1FirmwareCanRun,
  profileToCommand,
  describeProfile,
} from "../src/protocol-profile.js";

// Los atributos tal cual salen del bloque del A040 (defs/gmc_sonoma_1993_a040.adx).
const A040_ATTRS = { baud: "160", frameBytes: "20", promIdIndex: "1", promId: "02 27" };

test("el bloque del A040 se normaliza a los valores del Sonoma", () => {
  assert.deepEqual(normalizeProfile(A040_ATTRS), { baud: "160", frameBytes: 20, promIdIndex: 1, promId: [0x02, 0x27] });
});

test("compatibilidad con v1: el A040 pide lo mismo que el firmware v1 trae compilado", () => {
  const a040 = normalizeProfile(A040_ATTRS);
  assert.ok(profilesEqual({ ...a040, baud: V1_PROFILE.baud }, V1_PROFILE));
  assert.ok(v1FirmwareCanRun(a040));
  assert.ok(v1FirmwareCanRun(V1_PROFILE)); // ADX sin <PROTOCOL>
});

test("atributos ausentes (cadena vacía): baud por defecto auto, sin PROM ID", () => {
  assert.deepEqual(normalizeProfile({ baud: "", frameBytes: "25", promIdIndex: "", promId: "" }), {
    baud: "auto",
    frameBytes: 25,
    promIdIndex: 0,
    promId: [],
  });
});

test("el PROM ID acepta varias notaciones hexadecimales", () => {
  for (const promId of ["0227", "02 27", "0x02 0x27", "02:27", "02-27", "0X02,0X27"]) {
    assert.deepEqual(normalizeProfile({ frameBytes: 20, promIdIndex: 1, promId }).promId, [2, 39], promId);
  }
});

test("también acepta números y un array (el eco del firmware)", () => {
  assert.deepEqual(normalizeProfile({ baud: 160, frameBytes: 20, promIdIndex: 1, promId: [2, 39] }), {
    baud: "160",
    frameBytes: 20,
    promIdIndex: 1,
    promId: [2, 39],
  });
});

test("a 8192 baud framebytes no es obligatorio", () => {
  assert.equal(normalizeProfile({ baud: "8192" }).frameBytes, 20);
  assert.throws(() => normalizeProfile({ baud: "160" }), /framebytes/);
  assert.throws(() => normalizeProfile({}), /framebytes/); // auto tampoco: el firmware lo usa a 160
});

test("rechaza perfiles mal escritos con un mensaje que dice qué arreglar", () => {
  const ok = { frameBytes: 20, promIdIndex: 1, promId: "02 27" };
  assert.throws(() => normalizeProfile({ ...ok, baud: "9600" }), /baud/);
  for (const frameBytes of ["0", "-3", String(MAX_FRAME_BYTES + 1), "abc", "20.5"]) {
    assert.throws(() => normalizeProfile({ ...ok, frameBytes }), /framebytes/, frameBytes);
  }
  assert.throws(() => normalizeProfile({ frameBytes: 20, promId: "02 27" }), /promidindex/);
  assert.throws(() => normalizeProfile({ ...ok, promId: "022" }), /promid/); // dígitos impares
  assert.throws(() => normalizeProfile({ ...ok, promId: "zz" }), /promid/);
  assert.throws(() => normalizeProfile({ ...ok, promId: "01 02 03 04 05" }), /demasiado largo/);
  assert.throws(() => normalizeProfile({ ...ok, promId: [1, 300] }), /0 a 255/);
  assert.throws(() => normalizeProfile({ frameBytes: 3, promIdIndex: 2, promId: "02 27" }), /se salga del frame/);
  assert.throws(() => normalizeProfile({ ...ok, promIdIndex: "-1" }), /se salga del frame/);
});

test("un firmware v1 solo puede correr lo que ya trae compilado", () => {
  const a040 = normalizeProfile(A040_ATTRS);
  assert.equal(v1FirmwareCanRun({ ...a040, baud: "8192" }), false);
  assert.equal(v1FirmwareCanRun({ ...a040, frameBytes: 25 }), false);
  assert.equal(v1FirmwareCanRun({ ...a040, promId: [1, 2] }), false);
  assert.equal(v1FirmwareCanRun({ ...a040, promIdIndex: 3 }), false);
  // sin PROM ID pide "no filtrar", pero v1 sí filtra con 02 27: descartaría los frames de otro ECM
  assert.equal(v1FirmwareCanRun({ ...a040, promId: [], promIdIndex: 0 }), false);
});

test("el comando que va al firmware no comparte referencias con el perfil", () => {
  const profile = normalizeProfile(A040_ATTRS);
  const cmd = profileToCommand(profile);
  assert.deepEqual(cmd, { cmd: "profile", baud: "160", frameBytes: 20, promIdIndex: 1, promId: [2, 39] });
  cmd.promId.push(9);
  assert.deepEqual(profile.promId, [2, 39]);
});

test("describeProfile", () => {
  assert.equal(describeProfile(normalizeProfile(A040_ATTRS)), "160 baud, 20 bytes, PROM ID 02 27 en el byte 1");
  assert.equal(describeProfile(normalizeProfile({ frameBytes: 25 })), "baud autodetectado, 25 bytes, sin validar PROM ID");
});
