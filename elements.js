import * as THREE from 'three';

const SC = window.SC;
if (!SC) throw new Error('main scene not exposed');
const { scene, camera, renderer, silk, silk2, silkMat, sun, rim, ambient } = SC;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ETSY = 'https://www.etsy.com/shop/SohoCozy';
const EMAIL = 'cozy@sohocozystore.com';
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const heroHits = [];
let pointerX = 0, pointerY = 0;

function frustum(z) {
  const d = camera.position.z - z;
  const hh = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * d;
  return { hw: hh * camera.aspect, hh };
}
const landscape = () => camera.aspect > 1 && innerWidth >= 820;
const smooth = (id) => document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
const isDomInteractive = (t) => t && t.closest && t.closest('a,button,input,textarea,form,.piece,canvas.spin,canvas.dock,canvas.station,canvas.loom,header');

function whisper(text, ms = 5000) {
  const w = document.getElementById('whisper');
  if (!w) return;
  w.querySelector('span').textContent = text;
  w.hidden = false;
  clearTimeout(w._t); w._t = setTimeout(() => { w.hidden = true; }, ms);
}
function copyEmail() {
  const done = () => whisper(`${EMAIL} — copied. Paste it wherever you write.`);
  const fallback = () => { const t = document.createElement('textarea'); t.value = EMAIL; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove(); done(); };
  if (navigator.clipboard) navigator.clipboard.writeText(EMAIL).then(done, fallback); else fallback();
}
document.querySelectorAll('a[data-copy-email]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); copyEmail(); }));

/* Autoplay is silently deferred by some browsers (background tab at load, iOS
   low-power mode). Left alone the hero freezes on a near-empty opening frame,
   so keep nudging it, and park on a composed frame if it truly cannot play. */
(function keepHeroPlaying() {
  const v = document.querySelector('.hero-video');
  if (!v || reduced) return;
  const kick = () => { if (v.paused) v.play().catch(() => {}); };
  kick();
  v.addEventListener('loadeddata', kick);
  v.addEventListener('canplay', kick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  ['pointerdown', 'touchstart', 'keydown', 'scroll'].forEach(ev =>
    addEventListener(ev, kick, { passive: true }));
  setTimeout(() => {
    if (v.paused && v.readyState >= 2 && v.currentTime < 0.5) {
      try { v.currentTime = Math.min(2.2, (v.duration || 3) * 0.25); } catch {}
    }
  }, 1200);
})();

/* ---------- palette + dusk state ---------- */
const PALETTES = {
  golden: { silk: 0xdcc7a8, silk2: 0x8d926f, clay: '#b47a5c', label: 'golden hour' },
  moss:   { silk: 0xa3a883, silk2: 0x5e6247, clay: '#7d8263', label: 'moss' },
  clay:   { silk: 0xd9a082, silk2: 0xa3583a, clay: '#a3583a', label: 'clay' },
  blush:  { silk: 0xe6c2b3, silk2: 0xc98d92, clay: '#c98d92', label: 'blush' },
};
let palette = PALETTES.golden;
let dusk = 0;
const root = document.documentElement.style;
const DAY = { cream: [246,239,230], ink: [61,49,40], soft: [122,106,90], bone: [236,227,211] };
const NIGHT = { cream: [43,36,34], ink: [241,230,214], soft: [201,184,164], bone: [58,49,45] };
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
const baseSilk = new THREE.Color(), baseSilk2 = new THREE.Color();
function applyLook() {
  baseSilk.set(palette.silk); baseSilk2.set(palette.silk2);
  silkMat.color.copy(baseSilk).multiplyScalar(1 - 0.55 * dusk);
  silk2.material.color.copy(baseSilk2).multiplyScalar(1 - 0.45 * dusk);
  root.setProperty('--clay', palette.clay);
  root.setProperty('--cream', mix(DAY.cream, NIGHT.cream, dusk));
  root.setProperty('--ink', mix(DAY.ink, NIGHT.ink, dusk));
  root.setProperty('--ink-soft', mix(DAY.soft, NIGHT.soft, dusk));
  root.setProperty('--bone', mix(DAY.bone, NIGHT.bone, dusk));
  root.setProperty('--veil', dusk < 0.5 ? `rgba(246,239,230,${0.55 * (1 - dusk)})` : `rgba(43,36,34,${0.6 * dusk})`);
  root.setProperty('--vid-b', String(1 - 0.35 * dusk));
  scene.fog.color.setRGB(...mix(DAY.cream, NIGHT.cream, dusk).match(/\d+/g).map(v => v / 255));
  sun.color.lerpColors(new THREE.Color(0xffd9a6), new THREE.Color(0x9a86c9), dusk);
  sun.intensity = 1.6 - 0.8 * dusk;
  ambient.intensity = 0.9 - 0.45 * dusk;
  rim.intensity = 0.55 + 0.4 * dusk;
  fireflyMat.opacity = 0.4 + 0.6 * dusk;
  if (stationLights) {
    stationLights.key.intensity = 1.15 - 0.35 * dusk;
    stationLights.amb.intensity = 0.85 - 0.25 * dusk;
  }
}

/* ============================================================
   THE STATION — fixed bottom-left console: yarn, swatches, knob
   Its own scene + renderer, so it never moves with the scroll.
   ============================================================ */
const stCanvas = document.querySelector('canvas.station');
const stLabel = document.querySelector('.station-label');
const stScene = new THREE.Scene();
const stCam = new THREE.OrthographicCamera(-3.9, 3.9, 1.3, -1.3, 0.1, 40);
stCam.position.set(0, 0, 10);
let stationLights = null;
let stRenderer = null;
const stHits = [];
let stHover = null;

if (stCanvas) {
  stRenderer = new THREE.WebGLRenderer({ canvas: stCanvas, alpha: true, antialias: true });
  stRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const amb = new THREE.AmbientLight(0xfff4e6, 0.85);
  const key = new THREE.DirectionalLight(0xfff0dc, 1.35);
  key.position.set(-2.2, 3.4, 4.5);
  const fill = new THREE.DirectionalLight(0xc9cf9f, 0.35);
  fill.position.set(3, -2, 4);
  const rimL = new THREE.DirectionalLight(0xffe6bd, 0.5);   // rakes across the flutes
  rimL.position.set(3.5, 0.6, 1.2);
  stScene.add(amb, key, fill, rimL);
  stationLights = { amb, key, fill };
}

/* ---------- 1. yarn-ball shop button ---------- */
const yarn = new THREE.Group();
const yarnCore = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 32), new THREE.MeshStandardMaterial({ color: 0xb47a5c, roughness: 0.95 }));
yarn.add(yarnCore);
for (let i = 0; i < 16; i++) {
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.415, 0.016, 8, 56), new THREE.MeshStandardMaterial({ color: 0xc98d68, roughness: 0.9 }));
  loop.rotation.set(i * 1.7 % Math.PI, i * 2.3 % Math.PI, i * 0.9 % Math.PI);
  yarn.add(loop);
}
const THREAD_N = 40;
const threadGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: THREAD_N }, () => new THREE.Vector3()));
const thread = new THREE.Line(threadGeo, new THREE.LineBasicMaterial({ color: 0xc98d68, transparent: true, opacity: 0.9 }));
yarn.add(thread);
yarn.userData.hover = 0;
const yarnHit = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
yarn.add(yarnHit);
yarnHit.userData = { label: 'Shop', onClick: () => smooth('collection') };
stHits.push(yarnHit);
stScene.add(yarn);

