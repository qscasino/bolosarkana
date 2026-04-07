import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

const isMobile = matchMedia("(max-width:820px)").matches || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const PERF = {
  mobile: isMobile, dprCap: isMobile?1.0:2.0, antialias:!isMobile,
  targetFps: isMobile?30:60, fogDensity: isMobile?0.012:0.018,
  shadows:!isMobile, shadowMapSize: isMobile?1024:2048,
  ballSeg: isMobile?24:64, ballGlowSeg: isMobile?16:32,
  pinLatheSeg: isMobile?20:48, pinRingSeg: isMobile?18:48,
  skySeg: isMobile?28:64, bulbSeg: isMobile?10:16,
  fixedDt: isMobile?1/40:1/60, maxSubsteps: isMobile?2:4,
  solverIterations: isMobile?10:14, solverTolerance: isMobile?0.002:0.001,
  clampAccMax: isMobile?0.05:0.033,
};

const $=id=>document.getElementById(id);
const elLaunch=$("launch-btn");
const elPowerFill=$("power-fill"), elPowerGlow=$("power-glow"), elPowerPct=$("power-percent");
const elDirCtrl=$("direction-control"), elDirInd=$("direction-indicator");
const elStrike=$("strike-overlay"), elSpare=$("spare-overlay");
const elInstr=$("instructions");
const elLoading=$("loading-screen"), elLoadingFill=$("loading-bar-fill");

/* ══ GAME STATE ══ */
let gameState="aiming", direction=0, power=0, powerPct=0;
let isCharging=false, powerDir=1, powerTimer=null;
let throwStartMs=0, score=0, frame=1, throwsInFrame=0;
let pinsDownLastThrow=0, totalPinsThisFrame=0;
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

/* ══ AUDIO — AudioContext creado SÍNCRONAMENTE en el gesto ══ */
const AUDIO_URLS={ambient:"./assets/ambient.mp3",hit:"./assets/hit.mp3",reward:"./assets/reward.mp3"};
const AudioSys=(()=>{
  const buffers=new Map();
  let ctx=null,gainMaster=null,gainSfx=null,gainMusic=null,musicSrc=null,unlocked=false;

  /* SÍNCRONO — debe correr dentro del evento de usuario sin ningún await previo */
  function initCtx(){
    if(ctx)return true;
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return false;
    try{
      ctx=new AC();
      gainMaster=ctx.createGain(); gainSfx=ctx.createGain(); gainMusic=ctx.createGain();
      gainMaster.gain.value=0.9; gainSfx.gain.value=0.95; gainMusic.gain.value=0.35;
      gainSfx.connect(gainMaster); gainMusic.connect(gainMaster); gainMaster.connect(ctx.destination);
      return true;
    }catch(e){ctx=null;return false;}
  }

  async function loadBuf(name){
    if(buffers.has(name))return buffers.get(name);
    const url=AUDIO_URLS[name];if(!url||!ctx)return null;
    try{
      const res=await fetch(url,{cache:'force-cache'});
      const arr=await res.arrayBuffer();
      const buf=await ctx.decodeAudioData(arr);
      buffers.set(name,buf);return buf;
    }catch(e){console.warn('[audio] no se pudo cargar:',name,e.message);return null;}
  }

  async function startAmbient(){
    if(!unlocked||!ctx||musicSrc)return;
    const buf=await loadBuf('ambient');if(!buf)return;
    try{
      if(musicSrc)return;
      const src=ctx.createBufferSource();src.buffer=buf;src.loop=true;
      src.connect(gainMusic);src.start(0);musicSrc=src;
    }catch{}
  }

  /* PUNTO DE ENTRADA — llamado desde el gesto del usuario */
  function unlock(){
    if(unlocked)return;
    /* 1. Crear contexto síncronamente (dentro del frame del gesto) */
    if(!initCtx())return;
    /* 2. Resume puede ser async, ya tenemos el contexto */
    ctx.resume().then(()=>{
      unlocked=true;
      /* Precargar sonidos ahora que el ctx está activo */
      Object.keys(AUDIO_URLS).forEach(n=>loadBuf(n));
      startAmbient();
    }).catch(()=>{});
  }

  function play(name,{volume=1,rate=1}={}){
    if(!unlocked||!ctx)return;
    const buf=buffers.get(name);
    if(!buf){loadBuf(name);return;}
    try{
      const src=ctx.createBufferSource();src.buffer=buf;
      src.playbackRate.value=Math.max(0.25,Math.min(3,rate));
      const g=ctx.createGain();g.gain.value=Math.max(0,Math.min(1,volume));
      src.connect(g);g.connect(gainSfx);src.start(0);
    }catch{}
  }

  return{unlock,play};
})();

/* Registrar en los tres tipos de evento táctil/teclado */
['pointerdown','touchstart','keydown'].forEach(ev=>
  window.addEventListener(ev,()=>AudioSys.unlock(),{once:true,passive:true})
);

/* ══ REWARD STORAGE ══ */
const REWARD_KEY="ark_bowling_v1";
function lsGet(){try{const r=localStorage.getItem(REWARD_KEY);return r?JSON.parse(r):null;}catch{return null;}}
function lsSave(bonus,attempt){try{localStorage.setItem(REWARD_KEY,JSON.stringify({bonus,attempt,ts:Date.now()}));}catch{}}
let savedReward=lsGet(), gameLocked=!!savedReward;
const MAX_ATTEMPTS=3;
let attemptsUsed=0, knockedBeforeThrow=0, throwResolved=false, ballCaptured=false;
const CAPTURE_Z=-18.2, OOB_X=3.0, OOB_Y_HIGH=3.2, OOB_Y_LOW=-2.0;
/* ── Physics knock detection thresholds ──
   INCREASED to reduce false positives (pins that barely wobble don't count) */
const KNOCK_TILT=1.05;  // was 0.75 — much stricter
const KNOCK_Y=0.14;     // was 0.18 — only clearly fallen
const PIN_STAND_Y_EPS=0.003;

/* ══ PRIZES — 100% strike, 50% spare, 30% third attempt ══ */
function bonusByAttempt(n){return n===1?100:n===2?50:30;}

