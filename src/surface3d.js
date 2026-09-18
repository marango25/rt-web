/**
 * surface3d.js
 *
 * Vista de superficie 3D de una tabla .xdf (RPM x MAP x valor, por ejemplo),
 * al estilo TunerPro RT. Usa Three.js (vendorizado en src/vendor/ - ver
 * index.html para el import map que resuelve el specifier "three") en vez
 * de reimplementar esto a mano en canvas 2D como el resto de las gráficas
 * del proyecto: una superficie 3D orbitable de verdad no es razonable sin
 * una librería real detrás.
 *
 * Se carga con import() dinámico desde main.js (no en el arranque normal
 * de la app) para no pagar ~700KB de descarga/parseo en cada sesión -
 * la mayoría de las sesiones reales de este proyecto son puro logging en
 * vivo del Sonoma y nunca tocan una tabla .xdf.
 */
import * as THREE from "./vendor/three.module.min.js";
import { OrbitControls } from "./vendor/OrbitControls.js";

const WORLD_WIDTH = 6; // eje X del mundo 3D <-> columnas de la tabla
const WORLD_DEPTH = 6; // eje Z del mundo 3D <-> filas de la tabla
const WORLD_HEIGHT = 3; // eje Y del mundo 3D <-> valor de la celda, normalizado a este rango visual

/** Índice fraccional (no solo el más cercano) de `value` dentro de breakpoints - para poder mover el marcador de posición actual de forma continua en vez de saltar celda a celda. */
function fractionalIndex(breakpoints, value) {
  const n = breakpoints.length;
  if (!n) return 0;
  if (value <= breakpoints[0]) return 0;
  if (value >= breakpoints[n - 1]) return n - 1;
  for (let i = 0; i < n - 1; i++) {
    const a = breakpoints[i];
    const b = breakpoints[i + 1];
    if (value >= a && value <= b) {
      return i + (b === a ? 0 : (value - a) / (b - a));
    }
  }
  return n - 1;
}

/** Interpola el valor de la tabla en una posición fraccional (fx, fy) entre las 4 celdas vecinas. */
function bilinearValue(values, rows, cols, fx, fy) {
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(fx)));
  const x1 = Math.min(cols - 1, x0 + 1);
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = values[y0 * cols + x0];
  const v10 = values[y0 * cols + x1];
  const v01 = values[y1 * cols + x0];
  const v11 = values[y1 * cols + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

function heightColor(t) {
  // Heatmap simple: azul (bajo) -> rojo (alto), como la mayoría de vistas 3D de calibración.
  const color = new THREE.Color();
  color.setHSL(((1 - t) * 240) / 360, 0.75, 0.5);
  return color;
}

function makeLabelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "28px -apple-system, sans-serif";
  ctx.fillStyle = "#e7e9ea";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2, 0.5, 1);
  return { sprite, texture, material };
}

/**
 * Crea la escena 3D de una tabla dentro de `canvas`. `bin` es el Uint8Array
 * de calibración cargado (o null - en ese caso la superficie sale plana,
 * mostrando solo la estructura de la tabla).
 *
 * Devuelve { updateLivePosition(xVal, yVal), resize(), dispose() }.
 */
export function createSurface3D(canvas, table, bin) {
  const rows = table.rows;
  const cols = table.cols;

  const values = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = table.valueAt(r, c, bin);
      values[r * cols + c] = v == null ? 0 : v;
    }
  }

  let min = Infinity;
  let max = -Infinity;
  values.forEach((v) => {
    if (v < min) min = v;
    if (v > max) max = v;
  });
  if (!bin || min === max) {
    min = 0;
    max = Math.max(1, max);
  }

  const worldX = (fx) => (cols > 1 ? (fx / (cols - 1)) * WORLD_WIDTH - WORLD_WIDTH / 2 : 0);
  const worldZ = (fy) => (rows > 1 ? (fy / (rows - 1)) * WORLD_DEPTH - WORLD_DEPTH / 2 : 0);
  const worldY = (v) => ((v - min) / (max - min)) * WORLD_HEIGHT;

  // ---------- Escena ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171a);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(6, 5.5, 8);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, worldY((min + max) / 2), 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(4, 8, 6);
  scene.add(dirLight);

  // ---------- Malla de la superficie ----------
  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const v = values[idx];
      const t = (v - min) / (max - min);
      positions[idx * 3 + 0] = worldX(c);
      positions[idx * 3 + 1] = worldY(v);
      positions[idx * 3 + 2] = worldZ(r);
      const color = heightColor(Number.isFinite(t) ? t : 0);
      colors[idx * 3 + 0] = color.r;
      colors[idx * 3 + 1] = color.g;
      colors[idx * 3 + 2] = color.b;
    }
  }

  const indices = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (indices.length) geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.65,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const wireGeometry = new THREE.WireframeGeometry(geometry);
  const wireMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 });
  const wireframe = new THREE.LineSegments(wireGeometry, wireMaterial);
  scene.add(wireframe);

  // ---------- Etiquetas de ejes ----------
  const labelObjs = [];
  const addLabel = (text, x, y, z) => {
    const { sprite, texture, material: labelMat } = makeLabelSprite(text);
    sprite.position.set(x, y, z);
    scene.add(sprite);
    labelObjs.push({ sprite, texture, material: labelMat });
  };
  if (table.xAxis.length) {
    addLabel(`${table.xLabel} ${table.xAxis[0]}`, worldX(0), -0.3, worldZ(rows - 1) + 0.9);
    addLabel(`${table.xLabel} ${table.xAxis[cols - 1]}`, worldX(cols - 1), -0.3, worldZ(rows - 1) + 0.9);
  }
  if (table.yAxis.length) {
    addLabel(`${table.yLabel} ${table.yAxis[0]}`, worldX(cols - 1) + 1.1, -0.3, worldZ(0));
    addLabel(`${table.yLabel} ${table.yAxis[rows - 1]}`, worldX(cols - 1) + 1.1, -0.3, worldZ(rows - 1));
  }

  // ---------- Marcador de posición actual (overlay en vivo, ver main.js) ----------
  const markerGeometry = new THREE.SphereGeometry(0.12, 20, 20);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x5fb3a3 });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.visible = false;
  scene.add(marker);

  function updateLivePosition(xVal, yVal) {
    if (xVal === undefined || yVal === undefined || Number.isNaN(xVal) || Number.isNaN(yVal)) {
      marker.visible = false;
      return;
    }
    const fx = fractionalIndex(table.xAxis, xVal);
    const fy = fractionalIndex(table.yAxis, yVal);
    const v = bilinearValue(values, rows, cols, fx, fy);
    marker.position.set(worldX(fx), worldY(v) + 0.1, worldZ(fy));
    marker.visible = true;
  }

  // ---------- Render loop + resize ----------
  function resize() {
    const w = canvas.parentElement.clientWidth || 300;
    const h = canvas.parentElement.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h || 1;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement);
  resize();

  let rafId = null;
  function tick() {
    controls.update();
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }
  tick();

  function dispose() {
    if (rafId != null) cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    controls.dispose();
    geometry.dispose();
    material.dispose();
    wireGeometry.dispose();
    wireMaterial.dispose();
    markerGeometry.dispose();
    markerMaterial.dispose();
    labelObjs.forEach(({ texture, material: labelMat }) => {
      texture.dispose();
      labelMat.dispose();
    });
    renderer.dispose();
  }

  return { updateLivePosition, resize, dispose };
}