/* ---------- 2. fabric-swatch theme picker ---------- */
const swatches = new THREE.Group();
Object.entries(PALETTES).forEach(([key, p], i) => {
  const geo = new THREE.PlaneGeometry(0.46, 0.34, 12, 9);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: p.silk, roughness: 0.85, side: THREE.DoubleSide }));
  m.userData = { key, base: geo.attributes.position.array.slice(), hover: 0, label: p.label, onClick: () => { palette = PALETTES[key]; applyLook(); whisper(`Tinted ${p.label}.`, 2200); } };
  m.position.x = i * 0.56;
  swatches.add(m);
  stHits.push(m);
});
stScene.add(swatches);

/* ---------- 5. analog knob — golden hour to dusk ---------- */
const knob = new THREE.Group();
const knobSpin = new THREE.Group();          // everything that rotates with the value
knob.add(knobSpin);
const BRASS = new THREE.MeshStandardMaterial({ color: 0x9c7f43, roughness: 0.38, metalness: 0.72 });
const METAL = new THREE.MeshStandardMaterial({ color: 0x4a3a2e, roughness: 0.45, metalness: 0.55 });
const BODY = new THREE.MeshStandardMaterial({ color: 0xd9c4a5, roughness: 0.55, metalness: 0.25 });
const CAP = new THREE.MeshStandardMaterial({ color: 0xece3d3, roughness: 0.5, metalness: 0.15 });

const BRASS_DARK = new THREE.MeshStandardMaterial({ color: 0x6b5527, roughness: 0.55, metalness: 0.6 });
const PLATE = new THREE.MeshStandardMaterial({ color: 0xe9dfc9, roughness: 0.78, metalness: 0.04 });
const GROOVE = new THREE.MeshStandardMaterial({ color: 0x5c4a35, roughness: 0.7, metalness: 0.2 });
BRASS.color.setHex(0xa8873f); BRASS.roughness = 0.3; BRASS.metalness = 0.85;
BODY.color.setHex(0xdfd0b4); BODY.roughness = 0.34; BODY.metalness = 0.08;
CAP.color.setHex(0xf2ead9); CAP.roughness = 0.34; CAP.metalness = 0.08;

// --- dial plate: ticks are engraved into it rather than floating ---
const plate = new THREE.Mesh(new THREE.CircleGeometry(1.3, 64), PLATE);
plate.position.z = -0.17;
knob.add(plate);
const plateRim = new THREE.Mesh(new THREE.TorusGeometry(1.29, 0.022, 10, 64), BRASS_DARK);
plateRim.position.z = -0.16;
knob.add(plateRim);
for (let i = 0; i <= 20; i++) {                // 270-degree sweep, majors every 5th
  const a = -Math.PI * 0.75 + (i / 20) * Math.PI * 1.5;
  const major = i % 5 === 0;
  const len = major ? 0.19 : 0.095;
  const tick = new THREE.Mesh(new THREE.BoxGeometry(major ? 0.032 : 0.018, len, 0.018), major ? BRASS_DARK : GROOVE);
  const rad = 1.13 - len / 2;
  tick.position.set(Math.sin(a) * rad, Math.cos(a) * rad, -0.157);
  tick.rotation.z = -a;
  knob.add(tick);
}
const sunGlow = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.28, 64), new THREE.MeshBasicMaterial({ color: 0xffd9a6, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
sunGlow.position.z = -0.165;
knob.add(sunGlow);
// contact shadow so the body sits ON the plate instead of hovering
const contact = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.9, 64), new THREE.MeshBasicMaterial({ color: 0x8a7551, transparent: true, opacity: 0.24, side: THREE.DoubleSide }));
contact.position.z = -0.15;
knob.add(contact);

