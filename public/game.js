import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════
const lerp = (a,b,t) => a+(b-a)*t;
const rand = (a,b) => Math.random()*(b-a)+a;
const randInt = (a,b) => Math.floor(rand(a,b+1));
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window.innerWidth<=768 && 'ontouchstart' in window);

// ═══════════════════════════════════════
// NETWORK
// ═══════════════════════════════════════
// Connect to the server that served this page, or localhost:3000 for dev
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? window.location.origin
  : window.location.origin; // Same origin — adjust if server is elsewhere

let socket;
let connectionFailed = false;
try {
  socket = io(SERVER_URL, {
    timeout: 5000,
    reconnectionAttempts: 3,
    transports: ['websocket', 'polling']
  });
  socket.on('connect_error', () => {
    if (!connectionFailed) {
      connectionFailed = true;
      const info = document.querySelector('#join-screen .info');
      if (info) {
        info.innerHTML = '⚠️ Serveur non disponible.<br>Lance <code style="background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px">npm start</code> en local pour jouer.';
        info.style.color = '#FFB347';
        info.style.opacity = '1';
      }
    }
  });
} catch(e) {
  connectionFailed = true;
}

let myPlayerId = null;
let myPlayer = null;
let serverBuildings = {}; // from server join payload

// ═══════════════════════════════════════
// LOCAL GAME STATE
// ═══════════════════════════════════════
const R = { wood:0, stone:0, water:0, food:0, energy:0, gold:0, data:0 };
let gameTime=0, dayCount=1, gameStarted=false;
let selectedBuilding=null;
let buildingGhost=null;
let ghostPosition = new THREE.Vector3();
let MAP_SIZE = 200;
let GRID_SIZE = 2;

const otherPlayers = {}; // id -> {name, color, marker, buildings:{}}
const localBuiltMeshes = {}; // key -> mesh (my buildings)
const otherBuiltMeshes = {}; // `${playerId}_${key}` -> mesh
const harvestableMap = {}; // id -> {data, mesh}
const particles = [];
const animatedObjects = [];

// ═══════════════════════════════════════
// THREE.JS SETUP
// ═══════════════════════════════════════
const scene = new THREE.Scene();
// Lower FOV for tilt-shift miniature feel
const camera = new THREE.PerspectiveCamera(35, innerWidth/innerHeight, 0.1, 800);

