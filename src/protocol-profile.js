/**
 * protocol-profile.js
 *
 * "Perfil de protocolo": lo que el firmware necesita saber de la línea ALDL de un
 * vehículo (velocidad, largo del frame, PROM ID) y que en v1 estaba compilado en el
 * .ino para el Sonoma. En v2 viaja como dato en la definición (bloque opcional
 * <PROTOCOL> del ADX) y la web se lo manda al firmware al conectar.
 *
 * Sin dependencias del DOM, para poder probarlo con node (ver test/).
 */

export const MAX_FRAME_BYTES = 64; // tope del buffer del firmware (ALDL_MAX_FRAME_BYTES en el .ino)
const MAX_PROM_ID_BYTES = 4;
const BAUD_VALUES = ["auto", "160", "8192"];

/**
 * Lo que el firmware v1 trae compilado (el Sonoma). Un ADX sin <PROTOCOL> se
 * comporta como esto: es la compatibilidad hacia atrás con v1, y también lo que
 * un firmware v2 tiene antes de que la web le mande nada.
 */
export const V1_PROFILE = Object.freeze({
  baud: "auto", // v1 prueba 160 baud y, si no sincroniza, alterna a 8192
  frameBytes: 20,
  promIdIndex: 1,
  promId: Object.freeze([0x02, 0x27]),
});

/**
 * Valida y normaliza un perfil. Acepta los valores tal cual salen de los atributos
 * XML (strings, "" = ausente) o de un JSON del firmware (números, promId como array).
 * Lanza Error con un mensaje en español si algo no cuadra: un perfil mal escrito
 * no debe llegar al firmware a medias.
 *
 * Reglas (a propósito estrictas, para que las definiciones de la comunidad no
 * hereden en silencio los valores del Sonoma):
 *  - baud: "160", "8192" o "auto" (por defecto: auto = lo que hace v1).
 *  - framebytes: obligatorio, salvo a 8192 baud (ahí el firmware agrupa por silencios).
 *  - promid: opcional (sin él el firmware no filtra frames desalineados). Si está,
 *    exige promidindex y que quepa dentro del frame.
 */
export function normalizeProfile({ baud, frameBytes, promIdIndex, promId } = {}) {
  const baudStr = isBlank(baud) ? "auto" : String(baud).trim().toLowerCase();
  if (!BAUD_VALUES.includes(baudStr)) {
    throw new Error(`<PROTOCOL baud="${baud}"> no es válido: usa 160, 8192 o auto`);
  }

  let frames;
  if (isBlank(frameBytes)) {
    if (baudStr !== "8192") throw new Error("<PROTOCOL> necesita framebytes (el largo del frame ALDL)");
    frames = V1_PROFILE.frameBytes; // a 8192 baud el firmware no usa este valor
  } else {
    frames = Number(frameBytes);
    if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAME_BYTES) {
      throw new Error(`<PROTOCOL framebytes="${frameBytes}"> fuera de rango: debe ser un entero de 1 a ${MAX_FRAME_BYTES}`);
    }
  }

  const bytes = parseHexBytes(promId);
  let index = 0;
  if (bytes.length) {
    if (isBlank(promIdIndex)) throw new Error("<PROTOCOL> con promid necesita promidindex (en qué byte del frame empieza)");
    index = Number(promIdIndex);
    if (!Number.isInteger(index) || index < 0 || index + bytes.length > frames) {
      throw new Error(`<PROTOCOL promidindex="${promIdIndex}"> hace que el PROM ID se salga del frame de ${frames} bytes`);
    }
  }

  return { baud: baudStr, frameBytes: frames, promIdIndex: index, promId: bytes };
}

function isBlank(v) {
  return v == null || v === "";
}

/** "02 27", "0227" o "0x02 0x27" -> [2, 39]. También acepta un array de bytes (el eco del firmware). */
function parseHexBytes(value) {
  if (isBlank(value)) return [];
  if (Array.isArray(value)) {
    if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new Error("promid no válido: cada byte debe ser un entero de 0 a 255");
    }
    if (value.length > MAX_PROM_ID_BYTES) throw new Error(`promid demasiado largo (máximo ${MAX_PROM_ID_BYTES} bytes)`);
    return value.slice();
  }

  const hex = String(value).replace(/0x/gi, "").replace(/[\s:,-]/g, "");
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) {
    throw new Error(`<PROTOCOL promid="${value}"> no es válido: escribe bytes en hexadecimal, ej. "02 27"`);
  }
  const bytes = hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
  if (bytes.length > MAX_PROM_ID_BYTES) throw new Error(`promid demasiado largo (máximo ${MAX_PROM_ID_BYTES} bytes)`);
  return bytes;
}

export function profilesEqual(a, b) {
  return (
    a.baud === b.baud &&
    a.frameBytes === b.frameBytes &&
    a.promIdIndex === b.promIdIndex &&
    a.promId.length === b.promId.length &&
    a.promId.every((byte, i) => byte === b.promId[i])
  );
}

/**
 * ¿Un firmware v1 (que no acepta perfiles) puede correr esta definición? Solo si lo
 * que pide coincide con lo que ya trae compilado. A 160 baud fijo sí: v1 prueba 160
 * primero, así que sincroniza igual (solo que sigue alternando a 8192 si pierde la señal).
 */
export function v1FirmwareCanRun(profile) {
  return (
    (profile.baud === "auto" || profile.baud === "160") &&
    profilesEqual({ ...profile, baud: V1_PROFILE.baud }, V1_PROFILE)
  );
}

/** Mensaje que la web manda al firmware (por WebSocket, o una línea por Serial en modo USB). */
export function profileToCommand(profile) {
  return {
    cmd: "profile",
    baud: profile.baud,
    frameBytes: profile.frameBytes,
    promIdIndex: profile.promIdIndex,
    promId: profile.promId.slice(),
  };
}

export function describeProfile(profile) {
  const baud = profile.baud === "auto" ? "baud autodetectado" : `${profile.baud} baud`;
  const prom = profile.promId.length
    ? `PROM ID ${profile.promId.map((b) => b.toString(16).padStart(2, "0")).join(" ").toUpperCase()} en el byte ${profile.promIdIndex}`
    : "sin validar PROM ID";
  return `${baud}, ${profile.frameBytes} bytes, ${prom}`;
}