const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.855, 0.05, 14, 64), BRASS);
knob.add(bezel);

// --- fluted body: scallops cut into the cylinder itself, not stuck on ---
const FLUTES = 20;
const bodyGeo = new THREE.CylinderGeometry(0.60, 0.645, 0.4, FLUTES * 8, 1, false);
{
  const p = bodyGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const a = Math.atan2(z, x);
    const scallop = Math.pow(Math.cos(a * FLUTES) * 0.5 + 0.5, 1.5);
    const nr = r + 0.082 * scallop - 0.041;
    p.setX(i, Math.cos(a) * nr);
    p.setZ(i, Math.sin(a) * nr);
  }
  bodyGeo.computeVertexNormals();
}
const body = new THREE.Mesh(bodyGeo, BODY);
body.rotation.x = Math.PI / 2;
knobSpin.add(body);

// --- bevel collar + domed crown, so light catches the top ---
const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.545, 0.60, 0.07, 64), BODY);
collar.rotation.x = Math.PI / 2;
collar.position.z = 0.17;
knobSpin.add(collar);
const DOME_R = 2.46, DOME_TH = Math.asin(0.545 / 2.46);
const domeGeo = new THREE.SphereGeometry(DOME_R, 64, 12, 0, Math.PI * 2, 0, DOME_TH);
domeGeo.translate(0, -DOME_R * Math.cos(DOME_TH), 0);   // base of the cap at y = 0
const dome = new THREE.Mesh(domeGeo, CAP);
dome.rotation.x = Math.PI / 2;
dome.position.z = 0.2;
knobSpin.add(dome);

// --- recessed indicator: a cut groove with a brass inlay ---
const groove = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.46, 0.05), GROOVE);
groove.position.set(0, 0.235, 0.256);
knobSpin.add(groove);
const inlay = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.42, 0.034), BRASS);
inlay.position.set(0, 0.235, 0.276);
knobSpin.add(inlay);

knob.rotation.x = -0.30;   // tip it off-axis so the fluted body and its shadow read
const knobHit = new THREE.Mesh(new THREE.CircleGeometry(0.95, 16), new THREE.MeshBasicMaterial({ visible: false }));
knobHit.position.z = 0.4;
knobHit.userData = { drag: true, label: 'Dusk' };
knob.add(knobHit);
stHits.push(knobHit);
stScene.add(knob);

const KNOB_MIN = -Math.PI * 0.75, KNOB_MAX = Math.PI * 0.75;
let knobAngle = KNOB_MIN;
let dragging = false, dragX = 0, dragY = 0;
function setKnob(angle) {
  knobAngle = THREE.MathUtils.clamp(angle, KNOB_MIN, KNOB_MAX);
  knobSpin.rotation.z = -knobAngle;
  dusk = (knobAngle - KNOB_MIN) / (KNOB_MAX - KNOB_MIN);
  applyLook();
}

/* Drop-in slot for the BlenderKit knob: if assets/knob.glb exists it replaces
   the procedural body, keeping the same rotation rig, hit area and behaviour. */
async function tryLoadKnobModel() {
  // opt-in: set data-knob="assets/knob.glb" on the station canvas to use a model
  const url = stCanvas?.dataset.knob;
  if (!url) return;
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    // A knob's rotation axis is its SHORTEST dimension; glTF's Y-up export
    // usually leaves that pointing at the ceiling. Turn it to face the camera.
    let box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const axis = size.x <= size.y && size.x <= size.z ? 'x' : (size.y <= size.z ? 'y' : 'z');
    if (axis === 'y') model.rotation.x = -Math.PI / 2;
    else if (axis === 'x') model.rotation.y = Math.PI / 2;
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const size2 = new THREE.Vector3(); box.getSize(size2);
    const center = new THREE.Vector3(); box.getCenter(center);
    const target = 1.36;                                  // match the procedural knob's diameter
    const s = target / Math.max(size2.x, size2.y, 1e-6);
    // tint the imported knob into the SOHOCOZY palette
    model.traverse((o) => {
      if (o.isMesh) {
        o.material = new THREE.MeshStandardMaterial({ color: 0xe4d8c2, roughness: 0.52, metalness: 0.18 });
      }
    });
    const holder = new THREE.Group();
    holder.add(model);
    model.position.sub(center);
    holder.scale.setScalar(s);
    knobSpin.clear();
    knobSpin.add(holder);
    whisper('Knob model loaded.', 2500);
  } catch (e) { /* keep the procedural knob */ }
}
tryLoadKnobModel();

