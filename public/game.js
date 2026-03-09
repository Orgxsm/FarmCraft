import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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
const socket = io();
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
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 800);

const renderer = new THREE.WebGLRenderer({ antialias:!isMobile, powerPreference:'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile?1.5:2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = isMobile?THREE.PCFShadowMap:THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), isMobile?0.12:0.25, 0.5, 0.85);
if(!isMobile) composer.addPass(bloomPass);

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
// LIGHTING
// ═══════════════════════════════════════
scene.add(new THREE.AmbientLight(0x8899bb, 0.4));
const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.8);
sunLight.position.set(25, 35, 20);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(isMobile?2048:4096, isMobile?2048:4096);
sunLight.shadow.camera.left = -60;
sunLight.shadow.camera.right = 60;
sunLight.shadow.camera.top = 60;
sunLight.shadow.camera.bottom = -60;
sunLight.shadow.bias = -0.0002;
scene.add(sunLight);
scene.add(new THREE.HemisphereLight(0x99ccff, 0x337722, 0.3));
const fillLight = new THREE.DirectionalLight(0x6688cc, 0.25);
fillLight.position.set(-20, 12, -15);
scene.add(fillLight);

scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.FogExp2(0x87CEEB, 0.004);

// ═══════════════════════════════════════
// TERRAIN (200x200)
// ═══════════════════════════════════════
function terrainHeight(x, z) {
  return Math.sin(x*0.08)*Math.cos(z*0.06)*0.9
    + Math.sin(x*0.04+1)*Math.cos(z*0.03+2)*1.4
    + Math.sin(x*0.2)*Math.cos(z*0.25)*0.2;
}
function getY(x, z) { return terrainHeight(x, z); }

function createTerrain(mapSize) {
  const geo = new THREE.PlaneGeometry(mapSize, mapSize, 120, 120);
  const gp = geo.attributes.position;
  const gColors = new Float32Array(gp.count * 3);
  for (let i=0; i<gp.count; i++) {
    const x=gp.getX(i), y=gp.getY(i);
    const h = terrainHeight(x, y);
    gp.setZ(i, h);
    const t = (h+2)/4;
    gColors[i*3] = lerp(0.18,0.35,t)+rand(-0.02,0.02);
    gColors[i*3+1] = lerp(0.28,0.58,t)+rand(-0.02,0.02);
    gColors[i*3+2] = lerp(0.1,0.2,t)+rand(-0.01,0.01);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(gColors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.95 }));
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);
  return ground;
}

let ground;

// ═══════════════════════════════════════
// WATER
// ═══════════════════════════════════════
function createWaterBodies() {
  const waterMat = new THREE.MeshPhysicalMaterial({
    color:0x2288cc, roughness:0.05, metalness:0.1,
    transparent:true, opacity:0.72, clearcoat:1.0
  });
  // Multiple lakes spread across the large map
  const lakes = [
    {x:-30,z:20,r:8}, {x:35,z:-30,r:6}, {x:-50,z:-40,r:5},
    {x:50,z:45,r:7}, {x:0,z:-55,r:5}, {x:-60,z:0,r:4}
  ];
  for (const l of lakes) {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(l.r, 48), waterMat.clone());
    lake.rotation.x = -Math.PI/2;
    lake.position.set(l.x, getY(l.x, l.z)+0.12, l.z);
    scene.add(lake);
    // Edge rocks
    for (let i=0; i<Math.floor(l.r*2.5); i++) {
      const a=(i/(l.r*2.5))*Math.PI*2+rand(-0.2,0.2);
      const rad=l.r-0.5+rand(0,2);
      const rx=l.x+Math.cos(a)*rad, rz=l.z+Math.sin(a)*rad;
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(rand(0.2,0.5),0),
        new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(0,0,rand(0.4,0.6)),roughness:0.9,flatShading:true})
      );
      rock.position.set(rx,getY(rx,rz)+0.1,rz);
      rock.rotation.set(rand(0,3),rand(0,3),rand(0,3));
      rock.castShadow=true;
      scene.add(rock);
    }
  }
}

