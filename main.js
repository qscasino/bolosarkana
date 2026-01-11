import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

/* =========================
   DOM + UI STATE
========================= */
const $ = (id) => document.getElementById(id);

// ⚠️ Estos ya no existen en el HTML nuevo (scorecard eliminado)
const elScore = $("score-value");
const elFrame = $("frame-value");
const elBall  = $("ball-value");

const elLaunch = $("launch-btn");

const elPowerFill   = $("power-fill");
const elPowerGlow   = $("power-glow");
const elPowerPct    = $("power-percent");
const elDirCtrl     = $("direction-control");
const elDirInd      = $("direction-indicator");
const elStrike      = $("strike-overlay");
const elSpare       = $("spare-overlay");
const elInstr       = $("instructions");
const elLoading     = $("loading-screen");
const elLoadingFill = $("loading-bar-fill");

let gameState = "aiming"; // aiming | charging | throwing | waiting | resetting | locked
let direction = 0; // -1..1
let power = 0; // 0..1 (final)
let powerPct = 0; // 0..100 (UI)
let isCharging = false;
let powerDir = 1;
let powerTimer = null;

let throwStartMs = 0;
let score = 0;
let frame = 1;
let throwsInFrame = 0;
let pinsDownLastThrow = 0;
let totalPinsThisFrame = 0;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* =========================
   ✅ BLOQUEO + PREMIO PERSISTENTE
========================= */
const REWARD_KEY = "qs_bowling_reward_v1";

function safeLocalStorage() {
  try { return window.localStorage; } catch { return null; }
}
function loadSavedReward() {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(REWARD_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.bonus !== "number") return null;
    return data;
  } catch { return null; }
}
function saveReward(bonus, attemptNumber) {
  const ls = safeLocalStorage();
  if (!ls) return;
  const payload = { bonus, attemptNumber, ts: Date.now() };
  try { ls.setItem(REWARD_KEY, JSON.stringify(payload)); } catch {}
}

let savedReward = loadSavedReward();
let gameLocked = !!savedReward;

/* =========================
   3 INTENTOS + CAPTURA BOLA
========================= */
const MAX_ATTEMPTS = 3;
let attemptsUsed = 0;
let knockedBeforeThrow = 0;
let throwResolved = false;
let ballCaptured = false;

// Zona “cuadrado negro”
const CAPTURE_Z = -18.2;
const OOB_X = 3.0;
const OOB_Y_HIGH = 3.2;
const OOB_Y_LOW = -2.0;

// Detección “pin caído”
const KNOCK_TILT = 0.75;
const KNOCK_Y    = 0.18;

// ✅ Estabilización (para que NO se caigan solos al iniciar)
const PIN_STAND_Y_EPS = 0.003;