/* Solo inspection view: ?solo=knob isolates the knob, large and centred. */
const SOLO = new URLSearchParams(location.search).get('solo');
if (SOLO === 'knob') {
  yarn.visible = false; swatches.visible = false;
  root.setProperty('--st-w', 'min(94vw, 94svh)');
  const wrap = document.querySelector('.station-wrap');
  if (wrap) { wrap.style.left = '50%'; wrap.style.bottom = '50%'; wrap.style.transform = 'translate(-50%, 50%)'; }
}

/* Measure each control's true horizontal span once, at scale 1, so layout uses
   real geometry (rings, threads and all) instead of hand-guessed radii. */
let baseSpan = null;
function measureBaseSpans() {
  const span = (o) => {
    const ps = o.scale.clone(), pp = o.position.clone();
    o.scale.setScalar(1); o.position.set(0, 0, 0); o.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    const tmp = new THREE.Box3();
    o.traverse((c) => {                       // visible geometry only — hit
      if (!c.isMesh && !c.isLine) return;     // volumes must not inflate layout
      if (c.material && c.material.visible === false) return;
      c.geometry.computeBoundingBox();
      tmp.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld);
      bb.union(tmp);
    });
    o.scale.copy(ps); o.position.copy(pp); o.updateMatrixWorld(true);
    return { min: bb.min.x, max: bb.max.x, w: bb.max.x - bb.min.x };
  };
  baseSpan = { knob: span(knob), yarn: span(yarn), sw: span(swatches) };
}

/* ---------- station layout + interaction ---------- */
function stationLayout() {
  if (!stCanvas || !stRenderer) return;
  const w = stCanvas.clientWidth, h = stCanvas.clientHeight;
  if (!w || !h) return;
  stRenderer.setSize(w, h, false);
  const halfH = 1.3, halfW = halfH * (w / h);
  stCam.left = -halfW; stCam.right = halfW; stCam.top = halfH; stCam.bottom = -halfH;
  stCam.updateProjectionMatrix();
  if (SOLO === 'knob') { knob.position.set(0, 0, 0); knob.scale.setScalar(1); return; }
  // relative sizes, tuned so the three controls read as one even family
  const KNOB_S = 0.80, YARN_S = 1.62, SW_S = 1.24;
  const margin = 0.2, minGap = 0.3;
  if (!baseSpan) measureBaseSpans();

  // shrink the whole cluster if it cannot fit, rather than letting it overflow
  const rawContent = baseSpan.knob.w * KNOB_S + baseSpan.yarn.w * YARN_S + baseSpan.sw.w * SW_S;
  const avail = 2 * halfW - 2 * margin;
  const fit = Math.min(1, (avail - 2 * minGap) / rawContent);

  const kS = KNOB_S * fit, yS = YARN_S * fit, sS = SW_S * fit;
  knob.userData.baseScale = kS;               // the tick multiplies hover onto this
  knob.scale.setScalar(kS);
  yarn.scale.setScalar(yS);
  swatches.scale.setScalar(sS);

  const wY = baseSpan.yarn.w * yS, wS = baseSpan.sw.w * sS, wK = baseSpan.knob.w * kS;
  const gap = Math.max(minGap, (avail - (wY + wS + wK)) / 2);
  let x = -halfW + margin;
  yarn.position.x = x - baseSpan.yarn.min * yS;          // left edge lands on x
  x += wY + gap;
  swatches.position.x = x - baseSpan.sw.min * sS;
  x += wS + gap;
  knob.position.x = x - baseSpan.knob.min * kS;
  yarn.position.y = swatches.position.y = knob.position.y = 0;
  yarn.position.z = swatches.position.z = knob.position.z = 0;
}

function stationPick(e) {
  if (!stCanvas) return null;
  const b = stCanvas.getBoundingClientRect();
  ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  ray.setFromCamera(ndc, stCam);
  const hit = ray.intersectObjects(stHits, false)[0];
  return hit ? hit.object : null;
}
if (stCanvas) {
  stCanvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragX, dy = e.clientY - dragY;
      dragX = e.clientX; dragY = e.clientY;
      setKnob(knobAngle + (dx - dy) * 0.012);
      return;
    }
    const h = stationPick(e);
    if (h !== stHover) {
      stHover = h;
      stCanvas.style.cursor = h ? (h.userData.drag ? 'grab' : 'pointer') : 'default';
      if (stLabel) stLabel.textContent = h ? h.userData.label : '';
    }
  });
  stCanvas.addEventListener('pointerleave', () => { if (!dragging) { stHover = null; if (stLabel) stLabel.textContent = ''; } });
  stCanvas.addEventListener('pointerdown', (e) => {
    const h = stationPick(e);
    if (h && h.userData.drag) {
      dragging = true; dragX = e.clientX; dragY = e.clientY;
      stCanvas.setPointerCapture(e.pointerId);
      stCanvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });
  const endDrag = () => { if (dragging) { dragging = false; stCanvas.style.cursor = 'grab'; } };
  stCanvas.addEventListener('pointerup', endDrag);
  stCanvas.addEventListener('pointercancel', endDrag);
  addEventListener('blur', endDrag);
  stCanvas.addEventListener('click', (e) => {
    const h = stationPick(e);
    if (h && h.userData.onClick) h.userData.onClick();
  });
  stCanvas.addEventListener('wheel', (e) => {
    const h = stationPick(e);
    if (h && h.userData.drag) { e.preventDefault(); setKnob(knobAngle + Math.sign(e.deltaY) * 0.14); }
  }, { passive: false });
}