/* ══ REWARD MODAL ══ */
function ensureRewardModal(){
  if(document.getElementById("reward-modal"))return;
  const style=document.createElement("style");
  style.textContent=`
    #reward-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
      background:rgba(0,0,0,.65);backdrop-filter:blur(12px);z-index:999999;padding:18px;}
    #reward-modal .card{width:min(480px,92vw);border-radius:22px;
      background:linear-gradient(180deg,rgba(12,20,50,.95),rgba(5,10,24,.95));
      border:1px solid rgba(240,192,64,.40);
      box-shadow:0 0 60px rgba(34,211,238,.18),0 30px 80px rgba(0,0,0,.65);
      padding:28px 20px;text-align:center;color:#e8f4ff;
      font-family:Orbitron,sans-serif;}
    #reward-modal .title{font-size:22px;margin:0 0 10px;letter-spacing:.05em;
      background:linear-gradient(90deg,#22d3ee,#F0C040,#ff4fd8);
      -webkit-background-clip:text;background-clip:text;color:transparent;}
    #reward-modal .msg{font-size:15px;opacity:.90;margin:0 0 16px;line-height:1.45;
      font-family:Orbitron,sans-serif;letter-spacing:.03em;}
    #reward-modal .glow{height:2px;width:100%;margin:12px 0 18px;border-radius:99px;
      background:linear-gradient(90deg,transparent,#22d3ee,#F0C040,#ff4fd8,transparent);
      box-shadow:0 0 18px rgba(34,211,238,.35);}
    #reward-modal .btn{width:100%;border:none;cursor:pointer;padding:14px;border-radius:14px;
      font-weight:900;font-size:15px;letter-spacing:.12em;
      background:linear-gradient(90deg,#22d3ee,#F0C040);color:#050a18;
      box-shadow:0 8px 28px rgba(34,211,238,.28);}
    #reward-modal .btn:active{transform:translateY(1px);}
  `;
  document.head.appendChild(style);
  const modal=document.createElement("div");modal.id="reward-modal";
  modal.innerHTML=`<div class="card"><h3 class="title" id="reward-title"></h3>
    <p class="msg" id="reward-msg"></p><div class="glow"></div>
    <button class="btn" id="reward-btn">Aceptar</button></div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click",e=>{if(e.target===modal)hideRewardModal(false);});
  document.getElementById("reward-btn").addEventListener("click",()=>hideRewardModal(true));
}
let rewardOnClose=null;
function showRewardModal(title,msg,onClose,btnLabel="Aceptar"){
  ensureRewardModal();
  document.getElementById("reward-title").textContent=title;
  document.getElementById("reward-msg").textContent=msg;
  document.getElementById("reward-btn").textContent=btnLabel;
  rewardOnClose=onClose||null;
  document.getElementById("reward-modal").style.display="flex";
}
function hideRewardModal(callClose=false){
  const m=document.getElementById("reward-modal");if(!m)return;
  m.style.display="none";
  if(callClose&&typeof rewardOnClose==="function"){const cb=rewardOnClose;rewardOnClose=null;cb();}
  else rewardOnClose=null;
}

function shouldCaptureBall(){
  const p=ballBody.position;
  return p.z<CAPTURE_Z||Math.abs(p.x)>OOB_X||p.y>OOB_Y_HIGH||p.y<OOB_Y_LOW;
}
function captureBall(){
  if(ballCaptured)return;ballCaptured=true;
  ball.group.visible=false;
  ballBody.velocity.set(0,0,0);ballBody.angularVelocity.set(0,0,0);
  ballBody.collisionResponse=false;ballBody.position.set(0,-50,-30);
}
function finalizeKnockDetection(){
  for(const pin of pins){
    if(pin.isRemoved||pin.isKnocked)continue;
    const euler=new THREE.Euler().setFromQuaternion(pin.group.quaternion,"XYZ");
    const tilt=Math.abs(euler.x)+Math.abs(euler.z);
    if(tilt>KNOCK_TILT||pin.body.position.y<KNOCK_Y){pin.isKnocked=true;knockedSet.add(pin.id);}
  }
}
function retirePin(pin){if(pin.isRemoved)return;pin.isRemoved=true;pin.group.visible=false;if(pin.body.world)world.removeBody(pin.body);}
function retireKnockedPins(){finalizeKnockDetection();for(const pin of pins){if(pin.isKnocked&&!pin.isRemoved)retirePin(pin);}}
function setGameState(next){
  if(gameLocked)next="locked";
  gameState=next;refreshLaunchButton();
  if(elInstr)elInstr.style.display=gameState==="aiming"?"block":"none";
  if(elDirCtrl)elDirCtrl.style.pointerEvents=gameState==="locked"?"none":"auto";
}
function refreshLaunchButton(){
  elLaunch.classList.remove("btn-aiming","btn-charging","btn-disabled");
  if(gameState==="locked"){elLaunch.textContent="PREMIO OBTENIDO";elLaunch.classList.add("btn","btn-disabled");elLaunch.disabled=true;return;}
  if(gameState==="charging"){elLaunch.textContent="SOLTAR";elLaunch.classList.add("btn","btn-charging");elLaunch.disabled=false;}
  else if(gameState==="aiming"){elLaunch.textContent="LANZAR";elLaunch.classList.add("btn","btn-aiming");elLaunch.disabled=false;}
  else{elLaunch.textContent="ESPERA...";elLaunch.classList.add("btn","btn-disabled");elLaunch.disabled=true;}
}
function updateScoreUI(){/* no scoreboard in this version */}
function getPowerGradient(pct){
  if(pct<30)return["#22c55e","#34d399"];
  if(pct<70)return["#F0C040","#ffdd55"];
  return["#ef4444","#fb923c"];
}
function updatePowerUI(){
  elPowerFill.style.height=`${powerPct}%`;
  elPowerGlow.style.height=`${powerPct}%`;
  elPowerPct.textContent=`${Math.round(powerPct)}%`;
  const[a,b]=getPowerGradient(powerPct);
  elPowerFill.style.background=`linear-gradient(to top,${a},${b})`;
  elPowerGlow.style.boxShadow=`0 0 20px ${a}`;
}

/* ══ LOADING FAKE PROGRESS ══ */
let loadingProgress=0;
const loadingInterval=setInterval(()=>{
  loadingProgress=Math.min(100,loadingProgress+Math.random()*15);
  elLoadingFill.style.width=`${loadingProgress}%`;
  if(loadingProgress>=100){clearInterval(loadingInterval);
    setTimeout(()=>{elLoading.style.opacity="0";elLoading.style.transition="opacity 500ms ease";
      setTimeout(()=>elLoading.remove(),520);},350);}
},200);

/* ══ DIRECTION DRAG ══ */
let draggingDir=false;
function setDirectionFromClientX(clientX){
  if(gameLocked)return;
  const rect=elDirCtrl.getBoundingClientRect();
  const offset=(clientX-(rect.left+rect.width/2))/(rect.width/2);
  direction=clamp(offset,-1,1);
  elDirInd.style.left=`${50+direction*40}%`;
  if(gameState==="aiming")placeBallForAiming(direction);
}
elDirCtrl.addEventListener("pointerdown",e=>{if(gameLocked)return;AudioSys.unlock();draggingDir=true;elDirCtrl.setPointerCapture(e.pointerId);setDirectionFromClientX(e.clientX);});
elDirCtrl.addEventListener("pointermove",e=>{if(!draggingDir||gameLocked)return;setDirectionFromClientX(e.clientX);});
elDirCtrl.addEventListener("pointerup",()=>(draggingDir=false));
elDirCtrl.addEventListener("pointercancel",()=>(draggingDir=false));

/* ══ POWER CHARGE ══ */
function startCharge(){
  if(gameLocked||gameState!=="aiming")return;
  AudioSys.unlock();setGameState("charging");isCharging=true;powerPct=0;powerDir=1;
  updatePowerUI();elPowerGlow.classList.remove("hidden");
  if(powerTimer)clearInterval(powerTimer);
  powerTimer=setInterval(()=>{
    if(!isCharging||gameState!=="charging")return;
    let next=powerPct+powerDir*3;
    if(next>=100){next=100;powerDir=-1;}if(next<=0){next=0;powerDir=1;}
    powerPct=next;updatePowerUI();
  },25);
}
function releaseCharge(){
  if(gameLocked||gameState!=="charging")return;
  isCharging=false;elPowerGlow.classList.add("hidden");
  if(powerTimer){clearInterval(powerTimer);powerTimer=null;}
  power=clamp(powerPct/100,0,1);AudioSys.play("throw",{volume:0.95,rate:1});doThrow(power);
}
elLaunch.addEventListener("pointerdown",e=>{e.preventDefault();startCharge();});
elLaunch.addEventListener("pointerup",e=>{e.preventDefault();releaseCharge();});
elLaunch.addEventListener("pointerleave",()=>{if(isCharging)releaseCharge();});
elLaunch.addEventListener("pointercancel",()=>{if(isCharging)releaseCharge();});
window.addEventListener("keydown",e=>{
  if(gameLocked)return;
  if(e.key==="r"||e.key==="R"){e.preventDefault();resetGame();return;}
  if(gameState==="aiming"){
    if(e.key==="ArrowLeft")direction=clamp(direction-0.08,-1,1);
    if(e.key==="ArrowRight")direction=clamp(direction+0.08,-1,1);
    if(e.key==="ArrowLeft"||e.key==="ArrowRight"){elDirInd.style.left=`${50+direction*40}%`;placeBallForAiming(direction);}
    if(e.key===" "||e.key==="Enter"){e.preventDefault();startCharge();}
  }else if(gameState==="charging"&&(e.key===" "||e.key==="Enter")){e.preventDefault();releaseCharge();}
});

/* ══ THREE.JS RENDERER ══ */
const threeContainer=$("three-container");
const renderer=new THREE.WebGLRenderer({antialias:PERF.antialias,alpha:false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,PERF.dprCap));
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.shadowMap.enabled=PERF.shadows;
renderer.shadowMap.type=PERF.shadows?THREE.PCFSoftShadowMap:THREE.BasicShadowMap;
threeContainer.appendChild(renderer.domElement);
const scene=new THREE.Scene();
scene.fog=new THREE.FogExp2(0x050a18,PERF.fogDensity);
scene.background=new THREE.Color(0x050a18);
const camera=new THREE.PerspectiveCamera(55,window.innerWidth/window.innerHeight,0.1,200);
camera.position.set(0,4,10);
window.addEventListener("resize",()=>{
  camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,PERF.dprCap));
});
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=PERF.mobile?0.95:1.05;
renderer.setClearColor(0x050a18,1);

/* ══ LIGHTS — Arkana neon ══ */
const hemi=new THREE.HemisphereLight(0x1a3a6a,0x050a18,PERF.mobile?0.65:0.80);
scene.add(hemi);
const sun=new THREE.DirectionalLight(0x88aaff,PERF.mobile?0.9:1.1);
sun.position.set(-4,10,8);sun.castShadow=PERF.shadows;
sun.shadow.mapSize.set(PERF.shadowMapSize,PERF.shadowMapSize);
sun.shadow.camera.near=1;sun.shadow.camera.far=50;
sun.shadow.camera.left=-12;sun.shadow.camera.right=12;
sun.shadow.camera.top=12;sun.shadow.camera.bottom=-12;
scene.add(sun);
/* Ambient fill so nothing is pitch black */
const ambient=new THREE.AmbientLight(0x0a1830,PERF.mobile?0.5:0.65);
scene.add(ambient);
function neonPoint(x,y,z,color,intensity,dist){
  const i=PERF.mobile?intensity*0.7:intensity,d=PERF.mobile?dist*0.80:dist;
  const l=new THREE.PointLight(color,i,d);l.position.set(x,y,z);scene.add(l);return l;
}
neonPoint(-1.7,0.9,2,0x22d3ee,2.0,11);
neonPoint(1.7,0.9,2,0xff4fd8,1.8,11);
neonPoint(-1.6,0.6,-6,0x22d3ee,2.2,12);
neonPoint(1.6,0.6,-6,0xF0C040,2.0,12);
neonPoint(0.0,1.4,-14,0x22d3ee,1.6,14);
neonPoint(0.0,2.8,-18,0xF0C040,1.0,18);
neonPoint(0.0,1.0,8,0x4466aa,1.2,10);

/* ══ DARK SPACE SKY ══ */
function addArkanasky(){
  const geo=new THREE.SphereGeometry(120,PERF.skySeg,PERF.skySeg);
  const mat=new THREE.ShaderMaterial({
    side:THREE.BackSide,transparent:false,fog:false,
    uniforms:{
      topColor:{value:new THREE.Color(0x010308)},
      midColor:{value:new THREE.Color(0x050a18)},
      bottomColor:{value:new THREE.Color(0x08102a)},
    },
    vertexShader:`varying vec3 vWorld;void main(){vec4 wp=modelMatrix*vec4(position,1.0);vWorld=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}`,
    fragmentShader:`uniform vec3 topColor;uniform vec3 midColor;uniform vec3 bottomColor;varying vec3 vWorld;
      void main(){vec3 dir=normalize(vWorld);float t=clamp(dir.y*0.5+0.5,0.0,1.0);
        vec3 c=mix(bottomColor,midColor,smoothstep(0.0,0.5,t));c=mix(c,topColor,smoothstep(0.5,1.0,t));
        gl_FragColor=vec4(c,1.0);}`,
  });
  const dome=new THREE.Mesh(geo,mat);dome.renderOrder=-999;scene.add(dome);

  // Stars
  const starGeo=new THREE.BufferGeometry();
  const n=PERF.mobile?400:800;
  const pos=new Float32Array(n*3);
  for(let i=0;i<n;i++){
    const theta=Math.random()*Math.PI*2,phi=Math.acos(2*Math.random()-1);
    const r=80+Math.random()*30;
    pos[i*3]=r*Math.sin(phi)*Math.cos(theta);
    pos[i*3+1]=r*Math.cos(phi);
    pos[i*3+2]=r*Math.sin(phi)*Math.sin(theta);
  }
  starGeo.setAttribute("position",new THREE.BufferAttribute(pos,3));
  const starMat=new THREE.PointsMaterial({color:0xaaddff,size:0.35,sizeAttenuation:true,transparent:true,opacity:0.7});
  scene.add(new THREE.Points(starGeo,starMat));
}
addArkanasky();

/* ══ PHYSICS WORLD ══ */
const world=new CANNON.World({gravity:new CANNON.Vec3(0,-9.81,0)});
world.allowSleep=true;world.broadphase=new CANNON.SAPBroadphase(world);
world.solver.iterations=PERF.solverIterations;world.solver.tolerance=PERF.solverTolerance;
world.sleepSpeedLimit=PERF.mobile?0.15:0.1;world.sleepTimeLimit=PERF.mobile?0.7:0.45;
const floorMat=new CANNON.Material("floor"),ballMat=new CANNON.Material("ball"),pinMat=new CANNON.Material("pin");
world.defaultContactMaterial=new CANNON.ContactMaterial(floorMat,floorMat,{restitution:0.05,friction:0.75});
world.addContactMaterial(new CANNON.ContactMaterial(ballMat,floorMat,{restitution:0.03,friction:0.18}));
world.addContactMaterial(new CANNON.ContactMaterial(pinMat,floorMat,{restitution:0.04,friction:0.60}));
world.addContactMaterial(new CANNON.ContactMaterial(ballMat,pinMat,{restitution:0.08,friction:0.30}));
world.addContactMaterial(new CANNON.ContactMaterial(pinMat,pinMat,{restitution:0.08,friction:0.55}));
const floorBody=new CANNON.Body({mass:0,material:floorMat});
floorBody.addShape(new CANNON.Plane());floorBody.quaternion.setFromEuler(-Math.PI/2,0,0);world.addBody(floorBody);
function addStaticWall(x,y,z,sx,sy,sz){
  const body=new CANNON.Body({mass:0,material:floorMat});body.position.set(x,y,z);
  body.addShape(new CANNON.Box(new CANNON.Vec3(sx,sy,sz)));world.addBody(body);
}
addStaticWall(-1.15,0.25,-5,0.05,0.6,32);addStaticWall(1.15,0.25,-5,0.05,0.6,32);addStaticWall(0,0.6,-19.5,3,1.2,0.2);

/* ══ LANE BUILD ══ */
const laneGroup=new THREE.Group();scene.add(laneGroup);
const torches=[];
buildLane(laneGroup);buildSideNeonRails(laneGroup);buildBackArch(laneGroup);buildLaneDecor(laneGroup);

/* ══ PIN SETUP ══ */
const PIN_HEIGHT=0.82,PIN_Y=PIN_HEIGHT/2,PIN_R_BOTTOM=0.11,PIN_R_TOP=0.06;
const PIN_POSITIONS=[[0,PIN_Y,-15],[-0.23,PIN_Y,-15.42],[0.23,PIN_Y,-15.42],[-0.46,PIN_Y,-15.84],[0,PIN_Y,-15.84],[0.46,PIN_Y,-15.84],[-0.69,PIN_Y,-16.26],[-0.23,PIN_Y,-16.26],[0.23,PIN_Y,-16.26],[0.69,PIN_Y,-16.26]];

const ball=createArkanaball();scene.add(ball.group);
const ballBody=new CANNON.Body({mass:6,material:ballMat,linearDamping:0.25,angularDamping:0.35});
ballBody.addShape(new CANNON.Sphere(0.25));ballBody.position.set(0,0.25,7);
ballBody.allowSleep=true;ballBody.sleepSpeedLimit=PERF.mobile?0.16:0.1;ballBody.sleepTimeLimit=PERF.mobile?0.7:0.4;
world.addBody(ballBody);
let ballHasThrown=false;
const aimIndicator=createAimIndicator();scene.add(aimIndicator);
const pins=[],pinByBodyId=new Map();
for(let i=0;i<PIN_POSITIONS.length;i++){const p=createPin(i,PIN_POSITIONS[i]);pins.push(p);scene.add(p.group);world.addBody(p.body);pinByBodyId.set(p.body.id,p);}
let knockedSet=new Set();

/* ══ BALL COLLISION — reduced cascade ══ */
let lastShockMs=0,lastHitSfxMs=0;
ballBody.addEventListener("collide",e=>{
  const pin=pinByBodyId.get(e.body?.id);if(!pin||pin.isRemoved)return;
  const now=performance.now();if(pin._lastShock&&now-pin._lastShock<120)return;
  pin._lastShock=now;
  let impact=0;
  try{if(e.contact&&typeof e.contact.getImpactVelocityAlongNormal==="function")impact=Math.abs(e.contact.getImpactVelocityAlongNormal());}catch{}
  if(!impact){const v=ballBody.velocity;impact=Math.hypot(v.x,v.y,v.z);}
  if(now-lastHitSfxMs>55){lastHitSfxMs=now;AudioSys.play("hit",{volume:clamp(impact/10,0.12,0.85),rate:clamp(0.95+(Math.random()-0.5)*0.12,0.85,1.1)});}
  applyBackShock(pin);
});

function applyBackShock(primaryPin){
  const now=performance.now();if(now-lastShockMs<70)return;lastShockMs=now;
  const v=ballBody.velocity;const speed=Math.hypot(v.x,v.y,v.z);if(speed<2.5)return;
  const centerFactor=1-clamp(Math.abs(ballBody.position.x)/0.95,0,1);
  /* REDUCED magnitude & radius to prevent all-pins-fall on miss */
  const baseMag=(1.5+speed*0.18)*(0.80+power*0.45)*(0.70+centerFactor*0.50);
  const dx=clamp(primaryPin.body.position.x-ballBody.position.x,-0.55,0.55);
  const dirMain=new CANNON.Vec3(dx*0.55,0.09,-1.0);dirMain.normalize();
  primaryPin.body.wakeUp();primaryPin.body.applyImpulse(dirMain.scale(baseMag),primaryPin.body.position);
  /* REDUCED cascade radius: 0.55 instead of 0.95 */
  const radius=0.55+centerFactor*0.20;
  for(const pin of pins){
    if(pin===primaryPin||pin.isRemoved)continue;
    const dxn=pin.body.position.x-primaryPin.body.position.x;
    const dzn=pin.body.position.z-primaryPin.body.position.z;
    const dist=Math.hypot(dxn,dzn);if(dist>radius)continue;
    const t=1-dist/radius;const mag=baseMag*(0.40*t);
    const dir=new CANNON.Vec3(clamp(dxn*0.22,-0.25,0.25),0.06,-1.0);dir.normalize();
    pin.body.wakeUp();pin.body.applyImpulse(dir.scale(mag),pin.body.position);
  }
}

function clampPinsMotion(){
  for(const pin of pins){
    if(pin.isRemoved)continue;
    const v=pin.body.velocity,w=pin.body.angularVelocity;
    if(v.z>1.6)v.z=1.6;
    v.x=clamp(v.x,-6,6);v.y=clamp(v.y,-4,6);v.z=clamp(v.z,-22,2);
    w.x=clamp(w.x,-22,22);w.y=clamp(w.y,-22,22);w.z=clamp(w.z,-22,22);
  }
}

function plantPinsStanding(){
  for(const pin of pins){
    if(pin.isRemoved)continue;pin.isKnocked=false;
    const[x,y,z]=pin.initialPos;
    pin.body.position.set(x,y+PIN_STAND_Y_EPS,z);pin.body.velocity.set(0,0,0);
    pin.body.angularVelocity.set(0,0,0);pin.body.quaternion.set(0,0,0,1);pin.body.sleep();
  }
}

function doThrow(pwr01){
  if(gameLocked||ballHasThrown||attemptsUsed>=MAX_ATTEMPTS)return;
  if(gameState!=="charging"&&gameState!=="aiming")return;
  power=pwr01;setGameState("throwing");
  knockedBeforeThrow=knockedSet.size;throwResolved=false;ballCaptured=false;
  ball.group.visible=true;ballBody.collisionResponse=true;
  pinsDownLastThrow=0;ballHasThrown=true;throwStartMs=performance.now();
  if(typeof ballBody.wakeUp==="function")ballBody.wakeUp();
  for(const p of pins){if(!p.isRemoved&&typeof p.body.wakeUp==="function")p.body.wakeUp();}
  const throwPower=18+power*12,directionRad=direction*0.35;
  ballBody.velocity.set(Math.sin(directionRad)*throwPower*0.25,0,-throwPower);
  ballBody.angularVelocity.set(-throwPower*3,Math.sin(directionRad)*5,0);
}

function lockGameWithReward(bonus,attempt){
  gameLocked=true;lsSave(bonus,attempt);savedReward=lsGet();setGameState("locked");
}

function onThrowComplete(){
  if(gameState!=="throwing")return;setGameState("waiting");
  setTimeout(()=>{
    if(throwResolved)return;throwResolved=true;
    finalizeKnockDetection();
    const totalKnocked=knockedSet.size;
    const knockedThisThrow=Math.max(0,totalKnocked-knockedBeforeThrow);
    if(knockedThisThrow>0){score+=knockedThisThrow*10;updateScoreUI();}
    const attemptNumber=attemptsUsed+1;

    if(totalKnocked>=10){
      const bonus=bonusByAttempt(attemptNumber);
      if(attemptNumber===1){showStrike();AudioSys.play("reward",{volume:1,rate:1});}
      else{showSpare();AudioSys.play("reward",{volume:0.9,rate:1});}
      lockGameWithReward(bonus,attemptNumber);
      const labels={100:"¡Derribaste todos en el primer tiro!",50:"¡Derribaste todos!",30:"¡Lo lograste!"};
      showRewardModal("¡Felicitaciones! 🎉",`Ganaste un ${bonus}% de bonificación. ${labels[bonus]||""}`,null,"Aceptar");
      return;
    }

    attemptsUsed++;throwsInFrame=attemptsUsed;updateScoreUI();
    retireKnockedPins();

    if(attemptsUsed>=MAX_ATTEMPTS){
      setGameState("resetting");
      showRewardModal("¡Se acabaron los intentos!","No lograste derribar todos los pinos. ¡Intentá de nuevo!",()=>resetGame(),"Jugar de nuevo");
      return;
    }
    setGameState("aiming");resetBall(false);placeBallForAiming(direction);
  },1500);
}

function showStrike(){if(!elStrike)return;elStrike.classList.remove("hidden");setTimeout(()=>elStrike.classList.add("hidden"),2800);}
function showSpare(){if(!elSpare)return;elSpare.classList.remove("hidden");setTimeout(()=>elSpare.classList.add("hidden"),2800);}

function resetGame(){
  if(gameLocked)return;
  score=0;frame=1;throwsInFrame=0;pinsDownLastThrow=0;totalPinsThisFrame=0;
  attemptsUsed=0;knockedBeforeThrow=0;throwResolved=false;ballCaptured=false;
  knockedSet=new Set();setGameState("resetting");updateScoreUI();
  setTimeout(()=>{resetPins();resetBall(true);setGameState("aiming");updateScoreUI();},600);
}
function resetBall(hard=true){
  ballHasThrown=false;ball.group.visible=true;ballBody.collisionResponse=true;
  ballBody.velocity.set(0,0,0);ballBody.angularVelocity.set(0,0,0);ballBody.quaternion.set(0,0,0,1);
  if(hard){ballBody.position.set(0,0.25,7);direction=0;if(elDirInd)elDirInd.style.left="50%";}
}
function placeBallForAiming(dir){
  if(gameLocked||gameState!=="aiming")return;
  ball.group.visible=true;ballBody.collisionResponse=true;
  ballBody.position.set(dir*0.8,0.25,7);ballBody.velocity.set(0,0,0);
  ballBody.angularVelocity.set(0,0,0);ballBody.quaternion.set(0,0,0,1);
}
function resetPins(){
  for(const pin of pins){
    pin.isKnocked=false;pin.isRemoved=false;pin.group.visible=true;
    if(!pin.body.world)world.addBody(pin.body);
    const[x,y,z]=pin.initialPos;
    pin.body.position.set(x,y+PIN_STAND_Y_EPS,z);pin.body.velocity.set(0,0,0);
    pin.body.angularVelocity.set(0,0,0);pin.body.quaternion.set(0,0,0,1);pin.body.sleep();
  }
}

/* ══ RENDER LOOP ══ */
let lastT=performance.now(),acc=0,lastRenderMs=0;
const minFrameMs=1000/PERF.targetFps;
refreshLaunchButton();updateScoreUI();updatePowerUI();placeBallForAiming(direction);plantPinsStanding();

if(gameLocked&&savedReward){
  setGameState("locked");
  setTimeout(()=>showRewardModal("Premio ya obtenido ✅",`Tu premio fue: ${savedReward.bonus}% de bonificación.`,null,"Aceptar"),950);
}

function animate(t){
  requestAnimationFrame(animate);
  if(PERF.mobile){if(t-lastRenderMs<minFrameMs)return;lastRenderMs=t;}
  const dt=Math.min(PERF.clampAccMax,(t-lastT)/1000);lastT=t;acc+=dt;
  let sub=0;
  while(acc>=PERF.fixedDt&&sub<PERF.maxSubsteps){world.step(PERF.fixedDt);clampPinsMotion();acc-=PERF.fixedDt;sub++;}
  acc=Math.min(acc,PERF.fixedDt);
  if(gameState==="throwing"&&ballHasThrown&&!ballCaptured&&shouldCaptureBall()){captureBall();onThrowComplete();}
  ball.group.position.copy(ballBody.position);ball.group.quaternion.copy(ballBody.quaternion);ball.update(t/1000);
  for(const pin of pins){
    if(pin.isRemoved)continue;
    pin.group.position.copy(pin.body.position);pin.group.quaternion.copy(pin.body.quaternion);
    if(!pin.isKnocked){
      const euler=new THREE.Euler().setFromQuaternion(pin.group.quaternion,"XYZ");
      if(Math.abs(euler.x)+Math.abs(euler.z)>KNOCK_TILT||pin.body.position.y<KNOCK_Y){pin.isKnocked=true;knockedSet.add(pin.id);}
    }
  }
  aimIndicator.visible=gameState==="aiming"&&!gameLocked;
  if(aimIndicator.visible)aimIndicator.position.set(direction*0.8,0.03,6);
  updateTorches(t/1000);
  if(gameState==="throwing"&&ballHasThrown&&!ballCaptured){
    const elapsed=(t-throwStartMs)/1000;
    const v=ballBody.velocity;const speed=Math.hypot(v.x,v.y,v.z);
    if(elapsed>0.25&&ballBody.position.z<6.6&&(speed<0.35||ballBody.position.z<-20))onThrowComplete();
  }
  renderer.render(scene,camera);
}
requestAnimationFrame(animate);

/* ══════════════════════════════
   SCENE BUILDERS
══════════════════════════════ */
function buildLane(parent){
  /* Dark lane with neon tint */
  const laneMat=new THREE.MeshStandardMaterial({color:0x0d1a2e,roughness:0.45,metalness:0.10});
  const lane=new THREE.Mesh(new THREE.PlaneGeometry(2,28),laneMat);
  lane.rotation.x=-Math.PI/2;lane.position.set(0,0.01,-5);lane.receiveShadow=PERF.shadows;parent.add(lane);
  /* Lane lines — subtle cyan */
  const lineMat=new THREE.MeshStandardMaterial({color:0x22d3ee,transparent:true,opacity:0.12});
  for(let i=0;i<15;i++){const x=-0.9+i*0.13;const m=new THREE.Mesh(new THREE.PlaneGeometry(0.01,28),lineMat);m.rotation.x=-Math.PI/2;m.position.set(x,0.015,-5);parent.add(m);}
  /* Arrow dots — gold */
  const dotMat=new THREE.MeshStandardMaterial({color:0xF0C040,emissive:0xF0C040,emissiveIntensity:0.5});
  [-0.4,-0.2,0,0.2,0.4].forEach(x=>{const d=new THREE.Mesh(new THREE.CircleGeometry(0.03,PERF.mobile?10:16),dotMat);d.rotation.x=-Math.PI/2;d.position.set(x,0.02,5);parent.add(d);});
  const foul=new THREE.Mesh(new THREE.PlaneGeometry(2,0.03),new THREE.MeshStandardMaterial({color:0xff2d5f,emissive:0xff2d5f,emissiveIntensity:0.6}));
  foul.rotation.x=-Math.PI/2;foul.position.set(0,0.02,3);parent.add(foul);
  /* Gutters */
  const gutterMat=new THREE.MeshStandardMaterial({color:0x060c1a,roughness:0.9});
  const edgeMat=new THREE.MeshStandardMaterial({color:0x111122});
  [-1.15,1.15].forEach((x,i)=>{
    const g=new THREE.Mesh(new THREE.PlaneGeometry(0.3,28),gutterMat);g.rotation.x=-Math.PI/2;g.position.set(x,-0.08,-5);g.receiveShadow=PERF.shadows;parent.add(g);
    const edge=new THREE.Mesh(new THREE.BoxGeometry(0.02,0.1,28),edgeMat);edge.position.set(x+(i===0?0.15:-0.15),0,-5);parent.add(edge);
  });
  /* Pin deck */
  const deck=new THREE.Mesh(new THREE.PlaneGeometry(2.2,3.5),new THREE.MeshStandardMaterial({color:0x0a1428,roughness:0.4,metalness:0.08}));
  deck.rotation.x=-Math.PI/2;deck.position.set(0,0.015,-15.75);deck.receiveShadow=PERF.shadows;parent.add(deck);
  /* Side walls */
  const wallMat=new THREE.MeshStandardMaterial({color:0x050a18});
  [-2.5,2.5].forEach(x=>{const w=new THREE.Mesh(new THREE.BoxGeometry(0.5,3,30),wallMat);w.position.set(x,1.5,-5);parent.add(w);});
}

function buildSideNeonRails(parent){
  [-1.35,1.35].forEach((x,i)=>{
    const rail=new THREE.Group();
    const main=new THREE.Mesh(new THREE.BoxGeometry(0.15,1,28),new THREE.MeshStandardMaterial({color:0x080c18,metalness:0.85,roughness:0.15}));
    main.position.set(x,0.5,-5);main.castShadow=PERF.shadows;rail.add(main);
    const col=i===0?0x22d3ee:0xff4fd8;
    const strip=new THREE.Mesh(new THREE.BoxGeometry(0.03,0.6,27),new THREE.MeshStandardMaterial({color:0x030810,emissive:col,emissiveIntensity:PERF.mobile?1.8:2.6,roughness:0.25,metalness:0.2}));
    strip.position.set(x+(i===0?0.07:-0.07),0.3,-5);rail.add(strip);
    parent.add(rail);
  });
}

function buildBackArch(parent){
  const group=new THREE.Group();group.position.set(0,0,-18);
  const mat=new THREE.MeshStandardMaterial({color:0x080c18,metalness:0.9,roughness:0.1});
  [-1.5,1.5].forEach(x=>{const p=new THREE.Mesh(new THREE.BoxGeometry(0.25,3,0.25),mat);p.position.set(x,1.5,0);p.castShadow=PERF.shadows;group.add(p);});
  const top=new THREE.Mesh(new THREE.BoxGeometry(3.25,0.2,0.25),mat);top.position.set(0,3,0);top.castShadow=PERF.shadows;group.add(top);
  /* Neon arch lines */
  const addNeon=(w,h,d,x,y,z,col)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial({color:col}));m.position.set(x,y,z);group.add(m);};
  addNeon(3.3,0.04,0.02,0,3.08,0.15,0x22d3ee);
  addNeon(0.04,3.1,0.02,-1.5,1.5,0.15,0x22d3ee);
  addNeon(0.04,3.1,0.02,1.5,1.5,0.15,0xff4fd8);
  const wall=new THREE.Mesh(new THREE.BoxGeometry(4,3.5,0.1),new THREE.MeshStandardMaterial({color:0x040810}));
  wall.position.set(0,1.5,-0.3);wall.receiveShadow=PERF.shadows;group.add(wall);
  parent.add(group);
}

function buildLaneDecor(parent){
  /* ── Neon grid floor extending to sides (MeshBasicMaterial = free on mobile) ── */
  addNeonGridFloor(parent);
  /* ── Casino chips & cards as FLAT sprites on the floor ── */
  addFlatCasinoProps(parent);
  /* ── Dark city silhouette in background ── */
  addCitySilhouette(parent);
  /* ── Neon pillars flanking the lane ── */
  addNeonPillars(parent);
  /* ── Torches ── */
  const t1=makeTorch([-2.8,0,8]),t2=makeTorch([2.8,0,8]);
  parent.add(t1.group);parent.add(t2.group);torches.push(t1,t2);
}

/* Neon grid floor — single PlaneGeometry with canvas texture, very cheap */
function addNeonGridFloor(parent){
  const size=PERF.mobile?256:512;
  const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#030710';ctx.fillRect(0,0,size,size);
  const step=size/12;
  ctx.strokeStyle='rgba(34,211,238,0.18)';ctx.lineWidth=1;
  for(let i=0;i<=12;i++){
    ctx.beginPath();ctx.moveTo(i*step,0);ctx.lineTo(i*step,size);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i*step);ctx.lineTo(size,i*step);ctx.stroke();
  }
  /* Brighter center cross */
  ctx.strokeStyle='rgba(34,211,238,0.35)';ctx.lineWidth=2;
  ctx.beginPath();ctx.moveTo(size/2,0);ctx.lineTo(size/2,size);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,size/2);ctx.lineTo(size,size/2);ctx.stroke();
  const tex=new THREE.CanvasTexture(canvas);
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.repeat.set(4,8);
  const mat=new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:0.7});
  [-4.5,4.5].forEach(x=>{
    const fl=new THREE.Mesh(new THREE.PlaneGeometry(6,30),mat);
    fl.rotation.x=-Math.PI/2;fl.position.set(x,-0.05,-4);parent.add(fl);
  });
}

/* Flat casino props — PlaneGeometry sprites, near-zero cost */
function addFlatCasinoProps(parent){
  const chipColors=[0x22d3ee,0xff4fd8,0xF0C040,0x22c55e,0xff4444,0x9966ff];
  const baseMat=new THREE.MeshBasicMaterial({transparent:true,opacity:0.85,side:THREE.DoubleSide});

  /* Chip canvas */
  function makeChipTex(color){
    const c=document.createElement('canvas');c.width=64;c.height=64;
    const ctx=c.getContext('2d');
    const r=28,cx=32,cy=32;
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fillStyle='#'+(color).toString(16).padStart(6,'0');ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.5)';ctx.lineWidth=3;ctx.stroke();
    /* Inner ring */
    ctx.beginPath();ctx.arc(cx,cy,r-6,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=2;ctx.stroke();
    /* Notches */
    for(let i=0;i<8;i++){
      const a=i/8*Math.PI*2;
      ctx.fillStyle='rgba(255,255,255,0.3)';ctx.beginPath();
      ctx.arc(cx+Math.cos(a)*(r-3),cy+Math.sin(a)*(r-3),4,0,Math.PI*2);ctx.fill();
    }
    const tex=new THREE.CanvasTexture(c);return tex;
  }

  /* Card canvas */
  function makeCardTex(suit){
    const c=document.createElement('canvas');c.width=48;c.height=64;
    const ctx=c.getContext('2d');
    ctx.fillStyle='rgba(240,235,220,0.92)';
    ctx.beginPath();ctx.roundRect(2,2,44,60,6);ctx.fill();
    ctx.fillStyle=suit==='♥'||suit==='♦'?'#cc2222':'#111';
    ctx.font='bold 28px serif';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(suit,24,32);
    const tex=new THREE.CanvasTexture(c);return tex;
  }

  const suits=['♠','♥','♦','♣'];
  const propCount=PERF.mobile?18:28;

  for(let i=0;i<propCount;i++){
    const isCard=Math.random()<0.35;
    let tex,w,h;
    if(isCard){
      tex=makeCardTex(suits[Math.floor(Math.random()*suits.length)]);w=0.28;h=0.38;
    } else {
      tex=makeChipTex(chipColors[Math.floor(Math.random()*chipColors.length)]);w=0.25;h=0.25;
    }
    const m=baseMat.clone();m.map=tex;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);
    /* Scatter only on the sides, not on the lane */
    const side=Math.random()<0.5?-1:1;
    const xOff=side*(1.5+Math.random()*2.5);
    mesh.rotation.x=-Math.PI/2;
    mesh.rotation.z=Math.random()*Math.PI*2;
    mesh.position.set(xOff,0.01,-2+Math.random()*-16);
    parent.add(mesh);
  }
}

/* City silhouette — flat dark BoxGeometries behind the pins, near-zero cost */
function addCitySilhouette(parent){
  const mat=new THREE.MeshBasicMaterial({color:0x040810});
  const baseZ=-52;
  for(let i=0;i<22;i++){
    const w=0.8+Math.random()*2.0;
    const h=1.2+Math.random()*6.0;
    const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,0.5),mat);
    b.position.set(-9+i*0.9+(Math.random()-0.5)*0.4,h*0.5-0.2,baseZ);
    parent.add(b);
  }
  /* Neon window dots on buildings — simple points */
  const winGeo=new THREE.BufferGeometry();
  const winN=PERF.mobile?60:120;
  const wPos=new Float32Array(winN*3);
  for(let i=0;i<winN;i++){
    wPos[i*3]=(-9+Math.random()*18);
    wPos[i*3+1]=0.3+Math.random()*5;
    wPos[i*3+2]=baseZ+0.4;
  }
  winGeo.setAttribute('position',new THREE.BufferAttribute(wPos,3));
  const winMat=new THREE.PointsMaterial({color:0x22d3ee,size:PERF.mobile?0.12:0.10,sizeAttenuation:true,transparent:true,opacity:0.7});
  parent.add(new THREE.Points(winGeo,winMat));
  /* Magenta windows */
  const winGeo2=new THREE.BufferGeometry();
  const wPos2=new Float32Array(winN*3);
  for(let i=0;i<winN;i++){wPos2[i*3]=(-9+Math.random()*18);wPos2[i*3+1]=0.3+Math.random()*5;wPos2[i*3+2]=baseZ+0.4;}
  winGeo2.setAttribute('position',new THREE.BufferAttribute(wPos2,3));
  const winMat2=new THREE.PointsMaterial({color:0xff4fd8,size:PERF.mobile?0.10:0.08,sizeAttenuation:true,transparent:true,opacity:0.5});
  parent.add(new THREE.Points(winGeo2,winMat2));
}

/* Neon pillars flanking the lane — simple boxes with emissive strip */
function addNeonPillars(parent){
  const darkMat=new THREE.MeshBasicMaterial({color:0x080c1a});
  [[- 2.4,0xF0C040],[2.4,0x22d3ee]].forEach(([x,col])=>{
    [-8,-3,2].forEach(z=>{
      const pole=new THREE.Mesh(new THREE.BoxGeometry(0.12,2.2,0.12),darkMat);
      pole.position.set(x,1.1,z);parent.add(pole);
      /* Emissive neon strip */
      const strip=new THREE.Mesh(new THREE.BoxGeometry(0.04,2.0,0.04),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.85}));
      strip.position.set(x+(x<0?0.05:-0.05),1.1,z);parent.add(strip);
      /* Small point light only on desktop */
      if(!PERF.mobile){const pl=new THREE.PointLight(col,0.5,3);pl.position.set(x,1.5,z);scene.add(pl);}
    });
  });
}

function makeTorch(pos){
  const group=new THREE.Group();group.position.set(...pos);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.05,1.4,PERF.mobile?6:8),new THREE.MeshStandardMaterial({color:0x1a1a2e,roughness:0.8,metalness:0.4}));
  pole.position.set(0,0.7,0);pole.castShadow=PERF.shadows;group.add(pole);
  const basket=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.06,0.12,PERF.mobile?6:8),new THREE.MeshStandardMaterial({color:0x0a0a1a,roughness:0.9}));
  basket.position.set(0,1.45,0);group.add(basket);
  const flame=new THREE.Mesh(new THREE.ConeGeometry(0.06,0.2,PERF.mobile?6:8),new THREE.MeshBasicMaterial({color:0x22d3ee,transparent:true,opacity:0.9}));
  flame.position.set(0,1.6,0);group.add(flame);
  const inner=new THREE.Mesh(new THREE.ConeGeometry(0.03,0.12,PERF.mobile?6:8),new THREE.MeshBasicMaterial({color:0xffffff}));
  inner.position.set(0,1.58,0);group.add(inner);
  const light=new THREE.PointLight(0x22d3ee,PERF.mobile?1.0:1.5,PERF.mobile?3:4.5);
  light.position.set(0,1.6,0);group.add(light);
  return{group,flame,light};
}

function updateTorches(time){
  for(const t of torches){
    const flicker=Math.sin(time*10)*0.1+Math.sin(time*15)*0.05;
    t.flame.scale.y=1+flicker;t.light.intensity=(PERF.mobile?1.0:1.5)+flicker*2;
  }
}

/* ══ BALL — Arkana Neon ══ */
function createArkanaball(){
  const group=new THREE.Group();
  const main=new THREE.Mesh(new THREE.SphereGeometry(0.25,PERF.ballSeg,PERF.ballSeg),new THREE.MeshStandardMaterial({color:0x0a1a55,metalness:0.92,roughness:0.08,envMapIntensity:1}));
  main.castShadow=PERF.shadows;group.add(main);
  const glow=new THREE.Mesh(new THREE.SphereGeometry(0.25,PERF.ballGlowSeg,PERF.ballGlowSeg),new THREE.MeshBasicMaterial({color:0x22d3ee,transparent:true,opacity:PERF.mobile?0.30:0.45,blending:THREE.AdditiveBlending}));
  glow.scale.setScalar(1.1);group.add(glow);
  const inner=new THREE.Mesh(new THREE.SphereGeometry(0.25,PERF.ballGlowSeg,PERF.ballGlowSeg),new THREE.MeshBasicMaterial({color:0x0088ff,transparent:true,opacity:PERF.mobile?0.5:0.65,blending:THREE.AdditiveBlending}));
  inner.scale.setScalar(1.05);group.add(inner);
  const rings=[];
  for(let i=0;i<(PERF.mobile?4:6);i++){
    const r=new THREE.Mesh(new THREE.TorusGeometry(0.25,0.008,8,PERF.mobile?18:32,Math.PI*0.6),new THREE.MeshBasicMaterial({color:i%2===0?0x22d3ee:0xF0C040,transparent:true,opacity:PERF.mobile?0.65:0.80,blending:THREE.AdditiveBlending}));
    r.rotation.set(Math.random()*Math.PI,Math.random()*Math.PI,0);rings.push(r);group.add(r);
  }
  const pl=new THREE.PointLight(0x22d3ee,PERF.mobile?1.2:2,PERF.mobile?2.2:3);group.add(pl);
  function update(time){
    const pulse=Math.sin(time*8)*0.2+0.8;glow.scale.setScalar(1+pulse*0.15);
    rings.forEach((r,i)=>r.rotation.z+=(PERF.mobile?0.007:0.01)+i*0.0007);
  }
  return{group,update};
}

/* ══ PIN — white with neon rings ══ */
function createPin(id,pos){
  const group=new THREE.Group();
  const whiteMat=PERF.mobile?new THREE.MeshStandardMaterial({color:0xf5f8ff,roughness:0.28,metalness:0.0}):new THREE.MeshPhysicalMaterial({color:0xf5f8ff,roughness:0.22,metalness:0.0,clearcoat:0.9,clearcoatRoughness:0.12});
  const ringMat=new THREE.MeshStandardMaterial({color:0x22d3ee,emissive:0x22d3ee,emissiveIntensity:0.6,roughness:0.25,metalness:0.2});
  const h=PIN_HEIGHT,y0=-h/2;
  const profile=[new THREE.Vector2(0.06,y0),new THREE.Vector2(0.11,y0+0.05*h),new THREE.Vector2(0.115,y0+0.12*h),new THREE.Vector2(0.102,y0+0.28*h),new THREE.Vector2(0.078,y0+0.45*h),new THREE.Vector2(0.095,y0+0.62*h),new THREE.Vector2(0.09,y0+0.72*h),new THREE.Vector2(0.07,y0+0.82*h),new THREE.Vector2(0.06,y0+0.9*h),new THREE.Vector2(0.065,y0+0.96*h),new THREE.Vector2(0.05,y0+h)];
  const geo=new THREE.LatheGeometry(profile,PERF.pinLatheSeg);geo.computeVertexNormals();
  const pinMesh=new THREE.Mesh(geo,whiteMat);pinMesh.castShadow=PERF.shadows;group.add(pinMesh);
  const rR=0.085,rT=0.0075;
  [0.7,0.75].forEach((f,i)=>{
    const ring=new THREE.Mesh(new THREE.TorusGeometry(rR*(i===0?1:0.97),rT,10,PERF.pinRingSeg),ringMat);
    ring.rotation.x=Math.PI/2;ring.position.y=y0+f*h;ring.castShadow=PERF.shadows;group.add(ring);
  });
  const pinBody=new CANNON.Body({mass:1.6,material:pinMat,linearDamping:PERF.mobile?0.55:0.45,angularDamping:PERF.mobile?0.58:0.50,position:new CANNON.Vec3(pos[0],pos[1]+PIN_STAND_Y_EPS,pos[2])});
  pinBody.allowSleep=true;pinBody.sleepSpeedLimit=PERF.mobile?0.16:0.12;pinBody.sleepTimeLimit=PERF.mobile?0.75:0.45;
  const shape=new CANNON.Cylinder(PIN_R_TOP,PIN_R_BOTTOM,PIN_HEIGHT,PERF.mobile?10:14);
  const q=new CANNON.Quaternion();q.setFromEuler(Math.PI/2,0,0);
  pinBody.addShape(shape,new CANNON.Vec3(0,0,0),q);pinBody.sleep();
  return{id,group,body:pinBody,initialPos:[pos[0],pos[1],pos[2]],isKnocked:false,isRemoved:false,_lastShock:0};
}

/* ══ AIM INDICATOR ══ */
function createAimIndicator(){
  const g=new THREE.Group();
  const ring=new THREE.Mesh(new THREE.RingGeometry(0.15,0.2,PERF.mobile?18:32),new THREE.MeshBasicMaterial({color:0x22d3ee,transparent:true,opacity:0.85,side:THREE.DoubleSide}));
  ring.rotation.x=-Math.PI/2;g.add(ring);
  const arrow=new THREE.Mesh(new THREE.ConeGeometry(0.1,0.3,3),new THREE.MeshBasicMaterial({color:0x22d3ee,transparent:true,opacity:0.65}));
  arrow.position.set(0,0.01,-0.4);arrow.rotation.x=-Math.PI/2;g.add(arrow);
  return g;
}