// ═══════════════════════════════════════
// NATURE CREATORS
// ═══════════════════════════════════════
function createPineTree(x,z,s=1) {
  const g = new THREE.Group();
  const h = rand(1.2,2.0)*s;
  g.add(Object.assign(new THREE.Mesh(
    new THREE.CylinderGeometry(0.12*s,0.22*s,h,6),
    new THREE.MeshStandardMaterial({color:0x6B4226,roughness:0.9})
  ),{position:new THREE.Vector3(0,h/2,0),castShadow:true}));
  const lc=[0x1a6b3a,0x228844,0x2d8a4e,0x1f7a3f];
  for(let i=0;i<4;i++){
    const r=(1.4-i*0.22)*s, lh=(1.1-i*0.1)*s;
    const leaf=new THREE.Mesh(new THREE.ConeGeometry(r,lh,7),new THREE.MeshStandardMaterial({color:lc[i],roughness:0.75,flatShading:true}));
    leaf.position.y=h+i*0.55*s; leaf.castShadow=true;
    g.add(leaf);
  }
  g.position.set(x,getY(x,z),z);
  g.rotation.y=rand(0,6.28);
  scene.add(g);
  return g;
}

function createOakTree(x,z,s=1) {
  const g=new THREE.Group();
  const h=rand(1.5,2.2)*s;
  g.add(Object.assign(new THREE.Mesh(
    new THREE.CylinderGeometry(0.15*s,0.3*s,h,7),
    new THREE.MeshStandardMaterial({color:0x5C3A1E,roughness:0.95,flatShading:true})
  ),{position:new THREE.Vector3(0,h/2,0),castShadow:true}));
  const cc=[0x2d7a3e,0x358844,0x3a9550][randInt(0,2)];
  const cm=new THREE.MeshStandardMaterial({color:cc,roughness:0.7,flatShading:true});
  const mc=new THREE.Mesh(new THREE.IcosahedronGeometry(1.5*s,1),cm);
  mc.position.y=h+0.8*s; mc.castShadow=true;
  const cp=mc.geometry.attributes.position;
  for(let i=0;i<cp.count;i++){cp.setX(i,cp.getX(i)+rand(-0.15,0.15)*s);cp.setY(i,cp.getY(i)+rand(-0.1,0.15)*s);cp.setZ(i,cp.getZ(i)+rand(-0.15,0.15)*s)}
  mc.geometry.computeVertexNormals();
  g.add(mc);
  for(let i=0;i<3;i++){const b=new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.5,0.9)*s,1),cm);b.position.set(rand(-0.8,0.8)*s,h+rand(0.4,1.2)*s,rand(-0.8,0.8)*s);b.castShadow=true;g.add(b)}
  g.position.set(x,getY(x,z),z);
  g.rotation.y=rand(0,6.28);
  scene.add(g);
  return g;
}

function createBirchTree(x,z,s=1) {
  const g=new THREE.Group();
  const h=rand(2,3)*s;
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.08*s,0.14*s,h,6),new THREE.MeshStandardMaterial({color:0xE8DDD0,roughness:0.6})),{position:new THREE.Vector3(0,h/2,0),castShadow:true}));
  const fm=new THREE.MeshStandardMaterial({color:0x88cc44,roughness:0.6,transparent:true,opacity:0.9,flatShading:true});
  for(let i=0;i<4;i++){const l=new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.4,0.7)*s,1),fm);l.position.set(rand(-0.5,0.5)*s,h+rand(-0.2,0.6)*s,rand(-0.5,0.5)*s);l.castShadow=true;g.add(l)}
  g.position.set(x,getY(x,z),z);
  scene.add(g);
  return g;
}