/* ---------- 4. swinging hang-tag (stays in the hero) ---------- */
const tag = new THREE.Group();
const tagLen = { v: 1.6 };
const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), new THREE.LineBasicMaterial({ color: 0x7a6a5a }));
tag.add(string);
const tagBody = new THREE.Group();
const card = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.9, 0.03), new THREE.MeshStandardMaterial({ color: 0xd9c4a5, roughness: 0.9 }));
tagBody.add(card);
const eyelet = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.014, 8, 24), new THREE.MeshStandardMaterial({ color: 0x8a7a68, metalness: 0.4, roughness: 0.5 }));
eyelet.position.set(0, 0.36, 0.02);
tagBody.add(eyelet);
const tagCanvas = document.createElement('canvas'); tagCanvas.width = 256; tagCanvas.height = 372;
{
  const c = tagCanvas.getContext('2d');
  c.fillStyle = 'rgba(0,0,0,0)'; c.fillRect(0, 0, 256, 372);
  c.fillStyle = '#3d3128'; c.textAlign = 'center';
  c.font = '500 26px Poppins, sans-serif'; c.letterSpacing = '6px';
  c.fillText('THE', 128, 150); c.fillText('SOFT', 128, 190); c.fillText('LIST', 128, 230);
  c.font = 'italic 22px Fraunces, serif'; c.letterSpacing = '0px';
  c.fillText('join us', 128, 300);
}
const tagLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.87), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(tagCanvas), transparent: true }));
tagLabel.position.z = 0.017;
tagBody.add(tagLabel);
tag.add(tagBody);
const tagHit = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
tagBody.add(tagHit);
tagHit.userData = { label: 'Join the soft list', onClick: () => smooth('waitlist') };
heroHits.push(tagHit);
const pend = { a: 0.35, v: 0 };
scene.add(tag);

/* ---------- 6. catchable fireflies (hero) ---------- */
const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 64;
{
  const c = glowCanvas.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,236,190,1)'); g.addColorStop(0.35, 'rgba(255,214,140,0.7)'); g.addColorStop(1, 'rgba(255,200,120,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
}
const fireflyMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowCanvas), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
const fireflies = [];
let caught = 0;
for (let i = 0; i < 7; i++) {
  const s = new THREE.Sprite(fireflyMat.clone());
  s.scale.setScalar(0.26);
  s.userData = { seed: (i * 13.37) % 100, alive: 1, respawn: 0, label: 'Catch the light', onClick: () => catchFly(s) };
  fireflies.push(s); heroHits.push(s); scene.add(s);
}
function catchFly(s) {
  if (s.userData.alive < 1) return;
  s.userData.alive = 0.999; caught++;
  const lines = [
    'You caught the light. The soft list hears one day early for you.',
    "Two fireflies. Somebody's going to have first pick.",
    'A jar full. The first drop is basically yours.',
  ];
  whisper(lines[Math.min(caught, 3) - 1], 6000);
}

/* ---------- hero layout + pointer ---------- */
let flyScale = 1;
function layout() {
  const z = 1.0;
  const { hw, hh } = frustum(z);
  const wide = landscape();
  const pxPerUnit = innerHeight / (2 * hh);
  flyScale = Math.min(1, (0.07 * innerWidth) / (0.28 * pxPerUnit));
  tag.position.set(hw * (wide ? 0.42 : 0.72), hh + 0.05, z);
  tagLen.v = wide ? 1.6 : Math.min(0.9, 110 / pxPerUnit);
  tag.scale.setScalar(wide ? 1 : Math.min(1, hw / 1.9));
  stationLayout();
}
layout();
addEventListener('resize', layout);

let heroHover = null;
function heroPick(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(heroHits, false)[0];
  return hit ? hit.object : null;
}
addEventListener('pointermove', (e) => {
  pointerX = e.clientX; pointerY = e.clientY;
  if (isDomInteractive(e.target)) { if (heroHover) { heroHover = null; document.body.style.cursor = ''; } return; }
  const h = heroPick(e.clientX, e.clientY);
  if (h !== heroHover) {
    heroHover = h;
    document.body.style.cursor = h ? 'pointer' : '';
    document.body.title = h ? h.userData.label : '';
  }
});
addEventListener('click', (e) => {
  if (isDomInteractive(e.target)) return;
  const h = heroPick(e.clientX, e.clientY);
  if (h && h.userData.onClick) h.userData.onClick();
});