const renderer = new THREE.WebGLRenderer({ antialias:!isMobile, powerPreference:'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile?1.5:2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = isMobile?THREE.PCFShadowMap:THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ── Tilt-shift shader (Pokopia miniature/diorama effect) ──
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    focusY: { value: 0.5 },
    blurAmount: { value: isMobile ? 0.003 : 0.005 },
    blurSize: { value: isMobile ? 0.15 : 0.22 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float focusY;
    uniform float blurAmount;
    uniform float blurSize;
    varying vec2 vUv;
    void main(){
      float dist=abs(vUv.y-focusY);
      float strength=smoothstep(0.0,blurSize,dist)*blurAmount;
      vec4 color=vec4(0.0);
      float total=0.0;
      for(float i=-4.0;i<=4.0;i+=1.0){
        float w=1.0-abs(i)/4.0;
        color+=texture2D(tDiffuse,vUv+vec2(0.0,i*strength))*w;
        total+=w;
      }
      // Slight warmth + saturation boost for cozy feel
      vec3 c=(color/total).rgb;
      c=mix(c,c*vec3(1.08,1.03,0.95),0.3);
      float lum=dot(c,vec3(0.299,0.587,0.114));
      c=mix(vec3(lum),c,1.15);
      gl_FragColor=vec4(c,1.0);
    }`
};

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Soft glow bloom (Pokopia warm glow)
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), isMobile?0.2:0.4, 0.8, 0.7);
composer.addPass(bloomPass);
// Tilt-shift pass
if(!isMobile) {
  const tiltShiftPass = new ShaderPass(TiltShiftShader);
  composer.addPass(tiltShiftPass);
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI / 2.15;
controls.minDistance = isMobile?16:10;
controls.maxDistance = isMobile?70:100;
controls.target.set(0, 0, 0);
controls.enablePan = true;
controls.panSpeed = isMobile?0.8:0.5;
if(isMobile){controls.rotateSpeed=0.5;controls.zoomSpeed=0.8;controls.touches={ONE:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN}}

// ═══════════════════════════════════════
// LIGHTING (Pokopia warm golden atmosphere)
// ═══════════════════════════════════════
scene.add(new THREE.AmbientLight(0xffe8cc, 0.55));
const sunLight = new THREE.DirectionalLight(0xffeedd, 1.6);
sunLight.position.set(30, 40, 25);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(isMobile?2048:4096, isMobile?2048:4096);
sunLight.shadow.camera.left = -60;
sunLight.shadow.camera.right = 60;
sunLight.shadow.camera.top = 60;
sunLight.shadow.camera.bottom = -60;
sunLight.shadow.bias = -0.0002;
scene.add(sunLight);
// Warm hemisphere: sky=soft blue, ground=warm green
scene.add(new THREE.HemisphereLight(0xaaddff, 0x88cc66, 0.45));
const fillLight = new THREE.DirectionalLight(0xffccaa, 0.2);
fillLight.position.set(-20, 15, -15);
scene.add(fillLight);
// Rim light for that Pokopia backlight glow
const rimLight = new THREE.DirectionalLight(0xffddaa, 0.3);
rimLight.position.set(-15, 8, 30);
scene.add(rimLight);

// Soft pastel sky (Pokopia gradient feel)
scene.background = new THREE.Color(0xB8E0F6);
scene.fog = new THREE.FogExp2(0xC8E8F8, 0.003);

// ═══════════════════════════════════════
// TERRAIN - Pokopia Blocky/Voxel Style
// ═══════════════════════════════════════
const BLOCK = 4; // block size for voxel terrain

function terrainHeight(x, z) {
  // Gentle rolling hills quantized to block steps
  const smooth = Math.sin(x*0.04)*Math.cos(z*0.035)*2.5
    + Math.sin(x*0.02+1)*Math.cos(z*0.018+2)*3.5;
  return Math.round(smooth / BLOCK) * BLOCK;
}
function getY(x, z) { return terrainHeight(x, z); }

function createTerrain(mapSize) {
  const halfMap = mapSize / 2;
  const step = BLOCK;
  const grassColors = [0x7BC44E, 0x6DB83E, 0x8ACD5A, 0x5FAA35, 0x72C048];
  const dirtColors = [0xA07040, 0x9A6A3A, 0xB07848];

  // Count blocks needed
  const grassPositions = [];
  const dirtPositions = [];

  for (let x = -halfMap; x < halfMap; x += step) {
    for (let z = -halfMap; z < halfMap; z += step) {
      const cx = x + step/2, cz = z + step/2;
      const h = terrainHeight(cx, cz);
      grassPositions.push({x:cx, y:h - step/2, z:cz});
      // Dirt layers below
      for (let dy = h - step; dy >= Math.min(h - step*2, -BLOCK); dy -= step) {
        dirtPositions.push({x:cx, y:dy - step/2, z:cz});
      }
    }
  }

  const blockGeo = new THREE.BoxGeometry(step, step, step);

  // Grass layer (InstancedMesh for performance)
  const grassMat = new THREE.MeshStandardMaterial({roughness:0.82, flatShading:true});
  const grassIM = new THREE.InstancedMesh(blockGeo, grassMat, grassPositions.length);
  grassIM.receiveShadow = true;
  grassIM.castShadow = true;
  const colorAttr = new Float32Array(grassPositions.length * 3);
  const dummy = new THREE.Matrix4();
  for (let i = 0; i < grassPositions.length; i++) {
    const p = grassPositions[i];
    dummy.makeTranslation(p.x, p.y, p.z);
    grassIM.setMatrixAt(i, dummy);
    const gc = new THREE.Color(grassColors[Math.floor(Math.abs(Math.sin(p.x*0.3+p.z*0.7)*4.99))]);
    colorAttr[i*3] = gc.r; colorAttr[i*3+1] = gc.g; colorAttr[i*3+2] = gc.b;
  }
  grassIM.instanceColor = new THREE.InstancedBufferAttribute(colorAttr, 3);
  scene.add(grassIM);

  // Dirt layer
  const dirtMat = new THREE.MeshStandardMaterial({roughness:0.95, flatShading:true});
  const dirtIM = new THREE.InstancedMesh(blockGeo, dirtMat, Math.max(dirtPositions.length,1));
  dirtIM.receiveShadow = true;
  const dirtColorAttr = new Float32Array(Math.max(dirtPositions.length,1) * 3);
  for (let i = 0; i < dirtPositions.length; i++) {
    const p = dirtPositions[i];
    dummy.makeTranslation(p.x, p.y, p.z);
    dirtIM.setMatrixAt(i, dummy);
    const dc = new THREE.Color(dirtColors[Math.floor(Math.random()*3)]);
    dirtColorAttr[i*3] = dc.r; dirtColorAttr[i*3+1] = dc.g; dirtColorAttr[i*3+2] = dc.b;
  }
  dirtIM.instanceColor = new THREE.InstancedBufferAttribute(dirtColorAttr, 3);
  dirtIM.count = dirtPositions.length;
  scene.add(dirtIM);

  // Deep base
  const baseMat = new THREE.MeshStandardMaterial({color:0x5C9A30, roughness:1});
  const base = new THREE.Mesh(new THREE.BoxGeometry(mapSize+20, 2, mapSize+20), baseMat);
  base.position.y = -BLOCK*2 - 1;
  base.receiveShadow = true;
  scene.add(base);

  return grassIM;
}

let ground;

// ═══════════════════════════════════════
// WATER (Pokopia style: blocky pools with shiny surface)
// ═══════════════════════════════════════
const waterMeshes = [];
function createWaterBodies() {
  const waterMat = new THREE.MeshPhysicalMaterial({
    color:0x55BBEE, roughness:0.02, metalness:0.05,
    transparent:true, opacity:0.78, clearcoat:1.0,
    emissive:0x225588, emissiveIntensity:0.08
  });
  // Blocky lakes (square/rectangular for Pokopia vibe)
  const lakes = [
    {x:-30,z:20,w:14,h:10}, {x:35,z:-30,w:10,h:12}, {x:-50,z:-40,w:8,h:8},
    {x:50,z:45,w:12,h:10}, {x:0,z:-55,w:10,h:8}, {x:-60,z:0,w:8,h:6}
  ];
  for (const l of lakes) {
    const lake = new THREE.Mesh(new THREE.BoxGeometry(l.w, 0.6, l.h), waterMat.clone());
    const ly = getY(l.x, l.z) - 0.5;
    lake.position.set(l.x, ly, l.z);
    lake.receiveShadow = true;
    scene.add(lake);
    waterMeshes.push(lake);
    // Sandy edge blocks
    const sandMat = new THREE.MeshStandardMaterial({color:0xE8D5A8, roughness:0.9, flatShading:true});
    for (let sx = -l.w/2 - 2; sx <= l.w/2 + 2; sx += BLOCK) {
      for (const sz of [-l.h/2 - 2, l.h/2 + 2]) {
        if (Math.random() > 0.5) continue;
        const sand = new THREE.Mesh(new THREE.BoxGeometry(BLOCK*0.8,0.4,BLOCK*0.8), sandMat);
        sand.position.set(l.x+sx, ly-0.1, l.z+sz);
        scene.add(sand);
      }
    }
  }
}

// ═══════════════════════════════════════
// NATURE CREATORS (Pokopia: round, colorful, blocky-charming)
// ═══════════════════════════════════════
function createPineTree(x,z,s=1) {
  const g = new THREE.Group();
  // Blocky trunk
  const th = rand(1.5,2.5)*s;
  g.add(Object.assign(new THREE.Mesh(
    new THREE.BoxGeometry(0.4*s,th,0.4*s),
    new THREE.MeshStandardMaterial({color:0x8B5E3C,roughness:0.85,flatShading:true})
  ),{position:new THREE.Vector3(0,th/2,0),castShadow:true}));
  // Round puffy foliage layers (Pokopia style)
  const lc=[0x3DB85A,0x4CC968,0x5AD478,0x45C060];
  for(let i=0;i<3;i++){
    const r=(1.8-i*0.4)*s;
    const leaf=new THREE.Mesh(
      new THREE.SphereGeometry(r,8,6),
      new THREE.MeshStandardMaterial({color:lc[i],roughness:0.7,flatShading:true})
    );
    leaf.scale.y = 0.65;
    leaf.position.y = th + 0.3*s + i*0.7*s;
    leaf.castShadow = true;
    g.add(leaf);
  }
  g.position.set(x,getY(x,z),z);
  g.rotation.y=rand(0,6.28);
  scene.add(g);
  return g;
}

function createOakTree(x,z,s=1) {
  const g=new THREE.Group();
  // Thick blocky trunk
  const h=rand(2,3)*s;
  g.add(Object.assign(new THREE.Mesh(
    new THREE.BoxGeometry(0.5*s,h,0.5*s),
    new THREE.MeshStandardMaterial({color:0x6B4226,roughness:0.9,flatShading:true})
  ),{position:new THREE.Vector3(0,h/2,0),castShadow:true}));
  // Big round canopy (Pokopia puffy style)
  const cc=[0x4CAF50,0x66BB6A,0x43A047][randInt(0,2)];
  const cm=new THREE.MeshStandardMaterial({color:cc,roughness:0.65,flatShading:true});
  const mc=new THREE.Mesh(new THREE.SphereGeometry(2*s,8,6),cm);
  mc.scale.y = 0.7;
  mc.position.y=h+0.8*s; mc.castShadow=true;
  g.add(mc);
  // Extra puffs
  for(let i=0;i<2;i++){
    const b=new THREE.Mesh(new THREE.SphereGeometry(rand(0.8,1.2)*s,7,5),cm);
    b.position.set(rand(-1,1)*s,h+rand(0.2,1)*s,rand(-1,1)*s);
    b.castShadow=true;g.add(b);
  }
  g.position.set(x,getY(x,z),z);
  scene.add(g);
  return g;
}

function createBirchTree(x,z,s=1) {
  const g=new THREE.Group();
  const h=rand(2.5,3.5)*s;
  // White blocky trunk
  g.add(Object.assign(new THREE.Mesh(
    new THREE.BoxGeometry(0.3*s,h,0.3*s),
    new THREE.MeshStandardMaterial({color:0xF0E8D8,roughness:0.5,flatShading:true})
  ),{position:new THREE.Vector3(0,h/2,0),castShadow:true}));
  // Light green/yellow puffy foliage
  const fm=new THREE.MeshStandardMaterial({color:0xA8E060,roughness:0.6,flatShading:true});
  for(let i=0;i<3;i++){
    const l=new THREE.Mesh(new THREE.SphereGeometry(rand(0.7,1)*s,7,5),fm);
    l.position.set(rand(-0.4,0.4)*s,h+rand(0,0.8)*s,rand(-0.4,0.4)*s);
    l.castShadow=true;g.add(l);
  }
  g.position.set(x,getY(x,z),z);
  scene.add(g);
  return g;
}

function createRockCluster(x,z,ms=1) {
  const g=new THREE.Group();
  // Pokopia style: rounder, more cubic rocks with warm tones
  const n=randInt(1,3);
  const rockColors = [0x9E9E9E, 0xB0B0B0, 0xA8A0A0, 0x8A8A8A];
  for(let i=0;i<n;i++){
    const s=ms*rand(0.4,0.9);
    // Mix of boxes and rounded shapes for blocky feel
    const geo = Math.random() > 0.5
      ? new THREE.BoxGeometry(s,s*rand(0.7,1.2),s)
      : new THREE.DodecahedronGeometry(0.5*s,0);
    const rock=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({
      color:rockColors[randInt(0,3)],roughness:0.85,flatShading:true
    }));
    rock.position.set(rand(-0.3,0.3)*ms,s*0.35,rand(-0.3,0.3)*ms);
    rock.rotation.y=rand(0,1);
    rock.castShadow=true;rock.receiveShadow=true;
    g.add(rock);
  }
  // Small grass/moss tufts
  if(Math.random()>0.3){
    const moss=new THREE.Mesh(
      new THREE.SphereGeometry(0.25*ms,5,4),
      new THREE.MeshStandardMaterial({color:0x6BCB4A,roughness:0.8,flatShading:true})
    );
    moss.position.set(rand(-0.2,0.2),0.15*ms,rand(-0.2,0.2));
    moss.scale.y=0.4;g.add(moss);
  }
  g.position.set(x,getY(x,z),z);
  scene.add(g);
  return g;
}

function createTreeByType(type, x, z, s) {
  if (type===0) return createPineTree(x,z,s);
  if (type===1) return createOakTree(x,z,s);
  return createBirchTree(x,z,s);
}

// ═══════════════════════════════════════
// BUILDING MESH CREATORS
// ═══════════════════════════════════════
function createCabin(pos) {
  const g=new THREE.Group();
  // Foundation
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3.4,0.5,3.4),new THREE.MeshStandardMaterial({color:0x8E8E8E,roughness:0.9,flatShading:true})),{position:new THREE.Vector3(0,0.25,0),castShadow:true}));
  // Warm log walls (Pokopia cozy)
  const wm=new THREE.MeshStandardMaterial({color:0xC4924A,roughness:0.8,flatShading:true});
  const wm2=new THREE.MeshStandardMaterial({color:0xB8843E,roughness:0.8,flatShading:true});
  for(let i=0;i<8;i++){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3,0.25,3),i%2?wm2:wm),{position:new THREE.Vector3(0,0.6+i*0.25,0),castShadow:true}))}
  // Warm red roof
  const rm=new THREE.MeshStandardMaterial({color:0xCC4422,roughness:0.7,flatShading:true});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.5,0.15,3.6),rm),{position:new THREE.Vector3(-0.85,2.8,0),rotation:new THREE.Euler(0,0,0.65),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.5,0.15,3.6),rm),{position:new THREE.Vector3(0.85,2.8,0),rotation:new THREE.Euler(0,0,-0.65),castShadow:true}));
  // Cute door (warm brown)
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.8,1.5,0.15),new THREE.MeshStandardMaterial({color:0x7B4A1A,flatShading:true})),{position:new THREE.Vector3(0,1.2,1.55)}));
  // Round doorknob
  g.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.06,6,6),new THREE.MeshStandardMaterial({color:0xFFD700,metalness:0.8,roughness:0.2})),{position:new THREE.Vector3(0.25,1.2,1.65)}));
  // Windows (warm glow)
  for(const s of [-1,1]){
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.15,0.6,0.5),new THREE.MeshStandardMaterial({color:0xFFE8A0,emissive:0xFFCC44,emissiveIntensity:0.3,transparent:true,opacity:0.7})),{position:new THREE.Vector3(s*1.55,1.5,0)}));
  }
  // Chimney
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5,1.2,0.5),new THREE.MeshStandardMaterial({color:0x777,roughness:0.9,flatShading:true})),{position:new THREE.Vector3(1,3.4,-0.8),castShadow:true}));
  // Warm interior light
  g.add(Object.assign(new THREE.PointLight(0xFFAA44,0.6,6),{position:new THREE.Vector3(0,1.5,0)}));
  g.position.copy(pos);
  scene.add(g);
  return g;
}

function createWell(pos) {
  const g=new THREE.Group();
  const sm=new THREE.MeshStandardMaterial({color:0x888,roughness:0.95,flatShading:true});
  for(let l=0;l<4;l++)for(let i=0;i<8;i++){
    const a=(i/8)*6.28+l*0.4;
    const s=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.2,0.25),sm);
    s.position.set(Math.cos(a)*0.7,0.1+l*0.2,Math.sin(a)*0.7);
    s.rotation.y=a;s.castShadow=true;g.add(s);
  }
  g.add(Object.assign(new THREE.Mesh(new THREE.CircleGeometry(0.55,16),new THREE.MeshPhysicalMaterial({color:0x2288cc,roughness:0.05,transparent:true,opacity:0.8,clearcoat:1})),{rotation:new THREE.Euler(-Math.PI/2,0,0),position:new THREE.Vector3(0,0.75,0)}));
  const wm=new THREE.MeshStandardMaterial({color:0x7a5530,roughness:0.85});
  for(const dx of [-0.55,0.55])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.1,1.8,0.1),wm),{position:new THREE.Vector3(dx,1.7,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.3,0.1,0.1),wm),{position:new THREE.Vector3(0,2.6,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createField(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.5,0.2,4.5),new THREE.MeshStandardMaterial({color:0x5C3A20,roughness:1})),{position:new THREE.Vector3(0,0.1,0),receiveShadow:true}));
  const stm=new THREE.MeshStandardMaterial({color:0x8a9a3a,roughness:0.7});
  const hm=new THREE.MeshStandardMaterial({color:0xDAA520,roughness:0.6});
  for(let row=-1.8;row<=1.8;row+=0.5)for(let col=-1.8;col<=1.8;col+=0.25){
    const h=rand(0.5,0.9);
    const sx=col+rand(-0.06,0.06),sz=row+rand(-0.06,0.06);
    g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.012,0.018,h,4),stm),{position:new THREE.Vector3(sx,0.2+h/2,sz)}));
    g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.02,0.15,5),hm),{position:new THREE.Vector3(sx,0.2+h+0.05,sz)}));
  }
  const fm=new THREE.MeshStandardMaterial({color:0x9a7a4a,roughness:0.85});
  for(const sz of [-2.4,2.4])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.8,0.04,0.04),fm),{position:new THREE.Vector3(0,0.4,sz)}));
  for(const sx of [-2.4,2.4])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.04,0.04,4.8),fm),{position:new THREE.Vector3(sx,0.4,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createBarn(pos) {
  const g=new THREE.Group();
  // Foundation
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.4,0.35,3.4),new THREE.MeshStandardMaterial({color:0x8E8E8E,roughness:0.9,flatShading:true})),{position:new THREE.Vector3(0,0.17,0),castShadow:true}));
  // Bright red barn (Pokopia vivid)
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,3,3),new THREE.MeshStandardMaterial({color:0xDD4444,roughness:0.75,flatShading:true})),{position:new THREE.Vector3(0,1.85,0),castShadow:true}));
  // Warm brown roof
  const rm=new THREE.MeshStandardMaterial({color:0x8B5E3C,roughness:0.7,flatShading:true});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.15,3.6),rm),{position:new THREE.Vector3(-1.2,3.7,0),rotation:new THREE.Euler(0,0,0.55),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.15,3.6),rm),{position:new THREE.Vector3(1.2,3.7,0),rotation:new THREE.Euler(0,0,-0.55),castShadow:true}));
  // White X on doors
  const wm=new THREE.MeshStandardMaterial({color:0xFFF8E8,flatShading:true});
  for(const r of [0.78,-0.78])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.08,2.2,0.06),wm),{position:new THREE.Vector3(0,1.6,1.53),rotation:new THREE.Euler(0,0,r)}));
  // Warm glow
  g.add(Object.assign(new THREE.PointLight(0xFFAA44,0.4,5),{position:new THREE.Vector3(0,1.5,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createCoop(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.15,2.2),new THREE.MeshStandardMaterial({color:0x7a5a30})),{position:new THREE.Vector3(0,0.4,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.6,1.2,2),new THREE.MeshStandardMaterial({color:0xDEB887,roughness:0.8})),{position:new THREE.Vector3(0,1.08,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.8,0.08,2.3),new THREE.MeshStandardMaterial({color:0x8B2500})),{position:new THREE.Vector3(-0.6,1.9,0),rotation:new THREE.Euler(0,0,0.35),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.8,0.08,2.3),new THREE.MeshStandardMaterial({color:0x8B2500})),{position:new THREE.Vector3(0.6,1.9,0),rotation:new THREE.Euler(0,0,-0.35)}));
  for(let i=0;i<3;i++){
    const ch=new THREE.Group();
    ch.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.18,7,7),new THREE.MeshStandardMaterial({color:[0xffffff,0xddcc99,0xbb6633][i]})),{position:new THREE.Vector3(0,0.22,0),scale:new THREE.Vector3(1,0.8,1.2)}));
    ch.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.1,6,6),new THREE.MeshStandardMaterial({color:0xffffff})),{position:new THREE.Vector3(0.18,0.35,0)}));
    ch.add(Object.assign(new THREE.Mesh(new THREE.ConeGeometry(0.03,0.08,4),new THREE.MeshStandardMaterial({color:0xff8800})),{position:new THREE.Vector3(0.28,0.34,0),rotation:new THREE.Euler(0,0,-1.57)}));
    ch.position.set(rand(-1,1),0,rand(1,1.8));
    ch.rotation.y=rand(0,6.28);
    g.add(ch);
    animatedObjects.push({type:'chicken',mesh:ch,phase:rand(0,6.28),basePos:ch.position.clone()});
  }
  g.position.copy(pos);scene.add(g);return g;
}

function createGreenhouse(pos) {
  const g=new THREE.Group();
  // Pokopia: warm-tinted glass, white frame, colorful interior
  const glassMat=new THREE.MeshPhysicalMaterial({color:0xCCEEFF,transparent:true,opacity:0.25,roughness:0.02,metalness:0.05,clearcoat:0.9});
  const frameMat=new THREE.MeshStandardMaterial({color:0xF8F8F0,metalness:0.3,roughness:0.4,flatShading:true});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.2,0.15,3.7),new THREE.MeshStandardMaterial({color:0x8E8E8E,flatShading:true})),{position:new THREE.Vector3(0,0.07,0)}));
  // Glass panels
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2,0.06),glassMat),{position:new THREE.Vector3(0,1.1,1.75)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2,0.06),glassMat),{position:new THREE.Vector3(0,1.1,-1.75)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.06,2,3.5),glassMat),{position:new THREE.Vector3(-2,1.1,0)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.06,2,3.5),glassMat),{position:new THREE.Vector3(2,1.1,0)}));
  // Roof panels
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.2,0.06,3.7),glassMat),{position:new THREE.Vector3(-1,2.3,0),rotation:new THREE.Euler(0,0,0.3)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.2,0.06,3.7),glassMat),{position:new THREE.Vector3(1,2.3,0),rotation:new THREE.Euler(0,0,-0.3)}));
  // White frame ribs
  for(const x of [-2,0,2])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.08,2,0.08),frameMat),{position:new THREE.Vector3(x,1.1,1.75)}));
  // Colorful Pokopia plants inside
  const plantColors = [0x4CAF50, 0x66BB6A, 0x43A047];
  const fruitColors = [0xFF5252, 0xFFD740, 0xFF6E40];
  for(let i=0;i<8;i++){
    const plant=new THREE.Group();
    // Blocky stem
    plant.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.06,rand(0.6,1),0.06),new THREE.MeshStandardMaterial({color:plantColors[i%3],flatShading:true})),{position:new THREE.Vector3(0,0.4,0)}));
    // Round fruits
    for(let j=0;j<randInt(1,3);j++){
      plant.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.1,6,6),new THREE.MeshStandardMaterial({color:fruitColors[j%3],roughness:0.4,emissive:fruitColors[j%3],emissiveIntensity:0.1})),{position:new THREE.Vector3(rand(-0.1,0.1),rand(0.3,0.8),rand(-0.1,0.1))}));
    }
    plant.position.set(-1.5+i*0.45,0.1,rand(-1,1));
    g.add(plant);
  }
  // Warm glow inside
  g.add(Object.assign(new THREE.PointLight(0xFFCC66,0.4,4),{position:new THREE.Vector3(0,1.5,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createPasture(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(5,0.1,5),new THREE.MeshStandardMaterial({color:0x4a8f3f,roughness:0.95})),{position:new THREE.Vector3(0,0.05,0),receiveShadow:true}));
  const fm=new THREE.MeshStandardMaterial({color:0x8a6a3a,roughness:0.85});
  for(const z of [-2.6,2.6]){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(5.2,0.04,0.04),fm),{position:new THREE.Vector3(0,0.4,z)}));g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(5.2,0.04,0.04),fm),{position:new THREE.Vector3(0,0.7,z)}))}
  for(const x of [-2.6,2.6]){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.04,0.04,5.2),fm),{position:new THREE.Vector3(x,0.4,0)}));g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.04,0.04,5.2),fm),{position:new THREE.Vector3(x,0.7,0)}))}
  for(let i=0;i<3;i++){
    const cow=new THREE.Group();
    const bodyMat=new THREE.MeshStandardMaterial({color:i===0?0xffffff:i===1?0x8B4513:0x222222,roughness:0.7});
    cow.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.7,0.5,0.4),bodyMat),{position:new THREE.Vector3(0,0.45,0)}));
    cow.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.35),bodyMat),{position:new THREE.Vector3(0.4,0.55,0)}));
    for(const [dx,dz] of [[-0.2,-0.12],[0.2,-0.12],[-0.2,0.12],[0.2,0.12]])
      cow.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,0.2,4),bodyMat),{position:new THREE.Vector3(dx,0.1,dz)}));
    cow.position.set(-1.5+i*1.5,0.1,rand(-1,1));
    cow.rotation.y=rand(0,6.28);
    g.add(cow);
    animatedObjects.push({type:'cow',mesh:cow,phase:rand(0,6.28),basePos:cow.position.clone()});
  }
  g.position.copy(pos);scene.add(g);return g;
}

function createSilo(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(1.2,1.3,3.5,10),new THREE.MeshStandardMaterial({color:0xcccccc,metalness:0.4,roughness:0.4})),{position:new THREE.Vector3(0,1.75,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.ConeGeometry(1.3,1,10),new THREE.MeshStandardMaterial({color:0x999,metalness:0.3})),{position:new THREE.Vector3(0,4,0),castShadow:true}));
  for(let i=0;i<4;i++){g.add(Object.assign(new THREE.Mesh(new THREE.TorusGeometry(1.22,0.04,6,10),new THREE.MeshStandardMaterial({color:0x888,metalness:0.5})),{position:new THREE.Vector3(0,0.5+i*0.9,0),rotation:new THREE.Euler(Math.PI/2,0,0)}))}
  g.position.copy(pos);scene.add(g);return g;
}

function createWindmill(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(1,1.4,3.5,8),new THREE.MeshStandardMaterial({color:0xf0e8d8,roughness:0.7})),{position:new THREE.Vector3(0,2.75,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(1.4,1.6,1,8),new THREE.MeshStandardMaterial({color:0x777,roughness:0.95,flatShading:true})),{position:new THREE.Vector3(0,0.5,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.ConeGeometry(1.2,1.5,8),new THREE.MeshStandardMaterial({color:0x6a3a1a,roughness:0.75})),{position:new THREE.Vector3(0,5.2,0),castShadow:true}));
  const bladesG=new THREE.Group();
  const bm=new THREE.MeshStandardMaterial({color:0x9a7a5a,roughness:0.7});
  const sm=new THREE.MeshStandardMaterial({color:0xf5f0e0,roughness:0.5,side:THREE.DoubleSide,transparent:true,opacity:0.8});
  for(let i=0;i<4;i++){
    const arm=new THREE.Group();
    arm.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.12,3.2,0.06),bm),{position:new THREE.Vector3(0,1.6,0)}));
    arm.add(Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(0.7,2.6),sm),{position:new THREE.Vector3(0.25,1.5,0.02)}));
    arm.rotation.z=(Math.PI/2)*i;
    bladesG.add(arm);
  }
  bladesG.position.set(0,4,1.2);
  g.add(bladesG);
  g._blades=bladesG;
  g.position.copy(pos);scene.add(g);return g;
}

function createSolar(pos) {
  const g=new THREE.Group();
  const panelMat=new THREE.MeshStandardMaterial({color:0x1a1a44,metalness:0.6,roughness:0.2});
  const frameMat=new THREE.MeshStandardMaterial({color:0xcccccc,metalness:0.5,roughness:0.3});
  for(let row=0;row<2;row++){for(let col=0;col<3;col++){
    const panel=new THREE.Group();
    panel.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.2,0.06,0.9),panelMat),{castShadow:true}));
    panel.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,0.8,5),frameMat),{position:new THREE.Vector3(0,-0.35,-0.2),rotation:new THREE.Euler(0.2,0,0)}));
    panel.position.set(-1.3+col*1.3, 0.7, -0.6+row*1.2);
    panel.rotation.x = -0.5;
    g.add(panel);
  }}
  g.add(Object.assign(new THREE.PointLight(0x4488ff,0.3,4),{position:new THREE.Vector3(0,1,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createAntenna(pos) {
  const g=new THREE.Group();
  const mm=new THREE.MeshStandardMaterial({color:0xcccccc,metalness:0.6,roughness:0.3});
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.12,6,6),mm),{position:new THREE.Vector3(0,3,0),castShadow:true}));
  for(let i=0;i<3;i++){const w=1.2-i*0.3;g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(w,0.05,0.05),mm),{position:new THREE.Vector3(0,4.5+i*0.6,0)}))}
  for(const s of [-1,1]){
    const dish=new THREE.Mesh(new THREE.SphereGeometry(0.3,8,6,0,Math.PI),new THREE.MeshStandardMaterial({color:0xeee,metalness:0.4,roughness:0.3}));
    dish.position.set(s*0.5,5.5,0);dish.rotation.y=s*0.5;g.add(dish);
  }
  const light=new THREE.Mesh(new THREE.SphereGeometry(0.06,6,6),new THREE.MeshStandardMaterial({color:0xff0000,emissive:0xff0000,emissiveIntensity:2}));
  light.position.y=6.1;g.add(light);g._blink=light;
  g.add(Object.assign(new THREE.PointLight(0x00ccff,0.2,20),{position:new THREE.Vector3(0,5,0)}));
  const coverRing=new THREE.Mesh(new THREE.RingGeometry(17.5,18,48),new THREE.MeshBasicMaterial({color:0x00ccff,transparent:true,opacity:0.08,side:THREE.DoubleSide}));
  coverRing.rotation.x=-Math.PI/2;coverRing.position.y=0.1;g.add(coverRing);
  g.position.copy(pos);scene.add(g);return g;
}

function createServerRoom(pos) {
  const g=new THREE.Group();
  const wallMat=new THREE.MeshStandardMaterial({color:0x333340,metalness:0.3,roughness:0.5});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3,2.5,2.5),wallMat),{position:new THREE.Vector3(0,1.25,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.6,1.8,0.08),new THREE.MeshStandardMaterial({color:0x555560,metalness:0.4})),{position:new THREE.Vector3(0,0.9,1.27)}));
  for(let i=0;i<3;i++){
    const rack=new THREE.Mesh(new THREE.BoxGeometry(0.4,2,0.5),new THREE.MeshStandardMaterial({color:0x222230,metalness:0.5}));
    rack.position.set(-0.8+i*0.8,1,0);g.add(rack);
    for(let j=0;j<6;j++){
      const led=new THREE.Mesh(new THREE.SphereGeometry(0.02,4,4),new THREE.MeshStandardMaterial({color:Math.random()>0.3?0x00ff88:0x00ccff,emissive:Math.random()>0.3?0x00ff88:0x00ccff,emissiveIntensity:2}));
      led.position.set(-0.8+i*0.8+0.15,0.4+j*0.3,0.27);g.add(led);
    }
  }
  g.add(Object.assign(new THREE.PointLight(0x00ccff,0.5,4),{position:new THREE.Vector3(0,1.2,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

const buildingCreators = {
  cabin:createCabin, well:createWell, field:createField, barn:createBarn,
  coop:createCoop, greenhouse:createGreenhouse, pasture:createPasture,
  silo:createSilo, windmill:createWindmill, solar:createSolar,
  antenna:createAntenna, server:createServerRoom
};

// ═══════════════════════════════════════
// PLAYER MARKERS (visible on map)
// ═══════════════════════════════════════
function createPlayerMarker(color) {
  const g = new THREE.Group();
  const flagColor = new THREE.Color(color);
  // Cute blocky pole
  g.add(Object.assign(new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 4, 0.12),
    new THREE.MeshStandardMaterial({color:0xF0E8D8, roughness:0.5, flatShading:true})
  ),{position:new THREE.Vector3(0,2,0)}));
  // Triangular flag (Pokopia cute)
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1.5,0.3,0, 0,1,0], 3));
  flagGeo.computeVertexNormals();
  g.add(Object.assign(new THREE.Mesh(
    flagGeo,
    new THREE.MeshStandardMaterial({color:flagColor, side:THREE.DoubleSide, emissive:flagColor, emissiveIntensity:0.2, flatShading:true})
  ),{position:new THREE.Vector3(0.06,3.2,0)}));
  // Glowing ring on ground
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 2, 32),
    new THREE.MeshBasicMaterial({color:flagColor, transparent:true, opacity:0.25, side:THREE.DoubleSide})
  );
  ring.rotation.x = -Math.PI/2;
  ring.position.y = 0.15;
  g.add(ring);
  // Star on top
  g.add(Object.assign(new THREE.Mesh(
    new THREE.OctahedronGeometry(0.15, 0),
    new THREE.MeshStandardMaterial({color:0xFFD700, emissive:0xFFCC00, emissiveIntensity:0.5, metalness:0.6, flatShading:true})
  ),{position:new THREE.Vector3(0,4.1,0)}));
  return g;
}

// ═══════════════════════════════════════
// OWNER BANNER (shows who owns a building)
// ═══════════════════════════════════════
function addOwnerBanner(buildingMesh, playerName, playerColor) {
  const bannerMat = new THREE.MeshBasicMaterial({color:new THREE.Color(playerColor), transparent:true, opacity:0.6, side:THREE.DoubleSide});
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), bannerMat);
  banner.position.y = 4.5;
  buildingMesh.add(banner);
}

// ═══════════════════════════════════════
// CLOUDS (Pokopia: big puffy marshmallow clouds)
// ═══════════════════════════════════════
const clouds = [];
function spawnClouds() {
  const cloudMat = new THREE.MeshStandardMaterial({
    color:0xFFFFFF, transparent:true, opacity:0.55, roughness:1,
    emissive:0xFFEECC, emissiveIntensity:0.08
  });
  for(let i=0; i<(isMobile?8:16); i++){
    const g = new THREE.Group();
    const n = randInt(4,8);
    for(let j=0;j<n;j++){
      const s = rand(3,7);
      const blob = new THREE.Mesh(new THREE.SphereGeometry(s,8,6), cloudMat);
      blob.position.set(rand(-4,4), rand(-0.5,1), rand(-3,3));
      blob.scale.y = 0.35; // Very flat puffy
      g.add(blob);
    }
    g.position.set(rand(-MAP_SIZE/2, MAP_SIZE/2), rand(28,45), rand(-MAP_SIZE/2, MAP_SIZE/2));
    scene.add(g);
    clouds.push(g);
  }
}

// ═══════════════════════════════════════
// AMBIENT PARTICLES (Pokopia sparkles, fireflies, floating leaves)
// ═══════════════════════════════════════
const ambientParticles = [];
function spawnAmbientParticles() {
  if(isMobile) return; // Skip on mobile for performance
  // Sparkles / light motes
  const sparkleMat = new THREE.MeshBasicMaterial({color:0xFFFFCC, transparent:true, opacity:0.6});
  for(let i=0; i<40; i++){
    const sparkle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 4, 4), sparkleMat.clone());
    sparkle.position.set(rand(-60,60), rand(2,10), rand(-60,60));
    scene.add(sparkle);
    ambientParticles.push({
      mesh:sparkle, type:'sparkle',
      baseY:sparkle.position.y,
      phase:rand(0,6.28),
      speed:rand(0.3,0.8),
      radius:rand(0.5,2)
    });
  }
  // Floating leaves
  const leafColors = [0x7BC44E, 0xA8E060, 0xFFCC44, 0xFF8844];
  for(let i=0; i<20; i++){
    const leaf = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.15),
      new THREE.MeshStandardMaterial({
        color:leafColors[i%4], side:THREE.DoubleSide, transparent:true, opacity:0.7
      })
    );
    leaf.position.set(rand(-50,50), rand(3,12), rand(-50,50));
    scene.add(leaf);
    ambientParticles.push({
      mesh:leaf, type:'leaf',
      baseY:leaf.position.y,
      phase:rand(0,6.28),
      drift:rand(-0.5,0.5),
      spin:rand(0.5,2)
    });
  }
}

// ═══════════════════════════════════════
// GHOST (free placement)
// ═══════════════════════════════════════
function showGhostForKey(key) {
  removeGhost();
  const bdef = serverBuildings[key];
  if(!bdef) return;
  // Pokopia placement preview: soft glowing block
  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(bdef.size[0], 2.5, bdef.size[1]),
    new THREE.MeshStandardMaterial({ color:0x7BC44E, transparent:true, opacity:0.25, emissive:0x66BB6A, emissiveIntensity:0.15 })
  );
  const wire = new THREE.Mesh(new THREE.BoxGeometry(bdef.size[0], 2.5, bdef.size[1]),
    new THREE.MeshBasicMaterial({ color:0xA8E060, wireframe:true, transparent:true, opacity:0.4 })
  );
  ghost.add(wire);
  ghost.position.y = 1.25;
  scene.add(ghost);
  buildingGhost = ghost;
  document.getElementById('placement-hint').style.display = 'block';
}
function removeGhost() {
  if(buildingGhost){scene.remove(buildingGhost);buildingGhost=null}
  document.getElementById('placement-hint').style.display = 'none';
}

function canAfford(cost) { return Object.entries(cost).every(([r,v])=>(R[r]||0)>=v); }

// ═══════════════════════════════════════
// UI FUNCTIONS
// ═══════════════════════════════════════
let unlockedBuildings = ['cabin'];
let myBuildings = {}; // key -> {built, x, z}

function renderBuildMenu() {
  const menu = document.getElementById('build-menu');
  menu.innerHTML = '';
  const icons = {wood:'🪵',stone:'🪨',water:'💧',food:'🌾',energy:'⚡',gold:'🪙',data:'📊'};
  for (const [key, b] of Object.entries(serverBuildings)) {
    const isBuilt = myBuildings[key]?.built;
    const isUnlocked = unlockedBuildings.includes(key);
    const btn = document.createElement('div');
    btn.className = 'build-btn' + (isBuilt?' built':!isUnlocked?' locked':'') + (selectedBuilding===key?' active':'');
    if (b.category==='tech') btn.classList.add('iot-btn');
    const costStr = Object.entries(b.cost).map(([r,v])=>`${icons[r]||''}${v}`).join(' ');
    btn.innerHTML = `<div class="b-icon">${b.icon}</div><div class="b-name">${b.name}</div><div class="b-cost">${isBuilt?'✓':costStr}</div>`;
    if (!isBuilt && isUnlocked) {
      btn.addEventListener('click', () => {
        selectedBuilding = selectedBuilding===key ? null : key;
        if(selectedBuilding) showGhostForKey(key); else removeGhost();
        renderBuildMenu();
      });
    }
    menu.appendChild(btn);
  }
}

function updateHUD() {
  for(const [k,v] of Object.entries(R)){
    const el=document.getElementById(`r-${k}`);
    if(el){const prev=parseInt(el.textContent)||0;if(Math.round(v)!==prev){el.textContent=Math.round(v);el.parentElement.style.transform='scale(1.12)';setTimeout(()=>{el.parentElement.style.transform='scale(1)'},200)}}
  }
}

function showPopup(x, y, text, cls='production') {
  const popup = document.createElement('div');
  popup.className = `popup ${cls}`;
  popup.textContent = text;
  popup.style.left = x+'px';
  popup.style.top = y+'px';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 1400);
}

function showMessage(text, color='#fff') {
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = text;
  msg.style.borderLeft = `3px solid ${color}`;
  document.getElementById('messages').appendChild(msg);
  setTimeout(() => msg.remove(), 3500);
}

function updatePlayerList() {
  const container = document.getElementById('players-container');
  let html = '';
  // Me
  if(myPlayer) {
    html += `<div class="player-entry"><div class="player-dot" style="background:${myPlayer.color}"></div><span class="player-name">${myPlayer.name}</span><span class="player-you"> (toi)</span></div>`;
  }
  // Others
  for(const [id, p] of Object.entries(otherPlayers)) {
    html += `<div class="player-entry"><div class="player-dot" style="background:${p.color}"></div><span class="player-name">${p.name}</span></div>`;
  }
  container.innerHTML = html;
}

function addChatMessage(name, color, msg) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="sender" style="color:${color}">${name}:</span> ${msg}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ═══════════════════════════════════════
// TAB SYSTEM
// ═══════════════════════════════════════
let currentTab = 'build';
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.className = 'tab-btn');
    btn.className = 'tab-btn active';
    document.getElementById('build-menu').style.display = currentTab==='build' ? 'flex' : 'none';
    document.getElementById('chat-box').style.display = currentTab==='chat' ? 'block' : 'none';
    if(currentTab==='build') renderBuildMenu();
    selectedBuilding = null;
    removeGhost();
  });
});

// ═══════════════════════════════════════
// CHAT
// ═══════════════════════════════════════
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => { if(e.key==='Enter') sendChat(); });
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if(!msg) return;
  socket.emit('chat', { msg });
  input.value = '';
}

// ═══════════════════════════════════════
// INTERACTION (raycasting)
// ═══════════════════════════════════════
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();

function onPointerDown(e) {
  if(!gameStarted) return;
  mouse.x = (e.clientX/innerWidth)*2-1;
  mouse.y = -(e.clientY/innerHeight)*2+1;
  raycaster.setFromCamera(mouse, camera);

  // Building placement on terrain
  if(selectedBuilding) {
    // Intersect with ground plane
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, pt);
    if(pt) {
      const sx = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
      const sz = Math.round(pt.z / GRID_SIZE) * GRID_SIZE;
      socket.emit('build', { key: selectedBuilding, x: sx, z: sz });
      return;
    }
  }

  // Harvest: raycast against harvestable meshes
  const allMeshes = [];
  for(const [id, h] of Object.entries(harvestableMap)) {
    if(h.data.hp > 0 && h.mesh) {
      if(h.mesh instanceof THREE.Group) h.mesh.children.forEach(c => allMeshes.push({obj:c, id:parseInt(id)}));
      else allMeshes.push({obj:h.mesh, id:parseInt(id)});
    }
  }
  const objects = allMeshes.map(m => m.obj);
  const intersects = raycaster.intersectObjects(objects, true);
  if(intersects.length > 0) {
    const hit = intersects[0].object;
    // Find which harvestable was hit
    for(const m of allMeshes) {
      let isHit = false;
      if(m.obj === hit) isHit = true;
      else {
        const h = harvestableMap[m.id];
        if(h && h.mesh instanceof THREE.Group) h.mesh.traverse(c => { if(c===hit) isHit=true });
      }
      if(isHit) {
        socket.emit('harvest', { id: m.id });
        // Immediate visual feedback (shake)
        const h = harvestableMap[m.id];
        if(h && h.mesh) {
          const orig = h.mesh.position.clone();
          h.mesh.position.x += rand(-0.3, 0.3);
          setTimeout(() => { if(h.mesh.parent) h.mesh.position.copy(orig); }, 120);
          // Debris particles
          const pc = isMobile?2:4;
          for(let p=0; p<pc; p++){
            const pm = new THREE.Mesh(new THREE.BoxGeometry(0.05,0.05,0.05), new THREE.MeshStandardMaterial({color:h.data.type==='tree'?0x8B5E3C:0x888}));
            pm.position.copy(intersects[0].point); scene.add(pm);
            particles.push({mesh:pm,type:'debris',vel:new THREE.Vector3(rand(-2,2),rand(1,4),rand(-2,2)),life:rand(0.5,1.2),maxLife:1.2});
          }
        }
        return;
      }
    }
  }
}

renderer.domElement.addEventListener('pointerdown', onPointerDown);

// Mobile touch: distinguish tap from drag
if(isMobile){
  renderer.domElement.addEventListener('touchstart',(e)=>{if(e.touches.length===1)e.preventDefault()},{passive:false});
  let _ts=null,_tm=false;
  renderer.domElement.addEventListener('touchstart',(e)=>{if(e.touches.length===1){_ts={x:e.touches[0].clientX,y:e.touches[0].clientY,t:Date.now()};_tm=false}});
  renderer.domElement.addEventListener('touchmove',(e)=>{if(_ts&&e.touches.length===1){const dx=e.touches[0].clientX-_ts.x,dy=e.touches[0].clientY-_ts.y;if(Math.sqrt(dx*dx+dy*dy)>15)_tm=true}});
  renderer.domElement.addEventListener('touchend',()=>{if(_ts&&!_tm&&Date.now()-_ts.t<300){onPointerDown({clientX:_ts.x,clientY:_ts.y,preventDefault:()=>{}})}_ts=null});
  document.addEventListener('contextmenu',(e)=>e.preventDefault());
}

// Tooltip (desktop only)
if(!isMobile) {
  renderer.domElement.addEventListener('pointermove',(e)=>{
    if(!gameStarted)return;
    const tooltip=document.getElementById('tooltip');
    mouse.x=(e.clientX/innerWidth)*2-1;
    mouse.y=-(e.clientY/innerHeight)*2+1;
    raycaster.setFromCamera(mouse,camera);

    // Update ghost position
    if(buildingGhost && selectedBuilding) {
      const plane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
      const pt = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, pt);
      if(pt) {
        const sx = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
        const sz = Math.round(pt.z / GRID_SIZE) * GRID_SIZE;
        buildingGhost.position.set(sx, getY(sx,sz)+1.25, sz);
        const afford = canAfford(serverBuildings[selectedBuilding].cost);
        buildingGhost.material.color.setHex(afford ? 0x4CAF50 : 0xff4444);
      }
    }

    // Harvestable tooltip
    const allMeshes = [];
    for(const [id, h] of Object.entries(harvestableMap)) {
      if(h.data.hp > 0 && h.mesh) {
        if(h.mesh instanceof THREE.Group) h.mesh.children.forEach(c => allMeshes.push({obj:c, id}));
        else allMeshes.push({obj:h.mesh, id});
      }
    }
    const objects = allMeshes.map(m => m.obj);
    const intersects = raycaster.intersectObjects(objects, true);
    if(intersects.length>0){
      const hit = intersects[0].object;
      for(const m of allMeshes) {
        let isHit = m.obj === hit;
        if(!isHit) { const h=harvestableMap[m.id]; if(h?.mesh instanceof THREE.Group) h.mesh.traverse(c=>{if(c===hit)isHit=true}); }
        if(isHit) {
          const h = harvestableMap[m.id];
          tooltip.style.display='block';
          tooltip.style.left=e.clientX+15+'px';tooltip.style.top=e.clientY-10+'px';
          tooltip.innerHTML=`<strong>${h.data.type==='tree'?'Arbre':'Rocher'}</strong> (${h.data.hp}/${h.data.maxHp})<br><span style="opacity:.6">Clic pour ${h.data.type==='tree'?'couper':'miner'}</span>`;
          renderer.domElement.style.cursor='pointer';
          return;
        }
      }
    }
    tooltip.style.display='none';
    renderer.domElement.style.cursor = selectedBuilding ? 'crosshair' : 'grab';
  });
}

// ═══════════════════════════════════════
// GAME LOOP
// ═══════════════════════════════════════
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if(!gameStarted) {
    controls.update();
    composer.render();
    return;
  }

  gameTime += dt;

  // Day count
  const newDay = Math.floor(gameTime / 80) + 1;
  if(newDay !== dayCount) {
    dayCount = newDay;
    document.getElementById('day-indicator').textContent = `Jour ${dayCount}`;
  }

  // Animate windmills (all players)
  const allMeshes = {...localBuiltMeshes, ...otherBuiltMeshes};
  for(const [k, mesh] of Object.entries(allMeshes)) {
    if(mesh._blades) mesh._blades.rotation.z += dt * 0.8;
    if(mesh._blink) mesh._blink.material.emissiveIntensity = 1 + Math.sin(gameTime*3)*1.5;
  }

  // Animate animals
  for(const obj of animatedObjects) {
    if(obj.type==='chicken') {
      obj.mesh.position.y = obj.basePos.y + Math.sin(gameTime*3+obj.phase)*0.03;
      obj.mesh.rotation.y += Math.sin(gameTime*0.5+obj.phase)*0.005;
    } else if(obj.type==='cow') {
      obj.mesh.position.y = obj.basePos.y + Math.sin(gameTime*1.5+obj.phase)*0.02;
    }
  }

  // Sway trees
  for(const [id, h] of Object.entries(harvestableMap)) {
    if(h.data.type==='tree' && h.mesh && h.data.hp > 0) {
      h.mesh.rotation.z = Math.sin(gameTime*1.2+h.data.x)*0.025;
    }
  }

  // Particles
  for(let i=particles.length-1; i>=0; i--) {
    const p = particles[i];
    p.life -= dt;
    if(p.life <= 0) { scene.remove(p.mesh); particles.splice(i,1); continue; }
    p.vel.y -= 9.8*dt;
    p.mesh.position.add(p.vel.clone().multiplyScalar(dt));
    p.mesh.rotation.x += dt*3; p.mesh.rotation.y += dt*2;
    p.mesh.scale.setScalar(p.life/p.maxLife);
  }

  // Clouds (slow drift)
  for(const c of clouds) {
    c.position.x += dt * 0.8;
    if(c.position.x > MAP_SIZE/2 + 30) c.position.x = -MAP_SIZE/2 - 30;
  }

  // Water gentle bob
  for(const w of waterMeshes) {
    w.position.y += Math.sin(gameTime*1.2 + w.position.x)*0.002;
  }

  // Ambient particles (Pokopia sparkles & leaves)
  for(const ap of ambientParticles) {
    if(ap.type==='sparkle') {
      ap.mesh.position.y = ap.baseY + Math.sin(gameTime*ap.speed + ap.phase)*ap.radius;
      ap.mesh.position.x += Math.sin(gameTime*0.3 + ap.phase)*0.005;
      ap.mesh.material.opacity = 0.3 + Math.sin(gameTime*2 + ap.phase)*0.3;
      ap.mesh.scale.setScalar(0.5 + Math.sin(gameTime*3 + ap.phase)*0.5);
    } else if(ap.type==='leaf') {
      ap.mesh.position.y = ap.baseY + Math.sin(gameTime*0.5 + ap.phase)*1.5 - dt*0.3;
      ap.mesh.position.x += ap.drift*dt;
      ap.mesh.rotation.x += ap.spin*dt;
      ap.mesh.rotation.z += ap.spin*dt*0.7;
      // Reset if too low
      if(ap.mesh.position.y < 1) { ap.mesh.position.y = rand(8,14); ap.baseY = ap.mesh.position.y; ap.mesh.position.x = rand(-50,50); ap.mesh.position.z = rand(-50,50); }
    }
  }

  // Ghost float
  if(buildingGhost) {
    buildingGhost.position.y += Math.sin(gameTime*2)*0.003;
  }

  // Send camera position periodically
  if(Math.floor(gameTime*2) !== Math.floor((gameTime-dt)*2)) {
    socket.emit('cameraMove', { x: controls.target.x, z: controls.target.z });
  }

  controls.update();
  if(isMobile) renderer.render(scene, camera);
  else composer.render();
}
animate();

// ═══════════════════════════════════════
// NETWORK EVENT HANDLERS
// ═══════════════════════════════════════
socket.on('joined', (data) => {
  myPlayerId = data.playerId;
  myPlayer = data.player;
  serverBuildings = data.buildings;
  MAP_SIZE = data.mapSize;
  GRID_SIZE = data.gridSize;
  unlockedBuildings = data.player.unlockedBuildings;
  Object.assign(R, data.player.resources);

  // Create world
  ground = createTerrain(MAP_SIZE);
  createWaterBodies();
  spawnClouds();
  spawnAmbientParticles();

  // Spawn harvestables
  for(const h of data.harvestables) {
    spawnHarvestableMesh(h);
  }

  // Set camera to spawn point
  const sp = data.player.spawn;
  camera.position.set(sp.x + (isMobile?40:35), isMobile?32:28, sp.z + (isMobile?40:35));
  controls.target.set(sp.x, 0, sp.z);

  // Place spawn marker
  const marker = createPlayerMarker(myPlayer.color);
  marker.position.set(sp.x, getY(sp.x, sp.z), sp.z);
  scene.add(marker);

  // Load existing other players
  for(const [id, p] of Object.entries(data.players)) {
    if(id === myPlayerId) continue;
    addOtherPlayer(id, p);
  }

  // Show game UI
  gameStarted = true;
  document.getElementById('join-screen').style.display = 'none';
  document.getElementById('hud').style.display = 'flex';
  document.getElementById('build-menu').style.display = 'flex';
  document.getElementById('tab-bar').style.display = 'flex';
  document.getElementById('day-indicator').style.display = 'block';
  document.getElementById('player-list').style.display = 'block';

  renderBuildMenu();
  updateHUD();
  updatePlayerList();

  if(isMobile) {
    showMessage('Touche les arbres et rochers pour recolter!', '#66bb6a');
  } else {
    showMessage('Recolte bois et pierre pour commencer!', '#66bb6a');
  }
  setTimeout(() => showMessage('Construis ta cabane en premier!', '#FFD54F'), 3500);
});

socket.on('serverFull', () => {
  document.querySelector('#join-screen .info').textContent = 'Serveur plein! Reessaye plus tard.';
  document.querySelector('#join-screen .info').style.color = '#ff4444';
  document.querySelector('#join-screen .info').style.opacity = '1';
});

socket.on('playerJoined', (p) => {
  addOtherPlayer(p.id, p);
  showMessage(`${p.name} a rejoint la partie!`, p.color);
  updatePlayerList();
});

socket.on('playerLeft', (data) => {
  removeOtherPlayer(data.playerId);
  showMessage(`${data.playerName} a quitte`, '#888');
  updatePlayerList();
});

socket.on('resourceUpdate', (resources) => {
  Object.assign(R, resources);
  updateHUD();
  renderBuildMenu();
});

socket.on('buildingUnlocks', (unlocks) => {
  unlockedBuildings = unlocks;
  renderBuildMenu();
});

socket.on('buildingPlaced', (data) => {
  const pos = new THREE.Vector3(data.x, getY(data.x, data.z), data.z);
  const mesh = buildingCreators[data.key](pos);

  // Rise animation
  const ty = mesh.position.y;
  mesh.position.y -= 3; mesh.scale.set(0.01,0.01,0.01);
  let prog = 0;
  const anim = () => {
    prog += 0.025;
    const t = Math.min(prog,1);
    const e = 1 - Math.pow(1-t, 3);
    mesh.position.y = ty - 3 + 3*e;
    mesh.scale.setScalar(e);
    if(t<1) requestAnimationFrame(anim);
  };
  anim();

  // Add owner banner
  addOwnerBanner(mesh, data.playerName, data.playerColor);

  if(data.playerId === myPlayerId) {
    localBuiltMeshes[data.key] = mesh;
    myBuildings[data.key] = { built:true, x:data.x, z:data.z };
    selectedBuilding = null;
    removeGhost();
    showMessage(`${data.building.name} construit!`, '#4CAF50');
    renderBuildMenu();
  } else {
    otherBuiltMeshes[`${data.playerId}_${data.key}`] = mesh;
    showMessage(`${data.playerName} a construit ${data.building.name}!`, data.playerColor);
  }
});

socket.on('buildError', (msg) => {
  showMessage(msg, '#ff4444');
});

socket.on('harvestableHit', (data) => {
  const h = harvestableMap[data.id];
  if(h) {
    h.data.hp = data.hp;
    // Shake if someone else hit it
    if(data.playerId !== myPlayerId && h.mesh) {
      const orig = h.mesh.position.clone();
      h.mesh.position.x += rand(-0.3, 0.3);
      setTimeout(() => { if(h.mesh.parent) h.mesh.position.copy(orig); }, 120);
    }
  }
});

socket.on('harvestableDestroyed', (data) => {
  const h = harvestableMap[data.id];
  if(h && h.mesh) {
    // Shrink & remove
    let ss = 1;
    const shrink = () => {
      ss -= 0.06;
      if(ss > 0) { h.mesh.scale.setScalar(ss); h.mesh.position.y -= 0.02; requestAnimationFrame(shrink); }
      else { scene.remove(h.mesh); delete harvestableMap[data.id]; }
    };
    shrink();

    // Popup for the player who harvested
    if(data.playerId === myPlayerId) {
      const screenPos = worldToScreen(h.mesh.position);
      showPopup(screenPos.x, screenPos.y, `+${data.amount} ${data.resource==='wood'?'🪵':'🪨'}`, 'res-'+data.resource);
    }
  }
});

socket.on('harvestableSpawned', (data) => {
  spawnHarvestableMesh(data);
});

socket.on('production', (data) => {
  Object.assign(R, data.resources);
  updateHUD();
  // Show production popup
  for(const [res, amount] of Object.entries(data.produced)) {
    const icons = {wood:'🪵',stone:'🪨',water:'💧',food:'🌾',energy:'⚡',gold:'🪙',data:'📊'};
    showMessage(`+${Math.round(amount*10)/10} ${icons[res]||res}`, '#FFD700');
  }
});

socket.on('playerMoved', (data) => {
  const p = otherPlayers[data.playerId];
  if(p && p.marker) {
    p.marker.position.x = data.x;
    p.marker.position.z = data.z;
    p.marker.position.y = getY(data.x, data.z);
  }
});

socket.on('chatMessage', (data) => {
  addChatMessage(data.name, data.color, data.msg);
});

socket.on('playerWon', (data) => {
  document.getElementById('win-screen').style.display = 'flex';
  document.getElementById('win-title').textContent = data.playerId === myPlayerId ? 'Tu as gagne!' : `${data.playerName} a gagne!`;
  document.getElementById('win-text').textContent = data.playerId === myPlayerId ? 'Bravo, ta ferme intelligente est complete!' : `${data.playerName} a complete sa ferme en premier!`;
});

socket.on('buildingRepaired', (data) => {
  showMessage(`${serverBuildings[data.key]?.name || data.key} repare!`, '#66bb6a');
});

// ═══════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════
function spawnHarvestableMesh(data) {
  const s = rand(0.7, 1.3);
  let mesh;
  if(data.type === 'tree') {
    mesh = createTreeByType(data.treeType || 0, data.x, data.z, s);
  } else {
    mesh = createRockCluster(data.x, data.z, s);
  }
  harvestableMap[data.id] = { data, mesh };
}

function addOtherPlayer(id, data) {
  const marker = createPlayerMarker(data.color);
  const sp = data.spawn || data.cameraPos || {x:0, z:0};
  marker.position.set(sp.x, getY(sp.x, sp.z), sp.z);
  scene.add(marker);

  otherPlayers[id] = {
    name: data.name,
    color: data.color,
    marker,
    buildings: data.buildings || {}
  };

  // Place existing buildings from this player
  if(data.buildings) {
    for(const [key, bdata] of Object.entries(data.buildings)) {
      if(bdata.built) {
        const pos = new THREE.Vector3(bdata.x, getY(bdata.x, bdata.z), bdata.z);
        const mesh = buildingCreators[key](pos);
        addOwnerBanner(mesh, data.name, data.color);
        otherBuiltMeshes[`${id}_${key}`] = mesh;
      }
    }
  }
}

function removeOtherPlayer(id) {
  const p = otherPlayers[id];
  if(p) {
    if(p.marker) scene.remove(p.marker);
    // Remove their buildings
    for(const [mKey, mesh] of Object.entries(otherBuiltMeshes)) {
      if(mKey.startsWith(id+'_')) {
        scene.remove(mesh);
        delete otherBuiltMeshes[mKey];
      }
    }
    delete otherPlayers[id];
  }
}

function worldToScreen(pos) {
  const v = pos.clone().project(camera);
  return {
    x: (v.x + 1) / 2 * innerWidth,
    y: (-v.y + 1) / 2 * innerHeight
  };
}

// ═══════════════════════════════════════
// JOIN & EVENTS
// ═══════════════════════════════════════
document.getElementById('join-btn').addEventListener('click', joinGame);
document.getElementById('player-name').addEventListener('keydown', (e) => { if(e.key==='Enter') joinGame(); });

function joinGame() {
  const name = document.getElementById('player-name').value.trim() || 'Joueur';
  if (!socket || !socket.connected) {
    const info = document.querySelector('#join-screen .info');
    if (info) {
      info.innerHTML = '⚠️ Pas de connexion au serveur.<br>Lance <code style="background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px">npm start</code> puis ouvre <code style="background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px">localhost:3000</code>';
      info.style.color = '#FFB347';
      info.style.opacity = '1';
    }
    return;
  }
  socket.emit('join', { name });
}

// Resize
window.addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  composer.setSize(innerWidth,innerHeight);
});
if(isMobile){
  window.addEventListener('orientationchange',()=>{setTimeout(()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight)},200)});
}

// Keyboard
window.addEventListener('keydown', (e) => {
  if(e.key==='Escape'){selectedBuilding=null;removeGhost();renderBuildMenu()}
  // Enter to focus chat
  if(e.key==='Enter' && currentTab!=='chat') {
    currentTab = 'chat';
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.className = 'tab-btn' + (b.dataset.tab==='chat' ? ' active' : '');
    });
    document.getElementById('build-menu').style.display = 'none';
    document.getElementById('chat-box').style.display = 'block';
    document.getElementById('chat-input').focus();
  }
  const n = parseInt(e.key);
  if(n>=1 && n<=9) {
    const keys = Object.keys(serverBuildings);
    if(n<=keys.length) {
      const k = keys[n-1];
      if(unlockedBuildings.includes(k) && !myBuildings[k]?.built) {
        selectedBuilding = k;
        showGhostForKey(k);
        renderBuildMenu();
      }
    }
  }
});