function createRockCluster(x,z,ms=1) {
  const g=new THREE.Group();
  const n=randInt(1,3);
  for(let i=0;i<n;i++){
    const s=ms*rand(0.3,1);
    const geo=new THREE.DodecahedronGeometry(0.5*s,randInt(0,1));
    const rp=geo.attributes.position;
    for(let j=0;j<rp.count;j++){rp.setX(j,rp.getX(j)*rand(0.8,1.2));rp.setY(j,rp.getY(j)*rand(0.7,1));rp.setZ(j,rp.getZ(j)*rand(0.8,1.2))}
    geo.computeVertexNormals();
    const rock=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:[0x777,0x888,0x999,0x6a6a6a][randInt(0,3)],roughness:0.92,flatShading:true}));
    rock.position.set(rand(-0.4,0.4)*ms,0.25*s,rand(-0.4,0.4)*ms);
    rock.rotation.set(rand(0,3),rand(0,3),rand(0,3));
    rock.castShadow=true;rock.receiveShadow=true;
    g.add(rock);
  }
  if(Math.random()>0.4){
    const moss=new THREE.Mesh(new THREE.SphereGeometry(0.2*ms,6,6),new THREE.MeshStandardMaterial({color:0x4a7a3a,roughness:0.9,flatShading:true}));
    moss.position.set(rand(-0.2,0.2),0.3*ms,rand(-0.2,0.2));moss.scale.y=0.4;g.add(moss);
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
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3.2,0.4,3.2),new THREE.MeshStandardMaterial({color:0x777,roughness:0.95,flatShading:true})),{position:new THREE.Vector3(0,0.2,0),castShadow:true}));
  const wm=new THREE.MeshStandardMaterial({color:0xA0722A,roughness:0.85});
  const wm2=new THREE.MeshStandardMaterial({color:0x8B6320,roughness:0.85});
  for(let i=0;i<8;i++){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3,0.22,3),i%2?wm2:wm),{position:new THREE.Vector3(0,0.5+i*0.22,0),castShadow:true}))}
  const rm=new THREE.MeshStandardMaterial({color:0x8B2500,roughness:0.75});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.5,0.12,3.4),rm),{position:new THREE.Vector3(-0.85,2.7,0),rotation:new THREE.Euler(0,0,0.65),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.5,0.12,3.4),rm),{position:new THREE.Vector3(0.85,2.7,0),rotation:new THREE.Euler(0,0,-0.65),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.7,1.4,0.12),new THREE.MeshStandardMaterial({color:0x4a2a0a})),{position:new THREE.Vector3(0,1.1,1.55)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5,1.2,0.5),new THREE.MeshStandardMaterial({color:0x666,roughness:0.9,flatShading:true})),{position:new THREE.Vector3(1,3.3,-0.8),castShadow:true}));
  g.add(new THREE.PointLight(0xff9944,0.5,5));
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
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.2,0.3,3.2),new THREE.MeshStandardMaterial({color:0x666,roughness:0.95,flatShading:true})),{position:new THREE.Vector3(0,0.15,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2.8,3),new THREE.MeshStandardMaterial({color:0xBB3333,roughness:0.8})),{position:new THREE.Vector3(0,1.7,0),castShadow:true}));
  const rm=new THREE.MeshStandardMaterial({color:0x5C3A1E,roughness:0.75});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.12,3.4),rm),{position:new THREE.Vector3(-1.2,3.5,0),rotation:new THREE.Euler(0,0,0.55),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.12,3.4),rm),{position:new THREE.Vector3(1.2,3.5,0),rotation:new THREE.Euler(0,0,-0.55),castShadow:true}));
  g.add(new THREE.PointLight(0xffaa44,0.3,5));
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
  const glassMat=new THREE.MeshPhysicalMaterial({color:0xaaddff,transparent:true,opacity:0.3,roughness:0.05,metalness:0.1,clearcoat:0.8});
  const frameMat=new THREE.MeshStandardMaterial({color:0xdddddd,metalness:0.6,roughness:0.3});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,0.1,3.5),new THREE.MeshStandardMaterial({color:0x666})),{position:new THREE.Vector3(0,0.05,0)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2,0.05),glassMat),{position:new THREE.Vector3(0,1.05,1.75)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2,0.05),glassMat),{position:new THREE.Vector3(0,1.05,-1.75)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.05,2,3.5),glassMat),{position:new THREE.Vector3(-2,1.05,0)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.05,2,3.5),glassMat),{position:new THREE.Vector3(2,1.05,0)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.2,0.05,3.6),glassMat),{position:new THREE.Vector3(-1,2.3,0),rotation:new THREE.Euler(0,0,0.3)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.2,0.05,3.6),glassMat),{position:new THREE.Vector3(1,2.3,0),rotation:new THREE.Euler(0,0,-0.3)}));
  const plantMat=new THREE.MeshStandardMaterial({color:0x33aa33,roughness:0.7});
  for(let i=0;i<8;i++){
    const plant=new THREE.Group();
    plant.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,rand(0.6,1.2),5),plantMat),{position:new THREE.Vector3(0,0.4,0)}));
    for(let j=0;j<randInt(1,3);j++){
      plant.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.08,6,6),new THREE.MeshStandardMaterial({color:0xff3333,roughness:0.4})),{position:new THREE.Vector3(rand(-0.1,0.1),rand(0.3,0.8),rand(-0.1,0.1))}));
    }
    plant.position.set(-1.5+i*0.45,0.1,rand(-1,1));
    g.add(plant);
  }
  g.add(Object.assign(new THREE.PointLight(0xff9944,0.3,4),{position:new THREE.Vector3(0,1.5,0)}));
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
  // Flag pole
  g.add(Object.assign(new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 4, 6),
    new THREE.MeshStandardMaterial({color:0xcccccc, metalness:0.5})
  ),{position:new THREE.Vector3(0,2,0)}));
  // Flag
  const flagColor = new THREE.Color(color);
  g.add(Object.assign(new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1),
    new THREE.MeshStandardMaterial({color:flagColor, side:THREE.DoubleSide, emissive:flagColor, emissiveIntensity:0.3})
  ),{position:new THREE.Vector3(0.75,3.5,0)}));
  // Name ring on ground
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.8, 32),
    new THREE.MeshBasicMaterial({color:flagColor, transparent:true, opacity:0.3, side:THREE.DoubleSide})
  );
  ring.rotation.x = -Math.PI/2;
  ring.position.y = 0.1;
  g.add(ring);
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
// CLOUDS
// ═══════════════════════════════════════
const clouds = [];
function spawnClouds() {
  const cloudMat = new THREE.MeshStandardMaterial({color:0xffffff, transparent:true, opacity:0.4, roughness:1});
  for(let i=0; i<(isMobile?10:20); i++){
    const g = new THREE.Group();
    const n = randInt(3,6);
    for(let j=0;j<n;j++){
      const s = rand(2,5);
      const blob = new THREE.Mesh(new THREE.SphereGeometry(s,6,6), cloudMat);
      blob.position.set(rand(-3,3), rand(-0.5,0.5), rand(-2,2));
      blob.scale.y = 0.4;
      g.add(blob);
    }
    g.position.set(rand(-MAP_SIZE/2, MAP_SIZE/2), rand(25,40), rand(-MAP_SIZE/2, MAP_SIZE/2));
    scene.add(g);
    clouds.push(g);
  }
}

// ═══════════════════════════════════════
// GHOST (free placement)
// ═══════════════════════════════════════
function showGhostForKey(key) {
  removeGhost();
  const bdef = serverBuildings[key];
  if(!bdef) return;
  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(bdef.size[0], 2.5, bdef.size[1]),
    new THREE.MeshStandardMaterial({ color:0x4CAF50, transparent:true, opacity:0.2 })
  );
  const wire = new THREE.Mesh(new THREE.BoxGeometry(bdef.size[0], 2.5, bdef.size[1]),
    new THREE.MeshBasicMaterial({ color:0x66bb6a, wireframe:true, transparent:true, opacity:0.35 })
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

  // Clouds
  for(const c of clouds) {
    c.position.x += dt * 1.5;
    if(c.position.x > MAP_SIZE/2 + 20) c.position.x = -MAP_SIZE/2 - 20;
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