/* ---------- per-frame ---------- */
let last = 0;
SC.ticks.push((t) => {
  const dt = Math.min(0.05, t - last); last = t;
  const { hw, hh } = frustum(1.0);

  /* station */
  yarn.rotation.y += 0.004; yarn.rotation.x = Math.sin(t * 0.5) * 0.15;
  const yh = stHover === yarnHit ? 1 : 0;
  yarn.userData.hover += (yh - yarn.userData.hover) * 0.08;
  const yhv = yarn.userData.hover;
  const tp = threadGeo.attributes.position.array;
  for (let i = 0; i < THREAD_N; i++) {
    const k = i / (THREAD_N - 1);
    tp[i * 3] = 0.3 + k * 0.9 * yhv;
    tp[i * 3 + 1] = -0.3 - k * 0.35 * yhv + Math.sin(k * 9 + t * 2) * 0.05 * yhv;
    tp[i * 3 + 2] = 0.1;
  }
  threadGeo.attributes.position.needsUpdate = true;

  swatches.children.forEach((m, i) => {
    const p = m.geometry.attributes.position.array, b = m.userData.base;
    for (let j = 0; j < p.length; j += 3) p[j + 2] = Math.sin(b[j] * 6 + t * 1.6 + i) * 0.03 + Math.sin(b[j + 1] * 8 + t) * 0.02;
    m.geometry.attributes.position.needsUpdate = true; m.geometry.computeVertexNormals();
    const target = stHover === m ? 1 : 0;
    m.userData.hover += (target - m.userData.hover) * 0.12;
    m.position.z = 0.22 * m.userData.hover;
    m.position.y = 0.06 * m.userData.hover;
    m.rotation.z = Math.sin(t * 0.8 + i) * 0.05;
    const active = PALETTES[m.userData.key] === palette;
    m.scale.setScalar(active ? 1.12 : 1);
  });

  sunGlow.material.opacity = 0.42 * (1 - dusk) + 0.08;
  sunGlow.material.color.setHex(dusk > 0.5 ? 0x9a86c9 : 0xffd9a6);
  knob.scale.setScalar((knob.userData.baseScale || 1) * (stHover === knobHit || dragging ? 1.05 : 1));
  if (stRenderer) stRenderer.render(stScene, stCam);

  /* hero: hang-tag */
  const px = (pointerX / innerWidth - 0.5) * hw * 2;
  const push = Math.exp(-Math.abs(px - tag.position.x) * 0.9) * (px < tag.position.x ? -1 : 1) * 0.6;
  const gravity = -4.5 * Math.sin(pend.a);
  pend.v += (gravity - pend.v * 0.9 + push + Math.sin(t * 0.7) * 0.25) * dt;
  pend.a += pend.v * dt;
  tag.rotation.z = pend.a;
  const L = tagLen.v;
  string.geometry.attributes.position.array[4] = -L; string.geometry.attributes.position.needsUpdate = true;
  tagBody.position.y = -L - 0.42;
  tagBody.scale.setScalar(heroHover === tagHit ? 1.08 : 1);

  /* hero: fireflies */
  fireflies.forEach((s) => {
    const u = s.userData;
    if (u.alive < 1) {
      u.alive -= dt * 1.6;
      if (u.alive <= 0) { u.alive = -1; u.respawn = t + 5; }
      const g = Math.max(0, u.alive);
      s.material.opacity = fireflyMat.opacity * g; s.scale.setScalar(0.26 * flyScale * (1 + (1 - g) * 2.5));
      if (u.alive === -1 && t > u.respawn) { u.alive = 1; s.material.opacity = fireflyMat.opacity; }
      return;
    }
    s.scale.setScalar((0.22 + 0.1 * ((u.seed * 7) % 1)) * flyScale);
    s.material.opacity = fireflyMat.opacity * (0.6 + 0.4 * Math.sin(t * 3 + u.seed));
    const k = t * 0.25 + u.seed;
    const ox = Math.sin(k * 0.9) * 0.6 + Math.sin(k * 0.37) * 0.4;
    const oy = Math.cos(k * 0.7) * 0.4 + Math.sin(k * 0.23) * 0.3;
    const baseX = ((u.seed * 0.137) % 1.6 - 0.8) * hw;
    const baseY = hh * (0.05 + ((u.seed * 0.311) % 0.6));
    s.position.set(baseX + ox, baseY + oy, 0.8 + Math.sin(k) * 0.3);
  });
});

/* ---------- 7. self-weaving loom scroll bar ---------- */
(function loom() {
  const cv = document.querySelector('canvas.loom');
  if (!cv) return;
  const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  const sc = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const N = 240;
  const mk = (color, op) => new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: N }, () => new THREE.Vector3())), new THREE.LineBasicMaterial({ color, transparent: true, opacity: op }));
  const warp = mk(0xb47a5c, 1), weft = mk(0x7d8263, 1), ghost = mk(0x7a6a5a, 0.25);
  sc.add(ghost, warp, weft);
  const shuttle = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), new THREE.MeshBasicMaterial({ color: 0xc4562a }));
  sc.add(shuttle);
  function size() { r.setSize(cv.clientWidth, cv.clientHeight, false); cam.left = 0; cam.right = 1; cam.top = 1; cam.bottom = 0; cam.updateProjectionMatrix(); }
  size(); addEventListener('resize', size);
  cv.title = 'The loom — click anywhere on the thread to jump';
  cv.addEventListener('click', (e) => {
    const k = e.clientX / cv.clientWidth;
    scrollTo({ top: k * (document.documentElement.scrollHeight - innerHeight), behavior: reduced ? 'auto' : 'smooth' });
  });
  SC.ticks.push((t) => {
    const p = document.documentElement.scrollHeight > innerHeight ? scrollY / (document.documentElement.scrollHeight - innerHeight) : 0;
    const wa = warp.geometry.attributes.position.array, we = weft.geometry.attributes.position.array, gh = ghost.geometry.attributes.position.array;
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      const woven = x <= p;
      const amp = woven ? 0.36 : 0.0;
      const ph = x * 70 + t * 1.2;
      wa[i * 3] = x; wa[i * 3 + 1] = 0.5 + Math.sin(ph) * amp; wa[i * 3 + 2] = 0;
      we[i * 3] = x; we[i * 3 + 1] = 0.5 - Math.sin(ph) * amp; we[i * 3 + 2] = 0;
      gh[i * 3] = x; gh[i * 3 + 1] = 0.5; gh[i * 3 + 2] = 0;
      if (!woven) { wa[i * 3 + 1] = we[i * 3 + 1] = 0.5; }
    }
    warp.geometry.attributes.position.needsUpdate = weft.geometry.attributes.position.needsUpdate = ghost.geometry.attributes.position.needsUpdate = true;
    shuttle.position.set(p, 0.5, 0.1);
    const ar = cv.clientWidth / Math.max(1, cv.clientHeight);
    shuttle.scale.set(1 / ar, 1, 1);
    r.render(sc, cam);
  });
})();