/* =========================
   MODAL
========================= */
function ensureRewardModal() {
  if (document.getElementById("reward-modal")) return;

  const style = document.createElement("style");
  style.id = "reward-modal-style";
  style.textContent = `
    #reward-modal{
      position: fixed; inset: 0;
      display: none;
      align-items: center; justify-content: center;
      background: rgba(0,0,0,.55);
      backdrop-filter: blur(10px);
      z-index: 999999;
      padding: 18px;
    }
    #reward-modal .card{
      width: min(520px, 92vw);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(10,10,25,.92), rgba(5,5,18,.92));
      border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 30px 90px rgba(0,0,0,.55);
      padding: 18px 16px;
      text-align: center;
      color: #fff;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }
    #reward-modal .title{
      font-size: 22px;
      margin: 0 0 8px;
      letter-spacing: .3px;
    }
    #reward-modal .msg{
      font-size: 16px;
      opacity: .92;
      margin: 0 0 14px;
      line-height: 1.35;
    }
    #reward-modal .glow{
      height: 2px;
      width: 100%;
      margin: 12px 0 16px;
      border-radius: 99px;
      background: linear-gradient(90deg, rgba(34,211,238,.0), rgba(34,211,238,.85), rgba(255,79,216,.85), rgba(34,211,238,.0));
      box-shadow: 0 0 18px rgba(34,211,238,.35), 0 0 18px rgba(255,79,216,.25);
    }
    #reward-modal .btn{
      width: 100%;
      border: none;
      cursor: pointer;
      padding: 12px 14px;
      border-radius: 14px;
      font-weight: 700;
      font-size: 15px;
      color: #0a0a15;
      background: linear-gradient(90deg, #22d3ee, #ff4fd8);
      box-shadow: 0 10px 26px rgba(34,211,238,.22), 0 10px 26px rgba(255,79,216,.18);
    }
    #reward-modal .btn:active{ transform: translateY(1px); }
  `;
  document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.id = "reward-modal";
  modal.innerHTML = `
    <div class="card">
      <h3 class="title" id="reward-title">¡Felicitaciones!</h3>
      <p class="msg" id="reward-msg">Mensaje</p>
      <div class="glow"></div>
      <button class="btn" id="reward-btn">Aceptar</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) hideRewardModal(false);
  });
  document.getElementById("reward-btn").addEventListener("click", () => hideRewardModal(true));
}

let rewardOnClose = null;

function showRewardModal(title, msg, onClose, btnLabel = "Aceptar") {
  ensureRewardModal();
  const modal = document.getElementById("reward-modal");
  document.getElementById("reward-title").textContent = title;
  document.getElementById("reward-msg").textContent = msg;
  document.getElementById("reward-btn").textContent = btnLabel;
  rewardOnClose = onClose || null;
  modal.style.display = "flex";
}

function hideRewardModal(callClose = false) {
  const modal = document.getElementById("reward-modal");
  if (!modal) return;
  modal.style.display = "none";
  if (callClose && typeof rewardOnClose === "function") {
    const cb = rewardOnClose;
    rewardOnClose = null;
    cb();
  } else {
    rewardOnClose = null;
  }
}

function bonusByAttempt(attemptNumber) {
  if (attemptNumber === 1) return 200;
  if (attemptNumber === 2) return 150;
  return 100;
}

/* =========================
   BOLA: CAPTURAR / OCULTAR
========================= */
function shouldCaptureBall() {
  const p = ballBody.position;
  return (
    p.z < CAPTURE_Z ||
    Math.abs(p.x) > OOB_X ||
    p.y > OOB_Y_HIGH ||
    p.y < OOB_Y_LOW
  );
}

function captureBall() {
  if (ballCaptured) return;
  ballCaptured = true;

  ball.group.visible = false;

  ballBody.velocity.set(0, 0, 0);
  ballBody.angularVelocity.set(0, 0, 0);
  ballBody.collisionResponse = false;

  ballBody.position.set(0, -50, -30);
}

/* =========================
   PIN CAÍDO / RETIRAR
========================= */
function finalizeKnockDetection() {
  for (const pin of pins) {
    if (pin.isRemoved || pin.isKnocked) continue;

    const euler = new THREE.Euler().setFromQuaternion(pin.group.quaternion, "XYZ");
    const tilt = Math.abs(euler.x) + Math.abs(euler.z);

    if (tilt > KNOCK_TILT || pin.body.position.y < KNOCK_Y) {
      pin.isKnocked = true;
      knockedSet.add(pin.id);
    }
  }
}

function retirePin(pin) {
  if (pin.isRemoved) return;
  pin.isRemoved = true;

  pin.group.visible = false;
  if (pin.body.world) world.removeBody(pin.body);
}

function retireKnockedPins() {
  finalizeKnockDetection();
  for (const pin of pins) {
    if (pin.isKnocked && !pin.isRemoved) retirePin(pin);
  }
}

/* =========================
   STATE HELPERS
========================= */
function setGameState(next) {
  if (gameLocked) next = "locked";
  gameState = next;
  refreshLaunchButton();
  if (elInstr) elInstr.style.display = (gameState === "aiming") ? "block" : "none";
  if (elDirCtrl) elDirCtrl.style.pointerEvents = (gameState === "locked") ? "none" : "auto";
}

function refreshLaunchButton() {
  elLaunch.classList.remove("btn-aiming", "btn-charging", "btn-disabled");

  if (gameState === "locked") {
    elLaunch.textContent = "PREMIO OBTENIDO";
    elLaunch.classList.add("btn", "btn-disabled");
    elLaunch.disabled = true;
    return;
  }

  if (gameState === "charging") {
    elLaunch.textContent = "SOLTAR";
    elLaunch.classList.add("btn", "btn-charging");
    elLaunch.disabled = false;
  } else if (gameState === "aiming") {
    elLaunch.textContent = "LANZAR";
    elLaunch.classList.add("btn", "btn-aiming");
    elLaunch.disabled = false;
  } else {
    elLaunch.textContent = "ESPERA...";
    elLaunch.classList.add("btn", "btn-disabled");
    elLaunch.disabled = true;
  }
}

function updateScoreUI() {
  if (elScore) elScore.textContent = String(score);
  if (elFrame) elFrame.textContent = String(frame);
  if (elBall)  elBall.textContent  = String(attemptsUsed + 1);
}

function getPowerGradient(pct) {
  if (pct < 30) return ["#22c55e", "#34d399"];
  if (pct < 70) return ["#eab308", "#facc15"];
  return ["#ef4444", "#fb923c"];
}

function updatePowerUI() {
  elPowerFill.style.height = `${powerPct}%`;
  elPowerGlow.style.height = `${powerPct}%`;
  elPowerPct.textContent = `${Math.round(powerPct)}%`;

  const [a, b] = getPowerGradient(powerPct);
  elPowerFill.style.background = `linear-gradient(to top, ${a}, ${b})`;
  elPowerGlow.style.boxShadow = `0 0 20px ${a}`;
}

/* =========================
   LOADING (simulado estilo v0)
========================= */
let loadingProgress = 0;
const loadingInterval = setInterval(() => {
  loadingProgress = Math.min(100, loadingProgress + Math.random() * 15);
  elLoadingFill.style.width = `${loadingProgress}%`;
  if (loadingProgress >= 100) {
    clearInterval(loadingInterval);
    setTimeout(() => {
      elLoading.style.opacity = "0";
      elLoading.style.transition = "opacity 500ms ease";
      setTimeout(() => elLoading.remove(), 520);
    }, 350);
  }
}, 200);

/* =========================
   INPUT: Direction control
========================= */
let draggingDir = false;

function setDirectionFromClientX(clientX) {
  if (gameLocked) return;

  const rect = elDirCtrl.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const offset = (clientX - centerX) / (rect.width / 2);
  direction = clamp(offset, -1, 1);

  const leftPct = 50 + direction * 40;
  elDirInd.style.left = `${leftPct}%`;

  if (gameState === "aiming") placeBallForAiming(direction);
}

elDirCtrl.addEventListener("pointerdown", (e) => {
  if (gameLocked) return;
  draggingDir = true;
  elDirCtrl.setPointerCapture(e.pointerId);
  setDirectionFromClientX(e.clientX);
});
elDirCtrl.addEventListener("pointermove", (e) => {
  if (!draggingDir || gameLocked) return;
  setDirectionFromClientX(e.clientX);
});
elDirCtrl.addEventListener("pointerup", () => (draggingDir = false));
elDirCtrl.addEventListener("pointercancel", () => (draggingDir = false));

/* =========================
   INPUT: Power charge (hold)
========================= */
function startCharge() {
  if (gameLocked) return;
  if (gameState !== "aiming") return;

  setGameState("charging");
  isCharging = true;
  powerPct = 0;
  powerDir = 1;
  updatePowerUI();
  elPowerGlow.classList.remove("hidden");

  if (powerTimer) clearInterval(powerTimer);
  powerTimer = setInterval(() => {
    if (!isCharging || gameState !== "charging") return;
    let next = powerPct + powerDir * 3;
    if (next >= 100) { next = 100; powerDir = -1; }
    if (next <= 0) { next = 0; powerDir = 1; }
    powerPct = next;
    updatePowerUI();
  }, 25);
}

function releaseCharge() {
  if (gameLocked) return;
  if (gameState !== "charging") return;

  isCharging = false;
  elPowerGlow.classList.add("hidden");
  if (powerTimer) { clearInterval(powerTimer); powerTimer = null; }

  power = clamp(powerPct / 100, 0, 1);
  doThrow(power);
}

elLaunch.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startCharge();
});
elLaunch.addEventListener("pointerup", (e) => {
  e.preventDefault();
  releaseCharge();
});
elLaunch.addEventListener("pointerleave", () => {
  if (isCharging) releaseCharge();
});
elLaunch.addEventListener("pointercancel", () => {
  if (isCharging) releaseCharge();
});

window.addEventListener("keydown", (e) => {
  if (gameLocked) return;

  if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    resetGame();
    return;
  }

  if (gameState === "aiming") {
    if (e.key === "ArrowLeft") direction = clamp(direction - 0.08, -1, 1);
    if (e.key === "ArrowRight") direction = clamp(direction + 0.08, -1, 1);

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const leftPct = 50 + direction * 40;
      elDirInd.style.left = `${leftPct}%`;
      placeBallForAiming(direction);
    }

    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      startCharge();
    }
  } else if (gameState === "charging" && (e.key === " " || e.key === "Enter")) {
    e.preventDefault();
    releaseCharge();
  }
});

/* =========================
   THREE + CANNON SETUP
========================= */
const container = $("three-container");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x1a0630, 0.028);
scene.background = null;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 4, 10);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// LIGHTING
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const hemi = new THREE.HemisphereLight(0xffb07a, 0x14061f, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffc48a, 1.2);
sun.position.set(-6, 10, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 50;
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
scene.add(sun);

function neonPoint(x, y, z, color, intensity, dist){
  const l = new THREE.PointLight(color, intensity, dist);
  l.position.set(x, y, z);
  scene.add(l);
  return l;
}
neonPoint(-1.7, 0.9,  2, 0x22d3ee, 1.2, 9);
neonPoint( 1.7, 0.9,  2, 0xff4fd8, 1.1, 9);

neonPoint(-1.6, 0.6, -6, 0x22d3ee, 1.4, 10);
neonPoint( 1.6, 0.6, -6, 0xff4fd8, 1.3, 10);

neonPoint( 0.0, 1.4, -14, 0x22d3ee, 0.9, 12);
neonPoint( 0.0, 2.8, -18, 0xffb84a, 0.55, 16);

/* =========================================================
   VISUAL THEME HELPERS
========================================================= */
function makeCanvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function makeSandTexture() {
  return makeCanvasTexture(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = "#d8b27b";
    ctx.fillRect(0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 32;
      d[i]   = clamp(d[i]   + n, 0, 255);
      d[i+1] = clamp(d[i+1] + n, 0, 255);
      d[i+2] = clamp(d[i+2] + n, 0, 255);
    }
    ctx.putImageData(img, 0, 0);

    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 1200; i++) {
      const r = 0.8 + Math.random()*1.8;
      ctx.fillStyle = `rgba(90,60,30,${0.15 + Math.random()*0.25})`;
      ctx.beginPath();
      ctx.arc(Math.random()*w, Math.random()*h, r, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
}

function addSunsetSkyDome(scene) {
  const geo = new THREE.SphereGeometry(120, 64, 64);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: false,
    fog: false,
    uniforms: {
      topColor:    { value: new THREE.Color(0x2a0d4a) },
      midColor:    { value: new THREE.Color(0xff4fb7) },
      bottomColor: { value: new THREE.Color(0xffb84a) },
      sunDir:      { value: new THREE.Vector3(0.0, 0.10, -1.0).normalize() },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 bottomColor;
      uniform vec3 sunDir;
      varying vec3 vWorld;

      void main(){
        vec3 dir = normalize(vWorld);
        float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

        vec3 colA = mix(bottomColor, midColor, smoothstep(0.0, 0.55, t));
        vec3 col  = mix(colA, topColor, smoothstep(0.45, 1.0, t));

        float s = max(dot(dir, sunDir), 0.0);
        float sun = pow(s, 220.0);
        float halo = pow(s, 18.0) * 0.35;

        col += vec3(1.0, 0.72, 0.35) * (sun * 2.0 + halo);
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -999;
  scene.add(dome);
  return dome;
}

function addHorizonSilhouettes(scene) {
  const city = new THREE.Group();
  const baseZ = -55;
  const mat = new THREE.MeshBasicMaterial({ color: 0x090510 });
  for (let i = 0; i < 28; i++) {
    const w = 0.6 + Math.random()*1.4;
    const h = 1.0 + Math.random()*5.5;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.8), mat);
    b.position.set(-10 + i*0.75 + (Math.random()-0.5)*0.4, h*0.5 - 0.2, baseZ);
    city.add(b);
  }
  scene.add(city);

  const palmMat = new THREE.MeshBasicMaterial({ color: 0x07030c, side: THREE.DoubleSide });
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 6.0), palmMat);
    p.position.set(-14 + i*4.0, 2.2, baseZ + 2.0);
    p.rotation.y = (Math.random()-0.5)*0.25;
    scene.add(p);
  }
}

function addStringLights(scene) {
  const bulbs = new THREE.Group();
  const bulbGeo = new THREE.SphereGeometry(0.07, 16, 16);

  const a = new THREE.Vector3(-3.6, 3.4, -6);
  const b = new THREE.Vector3( 0.0, 4.1, -10);
  const c = new THREE.Vector3( 3.6, 3.2, -6);

  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = new THREE.Vector3().copy(a).multiplyScalar((1-t)*(1-t))
      .add(new THREE.Vector3().copy(b).multiplyScalar(2*(1-t)*t))
      .add(new THREE.Vector3().copy(c).multiplyScalar(t*t));

    const warm = (i % 2 === 0);
    const m = new THREE.MeshBasicMaterial({ color: warm ? 0xffe08a : 0x22d3ee });
    const bulb = new THREE.Mesh(bulbGeo, m);
    bulb.position.copy(p);
    bulbs.add(bulb);

    const l = new THREE.PointLight(warm ? 0xffb84a : 0x22d3ee, 0.35, 2.2);
    l.position.copy(p);
    bulbs.add(l);
  }
  scene.add(bulbs);
}

function addBeachSidesWithProps(parent) {
  const sandTex = makeSandTexture();
  sandTex.repeat.set(3, 6);

  const sandMat = new THREE.MeshStandardMaterial({
    color: 0xf0c98d,
    map: sandTex,
    roughness: 0.95,
    metalness: 0.0
  });

  const sandL = new THREE.Mesh(new THREE.PlaneGeometry(6, 30), sandMat);
  sandL.rotation.x = -Math.PI / 2;
  sandL.position.set(-4.2, -0.09, -5);
  sandL.receiveShadow = true;
  parent.add(sandL);

  const sandR = new THREE.Mesh(new THREE.PlaneGeometry(6, 30), sandMat);
  sandR.rotation.x = -Math.PI / 2;
  sandR.position.set( 4.2, -0.09, -5);
  sandR.receiveShadow = true;
  parent.add(sandR);

  scatterProps(parent, -4.2, -5);
  scatterProps(parent,  4.2, -5);
}

function scatterProps(parent, sideX, centerZ) {
  const g = new THREE.Group();
  g.position.set(sideX, 0, 0);

  function chip(x, z, c1, c2){
    const chipGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.06, 28);
    const mat = new THREE.MeshStandardMaterial({ color: c1, roughness: 0.35, metalness: 0.25 });
    const top = new THREE.MeshStandardMaterial({ color: c2, roughness: 0.35, metalness: 0.25 });

    const m = new THREE.Mesh(chipGeo, mat);
    m.position.set(x, -0.02, z);
    m.rotation.y = Math.random()*Math.PI;
    m.castShadow = true;
    g.add(m);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.015, 10, 24), top);
    ring.position.copy(m.position);
    ring.rotation.set(Math.PI/2, 0, m.rotation.y);
    ring.castShadow = true;
    g.add(ring);
  }

  function dice(x, z){
    const d = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.22),
      new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.35, metalness: 0.0 })
    );
    d.position.set(x, 0.02, z);
    d.rotation.set(Math.random()*0.6, Math.random()*Math.PI, Math.random()*0.6);
    d.castShadow = true;
    g.add(d);
  }

  function card(x, z){
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.45, 0.62),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide })
    );
    m.position.set(x, -0.02, z);
    m.rotation.set(-Math.PI/2, 0, (Math.random()-0.5)*0.6);
    g.add(m);

    const pip = new THREE.Mesh(
      new THREE.CircleGeometry(0.06, 18),
      new THREE.MeshBasicMaterial({ color: Math.random() > 0.5 ? 0xff2d5f : 0x111111 })
    );
    pip.position.set(x + (Math.random()-0.5)*0.12, -0.019, z + (Math.random()-0.5)*0.12);
    pip.rotation.x = -Math.PI/2;
    g.add(pip);
  }

  const zMin = centerZ - 13;
  const zMax = centerZ + 13;

  for (let i = 0; i < 10; i++){
    const x = (Math.random()-0.5) * 2.2;
    const z = zMin + Math.random()*(zMax - zMin);
    const r = Math.random();
    if (r < 0.45) chip(x, z, 0x22d3ee, 0xffb84a);
    else if (r < 0.70) chip(x, z, 0xff4fd8, 0xffb84a);
    else if (r < 0.88) dice(x, z);
    else card(x, z);
  }

  parent.add(g);
}

/* =========================
   PHYSICS
========================= */
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });

// ✅ clave: permitir sleep (evita caídas instantáneas al iniciar)
world.allowSleep = true;

// un poco más estable
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 14;
world.solver.tolerance = 0.001;

const floorMat = new CANNON.Material("floor");
const ballMat  = new CANNON.Material("ball");
const pinMat   = new CANNON.Material("pin");

// Contacts (menos rebote + menos “pin a la luna”)
world.defaultContactMaterial = new CANNON.ContactMaterial(floorMat, floorMat, {
  restitution: 0.05,
  friction: 0.75
});

world.addContactMaterial(new CANNON.ContactMaterial(ballMat, floorMat, {
  restitution: 0.03,
  friction: 0.18
}));
world.addContactMaterial(new CANNON.ContactMaterial(pinMat, floorMat, {
  restitution: 0.05,
  friction: 0.55
}));
world.addContactMaterial(new CANNON.ContactMaterial(ballMat, pinMat, {
  restitution: 0.10,
  friction: 0.25
}));
world.addContactMaterial(new CANNON.ContactMaterial(pinMat, pinMat, {
  restitution: 0.12,
  friction: 0.45
}));

/* Floor plane */
const floorBody = new CANNON.Body({ mass: 0, material: floorMat });
floorBody.addShape(new CANNON.Plane());
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

/* Invisible side walls */
addStaticWall(-1.15, 0.25, -5, 0.05, 0.6, 32);
addStaticWall( 1.15, 0.25, -5, 0.05, 0.6, 32);
/* Back stop */
addStaticWall(0, 0.6, -19.5, 3, 1.2, 0.2);

function addStaticWall(x, y, z, sx, sy, sz) {
  const body = new CANNON.Body({ mass: 0, material: floorMat });
  body.position.set(x, y, z);
  body.addShape(new CANNON.Box(new CANNON.Vec3(sx, sy, sz)));
  world.addBody(body);
}

/* =========================
   SCENE BUILD
========================= */
const laneGroup = new THREE.Group();
scene.add(laneGroup);

const torches = [];

buildLane(laneGroup);
buildSideNeonRails(laneGroup);
buildBackArch(laneGroup);
buildDecor(laneGroup);

addSunsetSkyDome(scene);
addHorizonSilhouettes(scene);
addStringLights(scene);
addBeachSidesWithProps(laneGroup);

// PIN SIZE
const PIN_HEIGHT = 0.82;
const PIN_Y = PIN_HEIGHT / 2;
const PIN_R_BOTTOM = 0.11;
const PIN_R_TOP = 0.06;

// posiciones compactas
const PIN_POSITIONS = [
  [ 0.00, PIN_Y, -15.00],
  [-0.23, PIN_Y, -15.42],
  [ 0.23, PIN_Y, -15.42],
  [-0.46, PIN_Y, -15.84],
  [ 0.00, PIN_Y, -15.84],
  [ 0.46, PIN_Y, -15.84],
  [-0.69, PIN_Y, -16.26],
  [-0.23, PIN_Y, -16.26],
  [ 0.23, PIN_Y, -16.26],
  [ 0.69, PIN_Y, -16.26],
];

const ball = createElectricBall();
scene.add(ball.group);

const ballBody = new CANNON.Body({
  mass: 6,
  material: ballMat,
  linearDamping: 0.25,
  angularDamping: 0.35,
});
ballBody.addShape(new CANNON.Sphere(0.25));
ballBody.position.set(0, 0.25, 7);
ballBody.allowSleep = true;
ballBody.sleepSpeedLimit = 0.1;
ballBody.sleepTimeLimit = 0.4;
world.addBody(ballBody);

let ballHasThrown = false;

const aimIndicator = createAimIndicator();
scene.add(aimIndicator);

const pins = [];
const pinByBodyId = new Map();

for (let i = 0; i < PIN_POSITIONS.length; i++) {
  const p = createPin(i, PIN_POSITIONS[i]);
  pins.push(p);
  scene.add(p.group);
  world.addBody(p.body);
  pinByBodyId.set(p.body.id, p);
}

let knockedSet = new Set();

/* =========================
   ✅ Onda expansiva hacia atrás + control
========================= */
let lastShockMs = 0;

function applyBackShock(primaryPin) {
  const now = performance.now();
  if (now - lastShockMs < 70) return;
  lastShockMs = now;

  const v = ballBody.velocity;
  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed < 2.0) return;

  // centrado => más “strike probable”
  const centerFactor = 1 - clamp(Math.abs(ballBody.position.x) / 0.95, 0, 1);
  const baseMag = (2.0 + speed * 0.22) * (0.85 + power * 0.55) * (0.75 + centerFactor * 0.65);

  const dx = clamp(primaryPin.body.position.x - ballBody.position.x, -0.55, 0.55);
  const dirMain = new CANNON.Vec3(dx * 0.55, 0.09, -1.0);
  dirMain.normalize();

  primaryPin.body.wakeUp();
  primaryPin.body.applyImpulse(dirMain.scale(baseMag), primaryPin.body.position);

  const radius = 0.95 + centerFactor * 0.35;
  for (const pin of pins) {
    if (pin === primaryPin) continue;
    if (pin.isRemoved) continue;

    const dxn = pin.body.position.x - primaryPin.body.position.x;
    const dzn = pin.body.position.z - primaryPin.body.position.z;
    const dist = Math.hypot(dxn, dzn);
    if (dist > radius) continue;

    const t = 1 - dist / radius;
    const mag = baseMag * (0.55 * t);

    const dir = new CANNON.Vec3(clamp(dxn * 0.22, -0.25, 0.25), 0.06, -1.0);
    dir.normalize();

    pin.body.wakeUp();
    pin.body.applyImpulse(dir.scale(mag), pin.body.position);
  }
}

ballBody.addEventListener("collide", (e) => {
  const other = e.body;
  const pin = pinByBodyId.get(other?.id);
  if (!pin || pin.isRemoved) return;

  const now = performance.now();
  if (pin._lastShock && now - pin._lastShock < 120) return;
  pin._lastShock = now;

  applyBackShock(pin);
});

/* =========================
   ✅ clamp de movimiento (anti “vuelos” y anti hacia la pista)
========================= */
function clampPinsMotion() {
  for (const pin of pins) {
    if (pin.isRemoved) continue;

    const v = pin.body.velocity;
    const w = pin.body.angularVelocity;

    // no “disparo” hacia adelante (z positivo)
    if (v.z > 1.6) v.z = 1.6;

    v.x = clamp(v.x, -6.0, 6.0);
    v.y = clamp(v.y, -4.0, 6.0);
    v.z = clamp(v.z, -22.0, 2.0);

    w.x = clamp(w.x, -22, 22);
    w.y = clamp(w.y, -22, 22);
    w.z = clamp(w.z, -22, 22);
  }
}

/* =========================
   ✅ plantar pinos parados (inicio / reset)
========================= */
function plantPinsStanding() {
  for (const pin of pins) {
    if (pin.isRemoved) continue;

    pin.isKnocked = false;
    const [x, y, z] = pin.initialPos;

    pin.body.position.set(x, y + PIN_STAND_Y_EPS, z);
    pin.body.velocity.set(0, 0, 0);
    pin.body.angularVelocity.set(0, 0, 0);
    pin.body.quaternion.set(0, 0, 0, 1);

    // quedan durmiendo, se despiertan con choque
    pin.body.sleep();
  }
}

/* =========================
   GAME LOGIC
========================= */
function doThrow(pwr01) {
  if (gameLocked) return;

  power = pwr01;

  if (gameState !== "charging" && gameState !== "aiming") return;
  if (ballHasThrown) return;
  if (attemptsUsed >= MAX_ATTEMPTS) return;

  setGameState("throwing");

  knockedBeforeThrow = knockedSet.size;
  throwResolved = false;
  ballCaptured = false;

  ball.group.visible = true;
  ballBody.collisionResponse = true;

  pinsDownLastThrow = 0;
  ballHasThrown = true;
  throwStartMs = performance.now();

  if (typeof ballBody.wakeUp === "function") ballBody.wakeUp();
  for (const p of pins) {
    if (p.isRemoved) continue;
    if (typeof p.body.wakeUp === "function") p.body.wakeUp();
  }

  const throwPower = 18 + power * 12;
  const directionRad = direction * 0.35;

  ballBody.velocity.set(
    Math.sin(directionRad) * throwPower * 0.25,
    0,
    -throwPower
  );
  ballBody.angularVelocity.set(-throwPower * 3, Math.sin(directionRad) * 5, 0);
}

function lockGameWithReward(bonus, attemptNumber) {
  gameLocked = true;
  saveReward(bonus, attemptNumber);
  savedReward = loadSavedReward();
  setGameState("locked");
}

function onThrowComplete() {
  if (gameState !== "throwing") return;

  setGameState("waiting");

  setTimeout(() => {
    if (throwResolved) return;
    throwResolved = true;

    finalizeKnockDetection();

    const totalKnocked = knockedSet.size;
    const knockedThisThrow = Math.max(0, totalKnocked - knockedBeforeThrow);

    if (knockedThisThrow > 0) {
      handlePinsKnocked(knockedThisThrow, totalKnocked, attemptsUsed + 1);
    }

    const attemptNumber = attemptsUsed + 1;

    if (totalKnocked >= 10) {
      const bonus = bonusByAttempt(attemptNumber);

      if (attemptNumber === 1) showStrike();
      else showSpare();

      // ✅ strike => bloqueado + guardado
      lockGameWithReward(bonus, attemptNumber);

      showRewardModal(
        "¡Felicitaciones! 🎉",
        `Obtuviste un ${bonus}% de bono.`,
        null,
        "Aceptar"
      );
      return;
    }

    attemptsUsed++;
    throwsInFrame = attemptsUsed;
    updateScoreUI();

    retireKnockedPins();

    if (attemptsUsed >= MAX_ATTEMPTS) {
      setGameState("resetting");
      showRewardModal(
        "¡Se terminaron tus intentos!",
        "No lograste tirar todos los pinos. Podés intentar de nuevo.",
        () => resetGame(),
        "Jugar de nuevo"
      );
      return;
    }

    setGameState("aiming");
    resetBall(false);
    placeBallForAiming(direction);
  }, 1500);
}

function handlePinsKnocked(countThisThrow, totalKnocked, attemptNumber) {
  pinsDownLastThrow = countThisThrow;
  totalPinsThisFrame = totalKnocked;

  score += countThisThrow * 10;
  updateScoreUI();

  if (totalKnocked === 10 && attemptNumber === 1) showStrike();
  else if (totalKnocked === 10 && attemptNumber > 1) showSpare();
}

function showStrike() {
  if (!elStrike) return;
  elStrike.classList.remove("hidden");
  setTimeout(() => elStrike.classList.add("hidden"), 2500);
}
function showSpare() {
  if (!elSpare) return;
  elSpare.classList.remove("hidden");
  setTimeout(() => elSpare.classList.add("hidden"), 2500);
}

function resetGame() {
  if (gameLocked) return;

  score = 0;
  frame = 1;
  throwsInFrame = 0;

  pinsDownLastThrow = 0;
  totalPinsThisFrame = 0;

  attemptsUsed = 0;
  knockedBeforeThrow = 0;
  throwResolved = false;
  ballCaptured = false;

  knockedSet = new Set();

  setGameState("resetting");
  updateScoreUI();

  setTimeout(() => {
    resetPins();
    resetBall(true);
    setGameState("aiming");
    updateScoreUI();
  }, 600);
}

/* =========================
   RESET HELPERS
========================= */
function resetBall(hard = true) {
  ballHasThrown = false;

  ball.group.visible = true;
  ballBody.collisionResponse = true;

  ballBody.velocity.set(0, 0, 0);
  ballBody.angularVelocity.set(0, 0, 0);
  ballBody.quaternion.set(0, 0, 0, 1);

  if (hard) {
    ballBody.position.set(0, 0.25, 7);
    direction = 0;
    if (elDirInd) elDirInd.style.left = "50%";
  }
}

function placeBallForAiming(dir) {
  if (gameLocked) return;
  if (gameState !== "aiming") return;

  ball.group.visible = true;
  ballBody.collisionResponse = true;

  ballBody.position.set(dir * 0.8, 0.25, 7);
  ballBody.velocity.set(0, 0, 0);
  ballBody.angularVelocity.set(0, 0, 0);
  ballBody.quaternion.set(0, 0, 0, 1);
}

function resetPins() {
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];

    pin.isKnocked = false;
    pin.isRemoved = false;
    pin.group.visible = true;

    if (!pin.body.world) world.addBody(pin.body);

    const [x, y, z] = pin.initialPos;
    pin.body.position.set(x, y + PIN_STAND_Y_EPS, z);
    pin.body.velocity.set(0, 0, 0);
    pin.body.angularVelocity.set(0, 0, 0);
    pin.body.quaternion.set(0, 0, 0, 1);

    pin.body.sleep();
  }
}

/* =========================
   ANIMATION LOOP
========================= */
let lastT = performance.now();
let acc = 0;
const fixedDt = 1 / 60;

refreshLaunchButton();
updateScoreUI();
updatePowerUI();
placeBallForAiming(direction);

// ✅ al iniciar: plantar pinos
plantPinsStanding();

// ✅ si ya ganó antes (reload): bloquear + mostrar premio
if (gameLocked && savedReward) {
  setGameState("locked");
  setTimeout(() => {
    showRewardModal(
      "Premio ya obtenido ✅",
      `Tu premio fue: ${savedReward.bonus}% de bono.`,
      null,
      "Aceptar"
    );
  }, 950);
}

function animate(t) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;
  acc += dt;

  while (acc >= fixedDt) {
    world.step(fixedDt);
    clampPinsMotion();
    acc -= fixedDt;
  }

  if (gameState === "throwing" && ballHasThrown && !ballCaptured && shouldCaptureBall()) {
    captureBall();
    onThrowComplete();
  }

  ball.group.position.copy(ballBody.position);
  ball.group.quaternion.copy(ballBody.quaternion);
  ball.update(t / 1000);

  for (const pin of pins) {
    if (pin.isRemoved) continue;

    pin.group.position.copy(pin.body.position);
    pin.group.quaternion.copy(pin.body.quaternion);

    if (!pin.isKnocked) {
      const euler = new THREE.Euler().setFromQuaternion(pin.group.quaternion, "XYZ");
      const tilt = Math.abs(euler.x) + Math.abs(euler.z);

      if (tilt > KNOCK_TILT || pin.body.position.y < KNOCK_Y) {
        pin.isKnocked = true;
        knockedSet.add(pin.id);
      }
    }
  }

  aimIndicator.visible = (gameState === "aiming" && !gameLocked);
  if (aimIndicator.visible) aimIndicator.position.set(direction * 0.8, 0.03, 6);

  updateTorches(t / 1000);

  if (gameState === "throwing" && ballHasThrown && !ballCaptured) {
    const elapsed = (t - throwStartMs) / 1000;
    const v = ballBody.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    const movedForward = ballBody.position.z < 6.6;

    if (elapsed > 0.25 && movedForward && (speed < 0.35 || ballBody.position.z < -20)) {
      onThrowComplete();
    }
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

/* =========================
   BUILD FUNCTIONS (3D)
========================= */
function buildLane(parent) {
  const laneMat = new THREE.MeshStandardMaterial({ color: 0xc9a66b, roughness: 0.4, metalness: 0.05 });
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(2, 28), laneMat);
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, 0.01, -5);
  lane.receiveShadow = true;
  parent.add(lane);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, transparent: true, opacity: 0.5 });
  for (let i = 0; i < 15; i++) {
    const x = -0.9 + i * 0.13;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 28), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.015, -5);
    parent.add(m);
  }

  const dotMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  [-0.4, -0.2, 0, 0.2, 0.4].forEach((x) => {
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), dotMat);
    d.rotation.x = -Math.PI / 2;
    d.position.set(x, 0.02, 5);
    parent.add(d);
  });

  const foul = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.03), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  foul.rotation.x = -Math.PI / 2;
  foul.position.set(0, 0.02, 3);
  parent.add(foul);

  const gutterMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.8 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  [-1.15, 1.15].forEach((x, i) => {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 28), gutterMat);
    g.rotation.x = -Math.PI / 2;
    g.position.set(x, -0.08, -5);
    g.receiveShadow = true;
    parent.add(g);

    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 28), edgeMat);
    edge.position.set(x + (i === 0 ? 0.15 : -0.15), 0, -5);
    edge.castShadow = true;
    parent.add(edge);
  });

  const deck = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 3.5),
    new THREE.MeshStandardMaterial({ color: 0xb8956a, roughness: 0.35, metalness: 0.05 })
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(0, 0.015, -15.75);
  deck.receiveShadow = true;
  parent.add(deck);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a0a15 });
  [-2.5, 2.5].forEach((x) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3, 30), wallMat);
    w.position.set(x, 1.5, -5);
    w.receiveShadow = true;
    parent.add(w);
  });
}

function buildSideNeonRails(parent) {
  [-1.35, 1.35].forEach((x, i) => {
    const rail = new THREE.Group();

    const main = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 1, 28),
      new THREE.MeshStandardMaterial({ color: 0x111122, metalness: 0.8, roughness: 0.2 })
    );
    main.position.set(x, 0.5, -5);
    main.castShadow = true;
    rail.add(main);

    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.6, 27),
      new THREE.MeshStandardMaterial({
        color: 0x06121a,
        emissive: 0x22d3ee,
        emissiveIntensity: 2.4,
        roughness: 0.25,
        metalness: 0.2
      })
    );
    strip.position.set(x + (i === 0 ? 0.07 : -0.07), 0.3, -5);
    rail.add(strip);

    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.8, 27.5),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending })
    );
    glow.position.set(x + (i === 0 ? 0.1 : -0.1), 0.3, -5);
    rail.add(glow);

    [-10, -5, 0, 5].forEach((z) => {
      const pl = new THREE.PointLight(0x00e5ff, 0.8, 4);
      pl.position.set(x + (i === 0 ? 0.2 : -0.2), 0.3, z);
      rail.add(pl);
    });

    parent.add(rail);
  });
}

function buildBackArch(parent) {
  const group = new THREE.Group();
  group.position.set(0, 0, -18);

  const mat = new THREE.MeshStandardMaterial({ color: 0x0a0a15, metalness: 0.9, roughness: 0.1 });
  const neon = new THREE.MeshBasicMaterial({ color: 0x00e5ff });

  [-1.5, 1.5].forEach((x) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3, 0.25), mat);
    p.position.set(x, 1.5, 0);
    p.castShadow = true;
    group.add(p);
  });

  const top = new THREE.Mesh(new THREE.BoxGeometry(3.25, 0.2, 0.25), mat);
  top.position.set(0, 3, 0);
  top.castShadow = true;
  group.add(top);

  const neonTop = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.05, 0.02), neon);
  neonTop.position.set(0, 3.1, 0.15);
  group.add(neonTop);

  [-1.5, 1.5].forEach((x, i) => {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.2, 0.02), neon);
    v.position.set(x + (i === 0 ? -0.13 : 0.13), 1.5, 0.15);
    group.add(v);
  });

  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3.5, 0.1), new THREE.MeshStandardMaterial({ color: 0x050510 }));
  wall.position.set(0, 1.5, -0.3);
  wall.receiveShadow = true;
  group.add(wall);

  parent.add(group);
}

function buildDecor(parent) {
  parent.add(makeChipStack([-2, 0, 6], ["#cc0000", "#ffffff", "#000000"]));
  parent.add(makeChipStack([2, 0, 5], ["#0066cc", "#ffd700", "#cc0000"]));
  parent.add(makeChipStack([-2.2, 0, 2], ["#008800", "#ffd700", "#ffffff"]));
  parent.add(makeChipStack([2.2, 0, 0], ["#660066", "#cc0000", "#ffd700"]));

  parent.add(makePalm([-3.5, 0, -3], 0.8));
  parent.add(makePalm([3.5, 0, -8], 0.7));

  const t1 = makeTorch([-2.8, 0, 8]);
  const t2 = makeTorch([2.8, 0, 8]);
  parent.add(t1.group);
  parent.add(t2.group);
  torches.push(t1, t2);
}

function makeChipStack(pos, colors) {
  const g = new THREE.Group();
  g.position.set(...pos);

  colors.forEach((c, i) => {
    const chip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 0.05, 32),
      new THREE.MeshStandardMaterial({ color: c, metalness: 0.3, roughness: 0.4 })
    );
    chip.position.set(0, 0.03 + i * 0.06, 0);
    chip.rotation.y = i * 0.5;
    chip.castShadow = true;
    g.add(chip);

    const edge = new THREE.Mesh(
      new THREE.TorusGeometry(0.14, 0.012, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.7, roughness: 0.2 })
    );
    edge.position.copy(chip.position);
    edge.rotation.set(Math.PI / 2, 0, chip.rotation.y);
    edge.castShadow = true;
    g.add(edge);
  });

  return g;
}

function makePalm(pos, scale = 1) {
  const g = new THREE.Group();
  g.position.set(...pos);
  g.scale.setScalar(scale);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, 2.4, 8),
    new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 })
  );
  trunk.position.set(0, 1.2, 0);
  trunk.castShadow = true;
  g.add(trunk);

  [0.3, 0.7, 1.1, 1.5, 1.9].forEach((y, i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.1 - i * 0.005, 0.015, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x4e342e, roughness: 0.9 })
    );
    ring.position.set(0, y, 0);
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = true;
    g.add(ring);
  });

  const frondMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.8, side: THREE.DoubleSide });
  [0, 45, 90, 135, 180, 225, 270, 315].forEach((angle) => {
    const fr = new THREE.Group();
    fr.position.set(0, 2.3, 0);
    fr.rotation.set(0.6, (angle * Math.PI) / 180, 0);

    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.15, 1.2, 4), frondMat);
    cone.position.set(0, 0.4, 0);
    cone.rotation.x = 0.3;
    cone.castShadow = true;
    fr.add(cone);
    g.add(fr);
  });

  const cocoMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.7 });
  [
    [0.08, 2.15, 0.05],
    [-0.06, 2.12, -0.08],
  ].forEach((p) => {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), cocoMat);
    c.position.set(...p);
    c.castShadow = true;
    g.add(c);
  });

  return g;
}

function makeTorch(pos) {
  const group = new THREE.Group();
  group.position.set(...pos);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, 1.4, 8),
    new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.8 })
  );
  pole.position.set(0, 0.7, 0);
  pole.castShadow = true;
  group.add(pole);

  const basket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.06, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.9 })
  );
  basket.position.set(0, 1.45, 0);
  basket.castShadow = true;
  group.add(basket);

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.2, 8),
    new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 })
  );
  flame.position.set(0, 1.6, 0);
  group.add(flame);

  const inner = new THREE.Mesh(
    new THREE.ConeGeometry(0.03, 0.12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffff00 })
  );
  inner.position.set(0, 1.58, 0);
  group.add(inner);

  const light = new THREE.PointLight(0xff6622, 1.5, 4);
  light.position.set(0, 1.6, 0);
  group.add(light);

  return { group, flame, light };
}

function updateTorches(time) {
  for (const t of torches) {
    const flicker = Math.sin(time * 10) * 0.1 + Math.sin(time * 15) * 0.05;
    t.flame.scale.y = 1 + flicker;
    t.light.intensity = 1.5 + flicker * 2;
  }
}

function createElectricBall() {
  const group = new THREE.Group();

  const main = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 64, 64),
    new THREE.MeshStandardMaterial({ color: 0x0066cc, metalness: 0.9, roughness: 0.1, envMapIntensity: 1 })
  );
  main.castShadow = true;
  group.add(main);

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending })
  );
  glow.scale.setScalar(1.1);
  group.add(glow);

  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending })
  );
  inner.scale.setScalar(1.05);
  group.add(inner);

  const rings = [];
  for (let i = 0; i < 6; i++) {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(0.25, 0.008, 8, 32, Math.PI * 0.6),
      new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending })
    );
    r.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    rings.push(r);
    group.add(r);
  }

  const pl = new THREE.PointLight(0x00d4ff, 2, 3);
  group.add(pl);

  function update(time) {
    const pulse = Math.sin(time * 8) * 0.2 + 0.8;
    glow.scale.setScalar(1 + pulse * 0.15);
    rings.forEach((r, i) => (r.rotation.z += 0.01 + i * 0.0007));
  }

  return { group, update };
}

function createPin(id, pos) {
  const group = new THREE.Group();

  const whiteMat = new THREE.MeshPhysicalMaterial({
    color: 0xfaf7f2,
    roughness: 0.22,
    metalness: 0.0,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
  });

  const redMat = new THREE.MeshStandardMaterial({
    color: 0xd1162a,
    roughness: 0.35,
    metalness: 0.05,
  });

  const h = PIN_HEIGHT;
  const y0 = -h / 2;

  const profile = [
    new THREE.Vector2(0.060, y0 + 0.00 * h),
    new THREE.Vector2(0.110, y0 + 0.05 * h),
    new THREE.Vector2(0.115, y0 + 0.12 * h),
    new THREE.Vector2(0.102, y0 + 0.28 * h),
    new THREE.Vector2(0.078, y0 + 0.45 * h),
    new THREE.Vector2(0.095, y0 + 0.62 * h),
    new THREE.Vector2(0.090, y0 + 0.72 * h),
    new THREE.Vector2(0.070, y0 + 0.82 * h),
    new THREE.Vector2(0.060, y0 + 0.90 * h),
    new THREE.Vector2(0.065, y0 + 0.96 * h),
    new THREE.Vector2(0.050, y0 + 1.00 * h),
  ];

  const geo = new THREE.LatheGeometry(profile, 48);
  geo.computeVertexNormals();

  const pinMesh = new THREE.Mesh(geo, whiteMat);
  pinMesh.castShadow = true;
  group.add(pinMesh);

  const ringRadius = 0.085;
  const ringTube = 0.0075;

  const ring1 = new THREE.Mesh(
    new THREE.TorusGeometry(ringRadius, ringTube, 10, 48),
    redMat
  );
  ring1.rotation.x = Math.PI / 2;
  ring1.position.y = y0 + 0.70 * h;
  ring1.castShadow = true;
  group.add(ring1);

  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(ringRadius * 0.97, ringTube, 10, 48),
    redMat
  );
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = y0 + 0.75 * h;
  ring2.castShadow = true;
  group.add(ring2);

  const pinBody = new CANNON.Body({
    mass: 1.6,
    material: pinMat,
    linearDamping: 0.45,
    angularDamping: 0.45,
    position: new CANNON.Vec3(pos[0], pos[1] + PIN_STAND_Y_EPS, pos[2]),
  });

  // ✅ sleep para estabilidad inicial
  pinBody.allowSleep = true;
  pinBody.sleepSpeedLimit = 0.12;
  pinBody.sleepTimeLimit = 0.45;

  const shape = new CANNON.Cylinder(PIN_R_TOP, PIN_R_BOTTOM, PIN_HEIGHT, 14);
  const q = new CANNON.Quaternion();
  q.setFromEuler(Math.PI / 2, 0, 0);
  pinBody.addShape(shape, new CANNON.Vec3(0, 0, 0), q);

  // arrancan durmiendo
  pinBody.sleep();

  return {
    id,
    group,
    body: pinBody,
    initialPos: [pos[0], pos[1], pos[2]],
    isKnocked: false,
    isRemoved: false,
    _lastShock: 0,
  };
}

function createAimIndicator() {
  const g = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.2, 32),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);

  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.1, 0.3, 3),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.6 })
  );
  arrow.position.set(0, 0.01, -0.4);
  arrow.rotation.x = -Math.PI / 2;
  g.add(arrow);

  return g;
}