/* ---------- 8. breathing knit CTA ---------- */
(function knit() {
  const cv = document.querySelector('canvas.knit-canvas');
  if (!cv) return;
  const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  const sc = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-2.02, 2.02, 0.52, -0.52, 0.1, 10);
  cam.position.z = 5;
  sc.add(new THREE.AmbientLight(0xffffff, 0.95));
  const key = new THREE.DirectionalLight(0xfff0dc, 0.8); key.position.set(0, 2.5, 6); sc.add(key);
  const geo = new THREE.CapsuleGeometry(0.5, 3.0, 8, 32);
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ridge = Math.sin(y * 26) * 0.5 + Math.sin(Math.atan2(z, x) * 14 + y * 6) * 0.5;
    const d = ridge * 0.022;
    pos.setXYZ(i, x + nor.getX(i) * d, y + nor.getY(i) * d, z + nor.getZ(i) * d);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3d3128, roughness: 0.95 });
  const pill = new THREE.Mesh(geo, mat);
  pill.rotation.z = Math.PI / 2;
  sc.add(pill);
  const a = cv.closest('a');
  let press = 0, target = 0;
  a.addEventListener('pointerdown', () => { target = 1; });
  addEventListener('pointerup', () => { target = 0; });
  a.addEventListener('pointerleave', () => { target = 0; });
  function size() { r.setSize(cv.clientWidth, cv.clientHeight, false); }
  size(); addEventListener('resize', size);
  SC.ticks.push((t) => {
    press += (target - press) * 0.25;
    const breathe = 0.975 + Math.sin(t * 1.4) * 0.022;
    pill.scale.set(breathe * (1 - press * 0.06), breathe * (1 - press * 0.14), 1);
    mat.color.set(getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#3d3128');
    r.render(sc, cam);
  });
})();

/* ---------- 9. pressed-flower nav dock ---------- */
(function dock() {
  const cv = document.querySelector('canvas.dock');
  const label = document.querySelector('.dock-label');
  if (!cv) return;
  const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  const sc = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(28, 210 / 80, 0.1, 20);
  cam.position.set(0, 0.9, 5.2); cam.lookAt(0, 0, 0);
  sc.add(new THREE.AmbientLight(0xffffff, 0.8));
  const key = new THREE.DirectionalLight(0xfff0dc, 1.1); key.position.set(2, 4, 3); sc.add(key);
  const defs = [
    { name: 'Shop', color: 0xb47a5c, go: () => { location.href = ETSY; } },
    { name: 'Waitlist', color: 0x7d8263, go: () => smooth('waitlist') },
    { name: 'Email', color: 0xd9a98f, go: () => copyEmail() },
  ];
  const flowers = defs.map((d, i) => {
    const g = new THREE.Group();
    g.position.x = (i - 1) * 1.25;
    const petals = [];
    for (let k = 0; k < 6; k++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.85 }));
      p.scale.set(1, 0.32, 1.9);
      const pivot = new THREE.Group();
      pivot.rotation.y = (k / 6) * Math.PI * 2;
      p.position.z = 0.3;
      pivot.add(p); g.add(pivot); petals.push(pivot);
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshStandardMaterial({ color: 0xe0b76b, roughness: 0.6 }));
    g.add(center);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.62, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
    g.userData = { def: d, petals, hover: 0, hit };
    hit.userData.flower = g;
    sc.add(g);
    return g;
  });
  const hits = flowers.map(f => f.userData.hit);
  const rc = new THREE.Raycaster(), v = new THREE.Vector2();
  let hov = null;
  function pick(e) {
    const b = cv.getBoundingClientRect();
    v.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    rc.setFromCamera(v, cam);
    const h = rc.intersectObjects(hits, false)[0];
    return h ? h.object.userData.flower : null;
  }
  cv.addEventListener('pointermove', (e) => { hov = pick(e); cv.style.cursor = hov ? 'pointer' : 'default'; label.textContent = hov ? hov.userData.def.name : ''; });
  cv.addEventListener('pointerleave', () => { hov = null; label.textContent = ''; });
  cv.addEventListener('click', (e) => { const f = pick(e); if (f) f.userData.def.go(); });
  function size() { r.setSize(cv.clientWidth, cv.clientHeight, false); cam.aspect = cv.clientWidth / cv.clientHeight; cam.updateProjectionMatrix(); }
  size(); addEventListener('resize', size);
  SC.ticks.push((t) => {
    flowers.forEach((f, i) => {
      const target = hov === f ? 1 : 0;
      f.userData.hover += (target - f.userData.hover) * 0.12;
      const open = 1.15 - 0.75 * f.userData.hover;
      f.userData.petals.forEach(pv => { pv.children[0].rotation.x = -open; });
      f.rotation.y = t * 0.25 + i;
      f.position.y = Math.sin(t * 1.2 + i) * 0.05 + f.userData.hover * 0.15;
    });
    r.render(sc, cam);
  });
})();

/* ---------- 3. spinning 3D garments ---------- */
(function garments() {
  const tee = [[55,30],[78,20],[95,26],[112,20],[135,30],[158,52],[140,68],[134,58],[134,108],[56,108],[56,58],[50,68],[32,52]];
  const crew = [[52,34],[76,24],[95,30],[114,24],[138,34],[162,60],[142,74],[138,62],[138,118],[52,118],[52,62],[48,74],[28,60]];
  const toShape = (pts) => { const s = new THREE.Shape(); pts.forEach(([x, y], i) => { const X = (x - 95) * 0.02, Y = (70 - y) * 0.02; i ? s.lineTo(X, Y) : s.moveTo(X, Y); }); s.closePath(); return s; };
  const loader = new THREE.TextureLoader();
  const logoTex = loader.load('assets/logo-chest.png');
  logoTex.colorSpace = THREE.SRGBColorSpace;
  function motifTexture(kind) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'); x.strokeStyle = kind === 'ghost' ? '#f3e6d5' : '#565b41'; x.lineWidth = 6; x.lineCap = 'round'; x.fillStyle = x.strokeStyle;
    if (kind === 'ghost') {
      x.beginPath(); x.ellipse(128, 130, 52, 66, 0, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.moveTo(128, 64); x.lineTo(128, 34); x.moveTo(104, 72); x.lineTo(86, 46); x.moveTo(152, 72); x.lineTo(170, 46); x.stroke();
      x.beginPath(); x.arc(110, 132, 6, 0, 7); x.arc(146, 132, 6, 0, 7); x.fill();
      x.beginPath(); x.moveTo(108, 160); x.quadraticCurveTo(128, 176, 148, 160); x.stroke();
    } else {
      x.beginPath(); x.moveTo(128, 40); x.lineTo(128, 220); x.stroke();
      [[70, 0.0], [110, 0.35], [150, 0.7], [190, 1]].forEach(([y, k]) => {
        x.beginPath(); x.moveTo(128, y); x.quadraticCurveTo(128 - 30 - 10 * k, y - 8, 128 - 50 - 20 * k, y - 36); x.stroke();
        x.beginPath(); x.moveTo(128, y); x.quadraticCurveTo(128 + 30 + 10 * k, y - 8, 128 + 50 + 20 * k, y - 36); x.stroke();
      });
      x.beginPath(); x.arc(128, 36, 14, 0, 7); x.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  document.querySelectorAll('canvas.spin').forEach((cv) => {
    const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    const sc = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    cam.position.set(0, 0.1, 5.6);
    sc.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xfff0dc, 1.0); key.position.set(2, 3, 4); sc.add(key);
    const fill = new THREE.DirectionalLight(0xc9cf9f, 0.4); fill.position.set(-3, -1, 2); sc.add(fill);
    const shape = toShape(cv.dataset.garment === 'crew' ? crew : tee);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 });
    geo.center();
    const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(cv.dataset.color), roughness: 0.9 }));
    const g = new THREE.Group(); g.add(body);
    const decal = cv.dataset.decal;
    if (decal) {
      const tex = decal === 'logo' ? logoTex : motifTexture(decal);
      if (cv.dataset.patch) {
        const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.66), new THREE.MeshStandardMaterial({ color: 0xece3d3, roughness: 0.9 }));
        patch.position.set(0, decal === 'logo' ? -0.08 : 0, 0.145); g.add(patch);
      }
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      d.position.set(0, cv.dataset.garment === 'crew' ? -0.02 : -0.08, 0.15); g.add(d);
    }
    sc.add(g);
    let vel = 0, down = false, lastX = 0, moved = 0, idle = 0, rot = 0;
    cv.addEventListener('pointerdown', (e) => { down = true; lastX = e.clientX; moved = 0; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
    cv.addEventListener('pointermove', (e) => { if (!down) return; const dx = e.clientX - lastX; lastX = e.clientX; moved += Math.abs(dx); vel = dx * 0.012; rot += vel; idle = 0; });
    cv.addEventListener('pointerup', () => { down = false; cv.style.cursor = 'grab'; if (moved < 5) location.href = ETSY; });
    cv.title = 'Drag to spin · click to shop';
    function size() { const w = cv.clientWidth, h = cv.clientHeight; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    size(); addEventListener('resize', size);
    SC.ticks.push((t) => {
      if (!down) { vel *= 0.94; rot += vel; idle += 0.016; }
      const sway = idle > 1.5 ? Math.sin(t * 0.6) * 0.42 : 0;
      g.rotation.y = rot + sway;
      g.position.y = Math.sin(t * 1.1) * 0.03;
      r.render(sc, cam);
    });
  });
})();

SC.station = { scene: stScene, camera: stCam, canvas: stCanvas, hits: stHits, knob, yarn, swatches,
  get dusk() { return dusk; }, get palette() { return palette.label; } };
setKnob(KNOB_MIN);
applyLook();
if (reduced) SC.ticks.forEach(f => f(0.001));
