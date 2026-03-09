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

// ═══════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════
const R = { wood:0, stone:0, water:0, food:0, energy:0, gold:0, data:0 };
let gameTime=0, dayCount=1, gameStarted=false;
let selectedBuilding=null, selectedIoT=null;
let currentTab='build';
let buildingGhost=null;

// ═══════════════════════════════════════
// BUILDING DEFINITIONS
// ═══════════════════════════════════════
const BUILDINGS = {
  cabin:{ name:'Cabane',icon:'🏡',cost:{wood:8,stone:4},desc:'Abri de base',size:[3,3],unlocked:true,built:false,production:null,prerequisite:null,category:'farm' },
  well:{ name:'Puits',icon:'🪣',cost:{wood:5,stone:6},desc:'+2 eau/cycle',size:[2,2],unlocked:false,built:false,production:{water:2},prerequisite:'cabin',category:'farm' },
  field:{ name:'Champ de Ble',icon:'🌾',cost:{wood:6,stone:3},desc:'+3 food/cycle',size:[5,5],unlocked:false,built:false,production:{food:3},consumption:{water:1},prerequisite:'well',category:'farm' },
  barn:{ name:'Grange',icon:'🏚️',cost:{wood:18,stone:10},desc:'Stockage +100',size:[4,3],unlocked:false,built:false,production:null,prerequisite:'field',category:'farm' },
  coop:{ name:'Poulailler',icon:'🐔',cost:{wood:12,stone:5,food:8},desc:'+2 gold/cycle',size:[3,3],unlocked:false,built:false,production:{gold:2},consumption:{food:2},prerequisite:'barn',category:'farm' },
  greenhouse:{ name:'Serre',icon:'🍅',cost:{wood:20,stone:15,gold:5},desc:'+4 food/cycle',size:[4,4],unlocked:false,built:false,production:{food:4},consumption:{water:2},prerequisite:'barn',category:'farm' },
  pasture:{ name:'Enclos Vaches',icon:'🐄',cost:{wood:25,stone:12,food:15},desc:'+3 gold/cycle',size:[5,5],unlocked:false,built:false,production:{gold:3},consumption:{food:3},prerequisite:'coop',category:'farm' },
  silo:{ name:'Silo a Grains',icon:'🏗️',cost:{wood:22,stone:18,gold:8},desc:'Auto-vente a 95%',size:[3,3],unlocked:false,built:false,production:{gold:1},prerequisite:'greenhouse',category:'farm' },
  windmill:{ name:'Moulin',icon:'⚙️',cost:{wood:28,stone:20,gold:10},desc:'x2 food!',size:[3,3],unlocked:false,built:false,production:{food:6},consumption:{water:1},prerequisite:'silo',category:'farm' },
  solar:{ name:'Panneaux Solaires',icon:'☀️',cost:{stone:15,gold:12},desc:'+5 energy/cycle',size:[4,3],unlocked:false,built:false,production:{energy:5},prerequisite:'cabin',category:'tech' },
  antenna:{ name:'Antenne Relais',icon:'📡',cost:{stone:10,gold:8,energy:5},desc:'Reseau IoT +15m',size:[2,2],unlocked:false,built:false,production:{data:1},prerequisite:'solar',category:'tech',coverageRadius:18 },
  server:{ name:'Salle Serveur',icon:'🖥️',cost:{stone:20,gold:20,energy:10},desc:'Traite la data',size:[3,3],unlocked:false,built:false,production:{data:3},consumption:{energy:3},prerequisite:'antenna',category:'tech' }
};

// ═══════════════════════════════════════
// IoT SENSOR DEFINITIONS
// ═══════════════════════════════════════
const IOT_SENSORS = {
  humidity:{ name:'Capteur Humidite',icon:'💧',cost:{gold:5,data:10},desc:'Notifie sol sec. +15% eau.',targets:['well','field'],bonus:{water:0.15},dataGen:0.5 },
  flow:{ name:'Debitmetre',icon:'🔄',cost:{gold:8,data:15},desc:'Detecte fuites. -20% pertes.',targets:['well'],bonus:{water:0.2},dataGen:0.8 },
  vibration:{ name:'Capteur Vibration',icon:'📳',cost:{gold:6,data:12},desc:'Maintenance predictive.',targets:['windmill','well','silo'],bonus:{maintenance:0.5},dataGen:0.6 },
  spectrum:{ name:'Capteur Spectre',icon:'🌈',cost:{gold:10,data:20},desc:'+30% vitesse culture.',targets:['greenhouse'],bonus:{food:0.3},dataGen:1.0 },
  weight:{ name:'Capteur Poids',icon:'⚖️',cost:{gold:7,data:12},desc:'Auto-vente optimale.',targets:['silo','barn'],bonus:{gold:0.25},dataGen:0.7 },
  collar:{ name:'Collier Connecte',icon:'📿',cost:{gold:12,data:18},desc:'Sante animale. -50% maladies.',targets:['coop','pasture'],bonus:{gold:0.2,maintenance:0.3},dataGen:0.9 },
  smartflow:{ name:'IA Smart-Flow',icon:'🤖',cost:{gold:15,data:30},desc:'Optimise pompe. -20% elec.',targets:['well','greenhouse'],bonus:{energy:-0.2,water:0.25},dataGen:1.5 },
  smartgrow:{ name:'IA CropMind',icon:'🧠',cost:{gold:20,data:40},desc:'+40% rendement cultures.',targets:['field','greenhouse'],bonus:{food:0.4},dataGen:2.0 }
};

// ═══════════════════════════════════════
// TECH TREE (Hardware / Software per building)
// ═══════════════════════════════════════
const TECH_TREE = {
  well: {
    hw: [
      { id:'well_hw1',name:'Pompe a bras',icon:'🔧',cost:{wood:5,stone:3},bonus:{water:0.1},desc:'Manuel. +10% eau.' },
      { id:'well_hw2',name:'Pompe electrique',icon:'⚡',cost:{gold:8,energy:5},bonus:{water:0.3},desc:'Auto. +30% eau.',requires:'well_hw1' },
      { id:'well_hw3',name:'Reservoir pressurise',icon:'🔵',cost:{gold:15,stone:10},bonus:{water:0.5},desc:'+50% debit.',requires:'well_hw2' }
    ],
    sw: [
      { id:'well_sw1',name:'Module Humidite',icon:'💧',cost:{data:10,gold:5},bonus:{water:0.15},desc:'Alerte sol sec.' },
      { id:'well_sw2',name:'Debitmetre IoT',icon:'📊',cost:{data:20,gold:8},bonus:{water:0.2},desc:'Detecte fuites.',requires:'well_sw1' },
      { id:'well_sw3',name:'IA Smart-Flow',icon:'🤖',cost:{data:40,gold:15},bonus:{water:0.35},desc:'-20% elec, optimal.',requires:'well_sw2' }
    ]
  },
  field: {
    hw: [
      { id:'field_hw1',name:'Irrigation goutte',icon:'💦',cost:{wood:8,stone:5},bonus:{food:0.15},desc:'+15% rendement.' },
      { id:'field_hw2',name:'Tracteur auto',icon:'🚜',cost:{gold:12,energy:5},bonus:{food:0.3},desc:'Recolte auto.',requires:'field_hw1' },
      { id:'field_hw3',name:'Serre hydroponique',icon:'🏭',cost:{gold:25,stone:15},bonus:{food:0.5},desc:'+50% food.',requires:'field_hw2' }
    ],
    sw: [
      { id:'field_sw1',name:'Sonde sol',icon:'🌡️',cost:{data:12,gold:5},bonus:{food:0.15},desc:'pH + nutriments.' },
      { id:'field_sw2',name:'Drone cartographe',icon:'🛸',cost:{data:25,gold:10},bonus:{food:0.25},desc:'Heatmap cultures.',requires:'field_sw1' },
      { id:'field_sw3',name:'IA CropMind',icon:'🧠',cost:{data:50,gold:20},bonus:{food:0.4},desc:'Prediction recolte.',requires:'field_sw2' }
    ]
  },
  greenhouse: {
    hw: [
      { id:'gh_hw1',name:'LED horticoles',icon:'💡',cost:{gold:8,energy:5},bonus:{food:0.2},desc:'+20% croissance.' },
      { id:'gh_hw2',name:'Climatisation',icon:'❄️',cost:{gold:15,energy:8},bonus:{food:0.35},desc:'Temp. optimale.',requires:'gh_hw1' }
    ],
    sw: [
      { id:'gh_sw1',name:'Capteur spectre',icon:'🌈',cost:{data:15,gold:8},bonus:{food:0.3},desc:'+30% lumiere.' },
      { id:'gh_sw2',name:'IA GreenGenius',icon:'🤖',cost:{data:35,gold:18},bonus:{food:0.45},desc:'Optimise tout.',requires:'gh_sw1' }
    ]
  },
  pasture: {
    hw: [
      { id:'past_hw1',name:'Abreuvoir auto',icon:'🚰',cost:{wood:10,stone:5},bonus:{gold:0.15},desc:'+15% lait.' },
      { id:'past_hw2',name:'Robot de traite',icon:'🦾',cost:{gold:20,energy:8},bonus:{gold:0.35},desc:'Traite 24/7.',requires:'past_hw1' }
    ],
    sw: [
      { id:'past_sw1',name:'Collier sante',icon:'📿',cost:{data:15,gold:10},bonus:{gold:0.2,maintenance:0.3},desc:'Alerte maladie.' },
      { id:'past_sw2',name:'IA HerdMind',icon:'🧠',cost:{data:40,gold:20},bonus:{gold:0.4},desc:'Gestion troupeau IA.',requires:'past_sw1' }
    ]
  },
  silo: {
    hw: [
      { id:'silo_hw1',name:'Convoyeur auto',icon:'🔄',cost:{gold:10,energy:5},bonus:{gold:0.2},desc:'Transport auto.' }
    ],
    sw: [
      { id:'silo_sw1',name:'Capteur poids',icon:'⚖️',cost:{data:12,gold:7},bonus:{gold:0.25},desc:'Vente a 95%.' },
      { id:'silo_sw2',name:'IA MarketBot',icon:'📈',cost:{data:30,gold:15},bonus:{gold:0.4},desc:'Vend au meilleur prix.',requires:'silo_sw1' }
    ]
  },
  windmill: {
    hw: [
      { id:'wm_hw1',name:'Pales carbone',icon:'🔧',cost:{gold:12,stone:8},bonus:{food:0.2},desc:'+20% rendement.' }
    ],
    sw: [
      { id:'wm_sw1',name:'Capteur vent',icon:'🌬️',cost:{data:10,gold:5},bonus:{food:0.15},desc:'Orientation auto.' },
      { id:'wm_sw2',name:'IA WindMax',icon:'🤖',cost:{data:25,gold:12},bonus:{food:0.3},desc:'Max efficacite.',requires:'wm_sw1' }
    ]
  }
};

const unlockedTech = new Set();
const builtStructures = [];
const installedSensors = {}; // buildingKey -> [sensorKey]
const harvestables = [];
const productionTimers = {};
const PRODUCTION_INTERVAL = 8;
const particles = [];
const smokeParticles = [];
const animatedObjects = [];
const buildingHealth = {}; // buildingKey -> 0-100
const logs = [];
let networkCoverage = 0;

// ═══════════════════════════════════════
// THREE.JS SETUP
// ═══════════════════════════════════════
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 800);
camera.position.set(35, 28, 35);

const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.25, 0.5, 0.85);
composer.addPass(bloomPass);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI / 2.15;
controls.minDistance = 8;
controls.maxDistance = 80;
controls.target.set(0, 0, 0);

// ═══════════════════════════════════════
// LIGHTING
// ═══════════════════════════════════════
const ambientLight = new THREE.AmbientLight(0x8899bb, 0.4);
scene.add(ambientLight);
const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.8);
sunLight.position.set(25, 35, 20);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
sunLight.shadow.camera.left = -50;
sunLight.shadow.camera.right = 50;
sunLight.shadow.camera.top = 50;
sunLight.shadow.camera.bottom = -50;
sunLight.shadow.bias = -0.0002;
scene.add(sunLight);
const hemiLight = new THREE.HemisphereLight(0x99ccff, 0x337722, 0.3);
scene.add(hemiLight);
const fillLight = new THREE.DirectionalLight(0x6688cc, 0.25);
fillLight.position.set(-20, 12, -15);
scene.add(fillLight);

scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.FogExp2(0x87CEEB, 0.005);

// ═══════════════════════════════════════
// TERRAIN (bigger map: 120x120)
// ═══════════════════════════════════════
const GROUND_SIZE = 120;
const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 100, 100);
const gp = groundGeo.attributes.position;
const gColors = new Float32Array(gp.count * 3);

function terrainHeight(x, z) {
  return Math.sin(x*0.1)*Math.cos(z*0.08)*0.8
    + Math.sin(x*0.05+1)*Math.cos(z*0.04+2)*1.2
    + Math.sin(x*0.25)*Math.cos(z*0.3)*0.2;
}

for (let i=0; i<gp.count; i++) {
  const x=gp.getX(i), y=gp.getY(i);
  const h = terrainHeight(x, y);
  gp.setZ(i, h);
  const t = (h+2)/4;
  gColors[i*3] = lerp(0.18,0.35,t)+rand(-0.02,0.02);
  gColors[i*3+1] = lerp(0.28,0.58,t)+rand(-0.02,0.02);
  gColors[i*3+2] = lerp(0.1,0.2,t)+rand(-0.01,0.01);
}
groundGeo.setAttribute('color', new THREE.BufferAttribute(gColors, 3));
groundGeo.computeVertexNormals();
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.95 }));
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);

function getY(x, z) { return terrainHeight(x, z); }

// ═══════════════════════════════════════
// WATER (lake + stream)
// ═══════════════════════════════════════
const waterMat = new THREE.MeshPhysicalMaterial({
  color:0x2288cc, roughness:0.05, metalness:0.1,
  transparent:true, opacity:0.72, clearcoat:1.0
});
// Main lake
const lake = new THREE.Mesh(new THREE.CircleGeometry(7, 48), waterMat);
lake.rotation.x = -Math.PI/2;
lake.position.set(-22, getY(-22,15)+0.12, 15);
scene.add(lake);
// Smaller pond
const pond = new THREE.Mesh(new THREE.CircleGeometry(3.5, 32), waterMat.clone());
pond.rotation.x = -Math.PI/2;
pond.position.set(25, getY(25,-20)+0.1, -20);
scene.add(pond);

// Lake edge rocks
for (let i=0; i<20; i++) {
  const a=(i/20)*Math.PI*2+rand(-0.2,0.2);
  const r=6.5+rand(0,2);
  const x=-22+Math.cos(a)*r, z=15+Math.sin(a)*r;
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(rand(0.2,0.5),0),
    new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(0,0,rand(0.4,0.6)),roughness:0.9,flatShading:true})
  );
  rock.position.set(x,getY(x,z)+0.1,z);
  rock.rotation.set(rand(0,3),rand(0,3),rand(0,3));
  rock.castShadow=true;
  scene.add(rock);
}

// ═══════════════════════════════════════
// NATURE: Trees, Rocks, Flowers, Grass
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
    const rock=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:[0x777,0x888,0x999,0x6a6a6a][randInt(0,3)]*0x111,roughness:0.92,flatShading:true}));
    rock.position.set(rand(-0.4,0.4)*ms,0.25*s,rand(-0.4,0.4)*ms);
    rock.rotation.set(rand(0,3),rand(0,3),rand(0,3));
    rock.castShadow=true;
    g.add(rock);
  }
  g.position.set(x,getY(x,z),z);
  scene.add(g);
  return g;
}

// Spawn nature — much more on bigger map
function spawnNature() {
  // Trees: ~60
  const treeZones = [];
  for(let i=0;i<60;i++) {
    let x,z;
    do { x=rand(-50,50); z=rand(-50,50); } while(Math.sqrt((x+22)**2+(z-15)**2)<9 || Math.sqrt(x**2+z**2)<6);
    treeZones.push([x,z]);
  }
  for(const [bx,bz] of treeZones) {
    const x=bx+rand(-1.5,1.5), z=bz+rand(-1.5,1.5), s=rand(0.7,1.4);
    const type=randInt(0,2);
    const tree = type===0?createPineTree(x,z,s):type===1?createOakTree(x,z,s):createBirchTree(x,z,s);
    harvestables.push({type:'tree',mesh:tree,hp:3,maxHp:3,resource:'wood',amount:3});
  }
  // Rocks: ~30
  for(let i=0;i<30;i++) {
    let x,z;
    do { x=rand(-45,45); z=rand(-45,45); } while(Math.sqrt(x**2+z**2)<5);
    const s=rand(0.6,1.5);
    const rock=createRockCluster(x+rand(-1,1),z+rand(-1,1),s);
    harvestables.push({type:'rock',mesh:rock,hp:3,maxHp:3,resource:'stone',amount:2});
  }
}
spawnNature();

// Instanced grass
{
  const bg=new THREE.BufferGeometry();
  bg.setAttribute('position',new THREE.BufferAttribute(new Float32Array([-0.04,0,0,0.04,0,0,0,0.4,0.02,0.04,0,0,0,0.4,0.02,0,0.35,-0.02]),3));
  bg.computeVertexNormals();
  const gm=new THREE.MeshStandardMaterial({color:0x4a9a3a,roughness:0.8,side:THREE.DoubleSide,flatShading:true});
  const count=4000;
  const mesh=new THREE.InstancedMesh(bg,gm,count);
  const mat=new THREE.Matrix4(),col=new THREE.Color();
  for(let i=0;i<count;i++){
    const x=rand(-50,50),z=rand(-50,50);
    if(Math.sqrt((x+22)**2+(z-15)**2)<8) continue;
    const s=rand(0.5,1.5);
    mat.makeRotationY(rand(0,6.28));
    mat.scale(new THREE.Vector3(s,s,s));
    mat.setPosition(x,getY(x,z),z);
    mesh.setMatrixAt(i,mat);
    col.setRGB(rand(0.15,0.3),rand(0.35,0.65),rand(0.1,0.2));
    mesh.setColorAt(i,col);
  }
  mesh.instanceMatrix.needsUpdate=true;
  mesh.instanceColor.needsUpdate=true;
  mesh.receiveShadow=true;
  scene.add(mesh);
}

// Flowers
for(let i=0;i<80;i++){
  const x=rand(-45,45),z=rand(-45,45);
  if(Math.sqrt((x+22)**2+(z-15)**2)<8) continue;
  const g=new THREE.Group();
  const fc=[0xff6b9d,0xffd93d,0xff8a5c,0xc9b1ff,0xff4444,0xffffff][randInt(0,5)];
  const stem=new THREE.Mesh(new THREE.CylinderGeometry(0.01,0.015,rand(0.2,0.4),4),new THREE.MeshStandardMaterial({color:0x3a7a2a}));
  stem.position.y=0.15;g.add(stem);
  for(let p=0;p<randInt(4,6);p++){
    const petal=new THREE.Mesh(new THREE.SphereGeometry(0.06,5,5),new THREE.MeshStandardMaterial({color:fc,roughness:0.5}));
    const a=(p/5)*6.28;
    petal.position.set(Math.cos(a)*0.08,0.32,Math.sin(a)*0.08);petal.scale.y=0.5;g.add(petal);
  }
  g.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.04,5,5),new THREE.MeshStandardMaterial({color:0xFFD700})),{position:new THREE.Vector3(0,0.32,0)}));
  g.position.set(x,getY(x,z),z);
  scene.add(g);
}

// Clouds
const cloudGroup=new THREE.Group();
for(let i=0;i<12;i++){
  const cg=new THREE.Group();
  const cm=new THREE.MeshStandardMaterial({color:0xffffff,roughness:1,transparent:true,opacity:0.65,flatShading:true});
  for(let j=0;j<randInt(3,6);j++){
    const b=new THREE.Mesh(new THREE.IcosahedronGeometry(rand(1.5,3.5),1),cm);
    b.position.set(rand(-3,3),rand(-0.5,0.5),rand(-1.5,1.5));b.scale.y=rand(0.3,0.5);
    cg.add(b);
  }
  cg.position.set(rand(-70,70),rand(28,45),rand(-60,60));
  cg._speed=rand(0.2,0.6);
  cloudGroup.add(cg);
}
scene.add(cloudGroup);

// ═══════════════════════════════════════
// BUILDING POSITIONS (spread out on bigger map)
// ═══════════════════════════════════════
const buildingPositions = {
  cabin: new THREE.Vector3(0,0,0),
  well: new THREE.Vector3(-6,0,2),
  field: new THREE.Vector3(8,0,3),
  barn: new THREE.Vector3(0,0,-8),
  coop: new THREE.Vector3(-8,0,-6),
  greenhouse: new THREE.Vector3(8,0,-8),
  pasture: new THREE.Vector3(-14,0,0),
  silo: new THREE.Vector3(14,0,-5),
  windmill: new THREE.Vector3(8,0,-16),
  solar: new THREE.Vector3(-8,0,10),
  antenna: new THREE.Vector3(0,0,12),
  server: new THREE.Vector3(-14,0,-10)
};
for(const [k,p] of Object.entries(buildingPositions)) p.y=getY(p.x,p.z);

// ═══════════════════════════════════════
// BUILDING MESH CREATORS
// ═══════════════════════════════════════
function addSensorVisual(group, sensorKey) {
  // Small IoT device on building
  const sensor = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.2,0.12,0.15),
    new THREE.MeshStandardMaterial({color:0x222222,metalness:0.5,roughness:0.3})
  );
  sensor.add(box);
  // LED
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.03,6,6),
    new THREE.MeshStandardMaterial({color:0x00ff88,emissive:0x00ff88,emissiveIntensity:2})
  );
  led.position.set(0.06,0.07,0);
  sensor.add(led);
  // Antenna
  const ant = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008,0.008,0.2,4),
    new THREE.MeshStandardMaterial({color:0x444444,metalness:0.7})
  );
  ant.position.set(-0.06,0.15,0);
  sensor.add(ant);

  const sensorDef = IOT_SENSORS[sensorKey];
  sensor.position.set(rand(-0.5,0.5), 2.5 + rand(0,0.5), rand(-0.5,0.5));
  group.add(sensor);

  // Pulse ring effect
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.15,0.2,16),
    new THREE.MeshBasicMaterial({color:0x00ccff,transparent:true,opacity:0.5,side:THREE.DoubleSide})
  );
  ring.rotation.x = -Math.PI/2;
  ring.position.copy(sensor.position);
  ring.position.y += 0.1;
  group.add(ring);
  animatedObjects.push({type:'pulse',mesh:ring,phase:rand(0,6.28)});

  return sensor;
}

function createCabin(pos) {
  const g=new THREE.Group();
  // Foundation
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3.2,0.4,3.2),new THREE.MeshStandardMaterial({color:0x777,roughness:0.95,flatShading:true})),{position:new THREE.Vector3(0,0.2,0),castShadow:true}));
  // Log walls
  const wm=new THREE.MeshStandardMaterial({color:0xA0722A,roughness:0.85});
  const wm2=new THREE.MeshStandardMaterial({color:0x8B6320,roughness:0.85});
  for(let i=0;i<8;i++){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3,0.22,3),i%2?wm2:wm),{position:new THREE.Vector3(0,0.5+i*0.22,0),castShadow:true}))}
  // Roof
  const rm=new THREE.MeshStandardMaterial({color:0x8B2500,roughness:0.75});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.5,0.12,3.4),rm),{position:new THREE.Vector3(-0.85,2.7,0),rotation:new THREE.Euler(0,0,0.65),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.5,0.12,3.4),rm),{position:new THREE.Vector3(0.85,2.7,0),rotation:new THREE.Euler(0,0,-0.65),castShadow:true}));
  // Door + windows
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.7,1.4,0.12),new THREE.MeshStandardMaterial({color:0x4a2a0a})),{position:new THREE.Vector3(0,1.1,1.55)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.04,6,6),new THREE.MeshStandardMaterial({color:0xccaa44,metalness:0.8,roughness:0.2})),{position:new THREE.Vector3(0.2,1.1,1.62)}));
  for(const s of [-1,1]){
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.12,0.6,0.5),new THREE.MeshStandardMaterial({color:0x4a2a0a})),{position:new THREE.Vector3(s*1.55,1.4,0)}));
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.05,0.45,0.35),new THREE.MeshStandardMaterial({color:0x88bbdd,transparent:true,opacity:0.5})),{position:new THREE.Vector3(s*1.55,1.4,0)}));
  }
  // Chimney
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5,1.2,0.5),new THREE.MeshStandardMaterial({color:0x666,roughness:0.9,flatShading:true})),{position:new THREE.Vector3(1,3.3,-0.8),castShadow:true}));
  g.add(new THREE.PointLight(0xff9944,0.5,5));
  g._chimneyPos=new THREE.Vector3(pos.x+1,pos.y+3.9,pos.z-0.8);
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
  const rm=new THREE.MeshStandardMaterial({color:0x8B4513,roughness:0.8});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.9,0.06,1),rm),{position:new THREE.Vector3(-0.3,2.8,0),rotation:new THREE.Euler(0,0,0.4)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.9,0.06,1),rm),{position:new THREE.Vector3(0.3,2.8,0),rotation:new THREE.Euler(0,0,-0.4)}));
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
  // Fence
  const fm=new THREE.MeshStandardMaterial({color:0x9a7a4a,roughness:0.85});
  for(const sz of [-2.4,2.4]){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.8,0.04,0.04),fm),{position:new THREE.Vector3(0,0.4,sz)}))}
  for(const sx of [-2.4,2.4]){g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.04,0.04,4.8),fm),{position:new THREE.Vector3(sx,0.4,0)}))}
  g.position.copy(pos);scene.add(g);return g;
}

function createBarn(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.2,0.3,3.2),new THREE.MeshStandardMaterial({color:0x666,roughness:0.95,flatShading:true})),{position:new THREE.Vector3(0,0.15,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2.8,3),new THREE.MeshStandardMaterial({color:0xBB3333,roughness:0.8})),{position:new THREE.Vector3(0,1.7,0),castShadow:true}));
  const rm=new THREE.MeshStandardMaterial({color:0x5C3A1E,roughness:0.75});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.12,3.4),rm),{position:new THREE.Vector3(-1.2,3.5,0),rotation:new THREE.Euler(0,0,0.55),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.12,3.4),rm),{position:new THREE.Vector3(1.2,3.5,0),rotation:new THREE.Euler(0,0,-0.55),castShadow:true}));
  for(const s of [-0.45,0.45])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.8,2.2,0.12),new THREE.MeshStandardMaterial({color:0x5C2E00})),{position:new THREE.Vector3(s,1.4,1.55),castShadow:true}));
  const tm=new THREE.MeshStandardMaterial({color:0xeee});
  for(const r of [Math.PI/4,-Math.PI/4])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.06,2.6,0.05),tm),{position:new THREE.Vector3(0,1.4,1.58),rotation:new THREE.Euler(0,0,r)}));
  g.add(new THREE.PointLight(0xffaa44,0.3,5));
  g.position.copy(pos);scene.add(g);return g;
}

function createCoop(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.8,0.15,2.2),new THREE.MeshStandardMaterial({color:0x7a5a30})),{position:new THREE.Vector3(0,0.4,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.6,1.2,2),new THREE.MeshStandardMaterial({color:0xDEB887,roughness:0.8})),{position:new THREE.Vector3(0,1.08,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.8,0.08,2.3),new THREE.MeshStandardMaterial({color:0x8B2500})),{position:new THREE.Vector3(-0.6,1.9,0),rotation:new THREE.Euler(0,0,0.35),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.8,0.08,2.3),new THREE.MeshStandardMaterial({color:0x8B2500})),{position:new THREE.Vector3(0.6,1.9,0),rotation:new THREE.Euler(0,0,-0.35)}));
  // Chickens
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
  // Glass structure
  const glassMat=new THREE.MeshPhysicalMaterial({color:0xaaddff,transparent:true,opacity:0.3,roughness:0.05,metalness:0.1,clearcoat:0.8});
  const frameMat=new THREE.MeshStandardMaterial({color:0xdddddd,metalness:0.6,roughness:0.3});
  // Base frame
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,0.1,3.5),new THREE.MeshStandardMaterial({color:0x666})),{position:new THREE.Vector3(0,0.05,0)}));
  // Walls
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2,0.05),glassMat),{position:new THREE.Vector3(0,1.05,1.75)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4,2,0.05),glassMat),{position:new THREE.Vector3(0,1.05,-1.75)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.05,2,3.5),glassMat),{position:new THREE.Vector3(-2,1.05,0)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.05,2,3.5),glassMat),{position:new THREE.Vector3(2,1.05,0)}));
  // Roof (arched)
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.2,0.05,3.6),glassMat),{position:new THREE.Vector3(-1,2.3,0),rotation:new THREE.Euler(0,0,0.3)}));
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(2.2,0.05,3.6),glassMat),{position:new THREE.Vector3(1,2.3,0),rotation:new THREE.Euler(0,0,-0.3)}));
  // Frame ribs
  for(const x of [-2,-1,0,1,2])g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.05,2,0.05),frameMat),{position:new THREE.Vector3(x,1.05,1.75)}));
  // Plants inside
  const plantMat=new THREE.MeshStandardMaterial({color:0x33aa33,roughness:0.7});
  for(let i=0;i<8;i++){
    const plant=new THREE.Group();
    plant.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,rand(0.6,1.2),5),plantMat),{position:new THREE.Vector3(0,0.4,0)}));
    // Tomatoes
    for(let j=0;j<randInt(1,3);j++){
      plant.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.08,6,6),new THREE.MeshStandardMaterial({color:0xff3333,roughness:0.4})),{position:new THREE.Vector3(rand(-0.1,0.1),rand(0.3,0.8),rand(-0.1,0.1))}));
    }
    plant.position.set(-1.5+i*0.45,0.1,rand(-1,1));
    g.add(plant);
  }
  // Warm light
  g.add(Object.assign(new THREE.PointLight(0xff9944,0.3,4),{position:new THREE.Vector3(0,1.5,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createPasture(pos) {
  const g=new THREE.Group();
  // Grass area
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(5,0.1,5),new THREE.MeshStandardMaterial({color:0x4a8f3f,roughness:0.95})),{position:new THREE.Vector3(0,0.05,0),receiveShadow:true}));
  // Fence
  const fm=new THREE.MeshStandardMaterial({color:0x8a6a3a,roughness:0.85});
  for(const z of [-2.6,2.6]){
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(5.2,0.04,0.04),fm),{position:new THREE.Vector3(0,0.4,z)}));
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(5.2,0.04,0.04),fm),{position:new THREE.Vector3(0,0.7,z)}));
  }
  for(const x of [-2.6,2.6]){
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.04,0.04,5.2),fm),{position:new THREE.Vector3(x,0.4,0)}));
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.04,0.04,5.2),fm),{position:new THREE.Vector3(x,0.7,0)}));
  }
  // Cows
  for(let i=0;i<3;i++){
    const cow=new THREE.Group();
    const bodyMat=new THREE.MeshStandardMaterial({color:i===0?0xffffff:i===1?0x8B4513:0x222222,roughness:0.7});
    cow.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.7,0.5,0.4),bodyMat),{position:new THREE.Vector3(0,0.45,0)}));
    cow.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.35),bodyMat),{position:new THREE.Vector3(0.4,0.55,0)}));
    // Legs
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
  // Rings
  for(let i=0;i<4;i++){
    g.add(Object.assign(new THREE.Mesh(new THREE.TorusGeometry(1.22,0.04,6,10),new THREE.MeshStandardMaterial({color:0x888,metalness:0.5})),{position:new THREE.Vector3(0,0.5+i*0.9,0),rotation:new THREE.Euler(Math.PI/2,0,0)}));
  }
  g.position.copy(pos);scene.add(g);return g;
}

function createWindmill(pos) {
  const g=new THREE.Group();
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(1,1.4,3.5,8),new THREE.MeshStandardMaterial({color:0xf0e8d8,roughness:0.7})),{position:new THREE.Vector3(0,2.75,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(1.4,1.6,1,8),new THREE.MeshStandardMaterial({color:0x777,roughness:0.95,flatShading:true})),{position:new THREE.Vector3(0,0.5,0),castShadow:true}));
  g.add(Object.assign(new THREE.Mesh(new THREE.ConeGeometry(1.2,1.5,8),new THREE.MeshStandardMaterial({color:0x6a3a1a,roughness:0.75})),{position:new THREE.Vector3(0,5.2,0),castShadow:true}));
  // Blades
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
  for(let row=0;row<2;row++){
    for(let col=0;col<3;col++){
      const panel=new THREE.Group();
      panel.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.2,0.06,0.9),panelMat),{castShadow:true}));
      // Frame
      panel.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.25,0.02,0.04),frameMat),{position:new THREE.Vector3(0,0.03,0.45)}));
      panel.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1.25,0.02,0.04),frameMat),{position:new THREE.Vector3(0,0.03,-0.45)}));
      // Support leg
      panel.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,0.8,5),frameMat),{position:new THREE.Vector3(0,-0.35,-0.2),rotation:new THREE.Euler(0.2,0,0)}));
      panel.position.set(-1.3+col*1.3, 0.7, -0.6+row*1.2);
      panel.rotation.x = -0.5;
      g.add(panel);
    }
  }
  // Glowing edge
  g.add(Object.assign(new THREE.PointLight(0x4488ff,0.3,4),{position:new THREE.Vector3(0,1,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

function createAntenna(pos) {
  const g=new THREE.Group();
  const mm=new THREE.MeshStandardMaterial({color:0xcccccc,metalness:0.6,roughness:0.3});
  // Main pole
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.12,6,6),mm),{position:new THREE.Vector3(0,3,0),castShadow:true}));
  // Cross bars
  for(let i=0;i<3;i++){
    const w=1.2-i*0.3;
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(w,0.05,0.05),mm),{position:new THREE.Vector3(0,4.5+i*0.6,0)}));
  }
  // Dishes
  for(const s of [-1,1]){
    const dish=new THREE.Mesh(
      new THREE.SphereGeometry(0.3,8,6,0,Math.PI),
      new THREE.MeshStandardMaterial({color:0xeee,metalness:0.4,roughness:0.3})
    );
    dish.position.set(s*0.5,5.5,0);
    dish.rotation.y=s*0.5;
    g.add(dish);
  }
  // Blinking red light
  const light=new THREE.Mesh(new THREE.SphereGeometry(0.06,6,6),new THREE.MeshStandardMaterial({color:0xff0000,emissive:0xff0000,emissiveIntensity:2}));
  light.position.y=6.1;
  g.add(light);
  g._blink=light;
  // Point light for coverage visual
  g.add(Object.assign(new THREE.PointLight(0x00ccff,0.2,20),{position:new THREE.Vector3(0,5,0)}));
  // Coverage ring on ground
  const coverRing=new THREE.Mesh(
    new THREE.RingGeometry(17.5,18,48),
    new THREE.MeshBasicMaterial({color:0x00ccff,transparent:true,opacity:0.08,side:THREE.DoubleSide})
  );
  coverRing.rotation.x=-Math.PI/2;
  coverRing.position.y=0.1;
  g.add(coverRing);
  g.position.copy(pos);scene.add(g);return g;
}

function createServer(pos) {
  const g=new THREE.Group();
  // Server room box
  const wallMat=new THREE.MeshStandardMaterial({color:0x333340,metalness:0.3,roughness:0.5});
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(3,2.5,2.5),wallMat),{position:new THREE.Vector3(0,1.25,0),castShadow:true}));
  // Door
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.6,1.8,0.08),new THREE.MeshStandardMaterial({color:0x555560,metalness:0.4})),{position:new THREE.Vector3(0,0.9,1.27)}));
  // Vents
  for(let i=0;i<4;i++){
    g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.5,0.05,0.1),new THREE.MeshStandardMaterial({color:0x222})),{position:new THREE.Vector3(0.8,1.8-i*0.3,1.27)}));
  }
  // Server racks visible inside (glowing)
  for(let i=0;i<3;i++){
    const rack=new THREE.Mesh(new THREE.BoxGeometry(0.4,2,0.5),new THREE.MeshStandardMaterial({color:0x222230,metalness:0.5}));
    rack.position.set(-0.8+i*0.8,1,0);
    g.add(rack);
    // LEDs
    for(let j=0;j<6;j++){
      const led=new THREE.Mesh(new THREE.SphereGeometry(0.02,4,4),new THREE.MeshStandardMaterial({
        color:Math.random()>0.3?0x00ff88:0x00ccff,emissive:Math.random()>0.3?0x00ff88:0x00ccff,emissiveIntensity:2
      }));
      led.position.set(-0.8+i*0.8+0.15,0.4+j*0.3,0.27);
      g.add(led);
    }
  }
  // Cooling unit
  g.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(1,0.8,0.3),new THREE.MeshStandardMaterial({color:0x888,metalness:0.4})),{position:new THREE.Vector3(0,2.9,0)}));
  // Inner glow
  g.add(Object.assign(new THREE.PointLight(0x00ccff,0.5,4),{position:new THREE.Vector3(0,1.2,0)}));
  g.position.copy(pos);scene.add(g);return g;
}

const buildingCreators = {
  cabin:createCabin, well:createWell, field:createField, barn:createBarn,
  coop:createCoop, greenhouse:createGreenhouse, pasture:createPasture,
  silo:createSilo, windmill:createWindmill, solar:createSolar,
  antenna:createAntenna, server:createServer
};

// ═══════════════════════════════════════
// EFFICIENCY FORMULA: E = B * (1 + ΣS) * η
// ═══════════════════════════════════════
function getEfficiency(buildingKey) {
  const b = BUILDINGS[buildingKey];
  if (!b.built || !b.production) return { base:0, sensorBonus:0, eta:0, total:0 };
  const base = 1;
  // Sum sensor bonuses
  let sensorSum = 0;
  const sensors = installedSensors[buildingKey] || [];
  for (const sk of sensors) {
    const sd = IOT_SENSORS[sk];
    if (sd && sd.bonus) {
      for (const [res, val] of Object.entries(sd.bonus)) {
        if (res !== 'maintenance') sensorSum += val;
      }
    }
  }
  // Tech tree bonuses
  for (const techId of unlockedTech) {
    // Find which building this tech belongs to
    for (const [bk, tree] of Object.entries(TECH_TREE)) {
      if (bk !== buildingKey) continue;
      for (const path of [tree.hw, tree.sw]) {
        for (const node of path) {
          if (node.id === techId && node.bonus) {
            for (const [res, val] of Object.entries(node.bonus)) {
              if (res !== 'maintenance') sensorSum += val;
            }
          }
        }
      }
    }
  }
  // η = network coverage coefficient
  const eta = calcNetworkEta(buildingKey);
  const total = base * (1 + sensorSum) * eta;
  return { base, sensorBonus: sensorSum, eta, total };
}

function calcNetworkEta(buildingKey) {
  // If no sensors/tech that need network, eta = 1
  const sensors = installedSensors[buildingKey] || [];
  const hasSoftware = [...unlockedTech].some(id => {
    for (const [bk, tree] of Object.entries(TECH_TREE)) {
      if (bk !== buildingKey) continue;
      for (const node of tree.sw) if (node.id === id) return true;
    }
    return false;
  });
  if (sensors.length === 0 && !hasSoftware) return 1;
  // Check distance to nearest antenna
  const bPos = buildingPositions[buildingKey];
  if (!bPos) return 0.5;
  let minDist = Infinity;
  for (const s of builtStructures) {
    if (s.key === 'antenna') {
      const d = bPos.distanceTo(s.position);
      if (d < minDist) minDist = d;
    }
  }
  const coverageRadius = 18;
  if (minDist > coverageRadius) return 0.3; // Out of range = degraded
  return lerp(1, 0.7, minDist / coverageRadius); // Closer = better
}

function calcNetworkCoverage() {
  const antennas = builtStructures.filter(s => s.key === 'antenna');
  if (antennas.length === 0) { networkCoverage = 0; return; }
  let covered = 0, total = 0;
  for (const [k, b] of Object.entries(BUILDINGS)) {
    if (!b.built || k === 'antenna') continue;
    total++;
    const bp = buildingPositions[k];
    for (const ant of antennas) {
      if (bp.distanceTo(ant.position) <= 18) { covered++; break; }
    }
  }
  networkCoverage = total > 0 ? Math.round((covered / total) * 100) : 0;
}

// ═══════════════════════════════════════
// BUILDING HEALTH & MAINTENANCE
// ═══════════════════════════════════════
function updateMaintenance(dt) {
  for (const s of builtStructures) {
    if (!buildingHealth[s.key]) buildingHealth[s.key] = 100;
    // Degrade over time
    let degradeRate = 0.05; // per second
    // Sensors reduce degradation
    const sensors = installedSensors[s.key] || [];
    for (const sk of sensors) {
      const sd = IOT_SENSORS[sk];
      if (sd?.bonus?.maintenance) degradeRate *= (1 - sd.bonus.maintenance);
    }
    // Tech bonuses
    for (const techId of unlockedTech) {
      for (const [bk, tree] of Object.entries(TECH_TREE)) {
        if (bk !== s.key) continue;
        for (const path of [tree.hw, tree.sw]) {
          for (const node of path) {
            if (node.id === techId && node.bonus?.maintenance) {
              degradeRate *= (1 - node.bonus.maintenance);
            }
          }
        }
      }
    }
    buildingHealth[s.key] = Math.max(0, buildingHealth[s.key] - degradeRate * dt);

    // If health < 30, production stops and we log warning
    if (buildingHealth[s.key] < 30 && buildingHealth[s.key] > 29.9) {
      addLog(`⚠️ ${BUILDINGS[s.key].name} en panne critique!`, 'warn');
    }
    if (buildingHealth[s.key] < 50 && buildingHealth[s.key] > 49.9) {
      const hasSensor = sensors.some(sk => IOT_SENSORS[sk]?.bonus?.maintenance);
      if (hasSensor) addLog(`🔧 ${BUILDINGS[s.key].name}: maintenance predictive recommandee`, 'info');
    }
  }
}

// ═══════════════════════════════════════
// LOGGING SYSTEM
// ═══════════════════════════════════════
function addLog(msg, type='info') {
  const ts = `[J${dayCount} ${Math.floor(gameTime%80)}s]`;
  logs.push({ ts, msg, type, time: gameTime });
  if (logs.length > 50) logs.shift();
}

// ═══════════════════════════════════════
// UI FUNCTIONS
// ═══════════════════════════════════════
window.switchTab = function(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    b.className = 'tab-btn';
    if ((tab==='build'&&i===0)||(tab==='iot'&&i===1)||(tab==='tech'&&i===2)||(tab==='dash'&&i===3)) {
      b.className = 'tab-btn ' + (tab==='iot'?'active-iot':tab==='dash'?'active-dash':'active');
    }
  });
  document.getElementById('build-menu').style.display = (tab==='build'||tab==='iot') ? 'flex' : 'none';
  document.getElementById('dashboard').style.display = tab==='dash' ? 'block' : 'none';
  document.getElementById('tech-panel').style.display = tab==='tech' ? 'block' : 'none';
  selectedBuilding = null;
  selectedIoT = null;
  removeGhost();
  if (tab==='build') renderBuildMenu();
  else if (tab==='iot') renderIoTMenu();
  else if (tab==='tech') renderTechTree();
  else if (tab==='dash') renderDashboard();
};

function renderBuildMenu() {
  const menu = document.getElementById('build-menu');
  menu.innerHTML = '';
  const icons = {wood:'🪵',stone:'🪨',water:'💧',food:'🌾',energy:'⚡',gold:'🪙',data:'📊'};
  for (const [key, b] of Object.entries(BUILDINGS)) {
    const btn = document.createElement('div');
    btn.className = 'build-btn' + (b.built?' built':!b.unlocked?' locked':'') + (selectedBuilding===key?' active':'');
    if (b.category==='tech') btn.classList.add('iot-btn');
    const costStr = Object.entries(b.cost).map(([r,v])=>`${icons[r]||''}${v}`).join(' ');
    btn.innerHTML = `<div class="b-icon">${b.icon}</div><div class="b-name">${b.name}</div><div class="b-cost">${b.built?'✓':costStr}</div>`;
    if (!b.built && b.unlocked) btn.addEventListener('click', () => { selectedBuilding = selectedBuilding===key?null:key; selectedIoT=null; if(selectedBuilding)showGhost(key);else removeGhost(); renderBuildMenu(); });
    menu.appendChild(btn);
  }
}

function renderIoTMenu() {
  const menu = document.getElementById('build-menu');
  menu.innerHTML = '';
  const icons = {wood:'🪵',stone:'🪨',water:'💧',food:'🌾',energy:'⚡',gold:'🪙',data:'📊'};
  // Show available IoT sensors
  for (const [key, s] of Object.entries(IOT_SENSORS)) {
    // Check if any target building is built
    const anyTarget = s.targets.some(t => BUILDINGS[t].built);
    const canAffordIt = canAfford(s.cost);
    const btn = document.createElement('div');
    btn.className = 'build-btn iot-btn' + (!anyTarget?' locked':'') + (selectedIoT===key?' active':'');
    const costStr = Object.entries(s.cost).map(([r,v])=>`${icons[r]||''}${v}`).join(' ');
    btn.innerHTML = `<div class="b-icon">${s.icon}</div><div class="b-name">${s.name}</div><div class="b-cost">${costStr}</div>`;
    if (anyTarget) btn.addEventListener('click', () => { selectedIoT = selectedIoT===key?null:key; selectedBuilding=null; removeGhost(); renderIoTMenu(); });
    menu.appendChild(btn);
  }
  // Show installed sensors below
  if (Object.keys(installedSensors).length > 0) {
    const sep = document.createElement('div');
    sep.style.cssText = 'width:100%;text-align:center;color:#00ccff;font-size:11px;opacity:0.5;padding:4px';
    sep.textContent = '── Capteurs installes ──';
    menu.appendChild(sep);
    for (const [bKey, sensors] of Object.entries(installedSensors)) {
      for (const sk of sensors) {
        const si = IOT_SENSORS[sk];
        const bi = BUILDINGS[bKey];
        const item = document.createElement('div');
        item.className = 'build-btn iot-btn built';
        item.innerHTML = `<div class="b-icon">${si.icon}</div><div class="b-name">${si.name}</div><div class="b-cost">${bi.name}</div>`;
        menu.appendChild(item);
      }
    }
  }
  // If a sensor is selected, show which buildings it can go on
  if (selectedIoT) {
    const sd = IOT_SENSORS[selectedIoT];
    showMessage(`Clique sur: ${sd.targets.map(t=>BUILDINGS[t].name).join(', ')}`, '#00ccff');
  }
}

function renderTechTree() {
  const panel = document.getElementById('tech-panel');
  let html = '<h3>🔬 Arbre Technologique</h3>';
  const icons = {wood:'🪵',stone:'🪨',water:'💧',food:'🌾',energy:'⚡',gold:'🪙',data:'📊'};
  for (const [bKey, tree] of Object.entries(TECH_TREE)) {
    const b = BUILDINGS[bKey];
    if (!b.built) continue;
    html += `<div class="tech-building"><div class="tb-header">${b.icon} ${b.name}</div>`;
    // Hardware path
    html += '<div class="tech-path"><div class="path-label hw">⚙️ Hardware</div>';
    for (const node of tree.hw) {
      const owned = unlockedTech.has(node.id);
      const locked = node.requires && !unlockedTech.has(node.requires);
      const afford = !locked && canAfford(node.cost);
      const cls = owned ? 'owned' : locked ? 'locked' : '';
      const costStr = Object.entries(node.cost).map(([r,v])=>`${icons[r]||''}${v}`).join(' ');
      html += `<div class="tech-node ${cls}" data-id="${node.id}"><span class="tn-icon">${node.icon}</span><div><strong>${node.name}</strong><br><span style="opacity:.6;font-size:10px">${node.desc}</span></div><span class="tn-cost">${owned?'✓':costStr}</span></div>`;
    }
    html += '</div>';
    // Software path
    html += '<div class="tech-path"><div class="path-label sw">💻 Software</div>';
    for (const node of tree.sw) {
      const owned = unlockedTech.has(node.id);
      const locked = node.requires && !unlockedTech.has(node.requires);
      const cls = owned ? 'owned' : locked ? 'locked' : '';
      const costStr = Object.entries(node.cost).map(([r,v])=>`${icons[r]||''}${v}`).join(' ');
      html += `<div class="tech-node ${cls}" data-id="${node.id}"><span class="tn-icon">${node.icon}</span><div><strong>${node.name}</strong><br><span style="opacity:.6;font-size:10px">${node.desc}</span></div><span class="tn-cost">${owned?'✓':costStr}</span></div>`;
    }
    html += '</div></div>';
  }
  panel.innerHTML = html;
  // Click handlers
  panel.querySelectorAll('.tech-node:not(.owned):not(.locked)').forEach(el => {
    el.addEventListener('click', () => unlockTech(el.dataset.id));
  });
}

function unlockTech(id) {
  // Find the node
  for (const [bKey, tree] of Object.entries(TECH_TREE)) {
    for (const path of [tree.hw, tree.sw]) {
      for (const node of path) {
        if (node.id === id) {
          if (node.requires && !unlockedTech.has(node.requires)) return;
          if (!canAfford(node.cost)) { showMessage('Ressources insuffisantes!','#ff4444'); return; }
          for (const [r,v] of Object.entries(node.cost)) R[r] -= v;
          unlockedTech.add(id);
          addLog(`🔬 Tech debloquee: ${node.name}`, 'info');
          showMessage(`${node.name} debloque!`, '#ff8844');
          updateHUD();
          renderTechTree();
          return;
        }
      }
    }
  }
}

function renderDashboard() {
  const dash = document.getElementById('dashboard');
  let html = '<h3>📊 Centre de Controle</h3>';

  // Network status
  html += '<div class="section"><h4>📡 Reseau IoT</h4>';
  html += `<div class="stat-row"><span class="label">Couverture</span><span class="value ${networkCoverage>70?'good':networkCoverage>30?'warn':'bad'}">${networkCoverage}%</span></div>`;
  html += `<div class="stat-row"><span class="label">Antennes</span><span class="value">${builtStructures.filter(s=>s.key==='antenna').length}</span></div>`;
  html += `<div class="stat-row"><span class="label">Capteurs actifs</span><span class="value">${Object.values(installedSensors).flat().length}</span></div>`;
  html += `<div class="stat-row"><span class="label">Data/cycle</span><span class="value good">+${calcDataPerCycle()}</span></div>`;
  html += '</div>';

  // Building status
  html += '<div class="section"><h4>🏗️ Batiments</h4>';
  for (const s of builtStructures) {
    const b = BUILDINGS[s.key];
    const hp = Math.round(buildingHealth[s.key] || 100);
    const eff = getEfficiency(s.key);
    const hpColor = hp > 70 ? '#66bb6a' : hp > 40 ? '#ffaa00' : '#ff4444';
    html += `<div style="margin-bottom:8px"><div class="stat-row"><span class="label">${b.icon} ${b.name}</span><span class="value" style="color:${hpColor}">${hp}%</span></div>`;
    html += `<div class="health-bar"><div class="fill" style="width:${hp}%;background:${hpColor}"></div></div>`;
    if (b.production) {
      html += `<div class="stat-row"><span class="label" style="font-size:10px">Efficacite (E=B×(1+ΣS)×η)</span><span class="value" style="font-size:11px;color:#00ccff">×${eff.total.toFixed(2)}</span></div>`;
    }
    // Sensors on this building
    const sensors = installedSensors[s.key] || [];
    if (sensors.length > 0) {
      html += '<div class="sensor-list" style="margin-top:4px">';
      for (const sk of sensors) {
        const sd = IOT_SENSORS[sk];
        const inRange = calcNetworkEta(s.key) > 0.5;
        html += `<div class="sensor-item"><div class="dot ${inRange?'':'offline'}"></div>${sd.icon} ${sd.name} <span style="margin-left:auto;opacity:.5">+${sd.dataGen}/s</span></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Repair button for low-health buildings
  const lowHealth = builtStructures.filter(s => (buildingHealth[s.key]||100) < 70);
  if (lowHealth.length > 0) {
    html += '<div class="section"><h4>🔧 Maintenance</h4>';
    for (const s of lowHealth) {
      const cost = Math.round((100 - (buildingHealth[s.key]||100)) * 0.1);
      html += `<div class="stat-row"><span class="label">${BUILDINGS[s.key].icon} ${BUILDINGS[s.key].name} (${Math.round(buildingHealth[s.key])}%)</span><button onclick="repairBuilding('${s.key}')" style="background:rgba(76,175,80,0.3);border:1px solid #66bb6a;color:#fff;padding:3px 10px;border-radius:6px;cursor:pointer;font-size:11px">Reparer 🪙${cost}</button></div>`;
    }
    html += '</div>';
  }

  // Log console
  html += '<div class="section"><h4>💻 Console</h4><div class="log-console" id="log-console">';
  const recentLogs = logs.slice(-20);
  for (const log of recentLogs) {
    html += `<div class="log-line"><span class="ts">${log.ts}</span> <span class="${log.type}">${log.msg}</span></div>`;
  }
  html += '</div></div>';

  dash.innerHTML = html;
  // Auto-scroll log
  const lc = document.getElementById('log-console');
  if (lc) lc.scrollTop = lc.scrollHeight;
}

window.repairBuilding = function(key) {
  const hp = buildingHealth[key] || 100;
  const cost = Math.round((100 - hp) * 0.1);
  if (R.gold < cost) { showMessage('Pas assez d\'or!','#ff4444'); return; }
  R.gold -= cost;
  buildingHealth[key] = 100;
  addLog(`✅ ${BUILDINGS[key].name} repare a 100%`, 'info');
  showMessage(`${BUILDINGS[key].name} repare!`, '#66bb6a');
  updateHUD();
  renderDashboard();
};

function calcDataPerCycle() {
  let total = 0;
  for (const [bk, sensors] of Object.entries(installedSensors)) {
    for (const sk of sensors) {
      const sd = IOT_SENSORS[sk];
      if (sd) total += sd.dataGen;
    }
  }
  // Server bonus
  if (BUILDINGS.server.built) total += 3;
  // Antenna base
  total += builtStructures.filter(s=>s.key==='antenna').length;
  return Math.round(total * 10) / 10;
}

// ═══════════════════════════════════════
// GHOST & BUILD
// ═══════════════════════════════════════
function showGhost(key) {
  removeGhost();
  const b = BUILDINGS[key], p = buildingPositions[key];
  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(b.size[0], 2.5, b.size[1]),
    new THREE.MeshStandardMaterial({ color: canAfford(b.cost)?0x4CAF50:0xff4444, transparent:true, opacity:0.2 })
  );
  const wire = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], 2.5, b.size[1]),
    new THREE.MeshBasicMaterial({ color: canAfford(b.cost)?0x66bb6a:0xff6666, wireframe:true, transparent:true, opacity:0.35 })
  );
  ghost.add(wire);
  ghost.position.set(p.x, p.y+1.25, p.z);
  scene.add(ghost);
  buildingGhost = ghost;
}
function removeGhost() { if(buildingGhost){scene.remove(buildingGhost);buildingGhost=null} }

function canAfford(cost) { return Object.entries(cost).every(([r,v])=>(R[r]||0)>=v); }

function buildStructure(key) {
  const b=BUILDINGS[key];
  if(!canAfford(b.cost)){showMessage('Ressources insuffisantes!','#ff4444');return}
  for(const [r,v] of Object.entries(b.cost)) R[r]-=v;
  b.built=true;
  removeGhost();
  selectedBuilding=null;
  const p=buildingPositions[key];
  const mesh=buildingCreators[key](p);
  // Rise animation
  const ty=mesh.position.y;
  mesh.position.y-=3;mesh.scale.set(0.01,0.01,0.01);
  let prog=0;
  const anim=()=>{prog+=0.025;const t=Math.min(prog,1);const e=1-Math.pow(1-t,3);mesh.position.y=ty-3+3*e;mesh.scale.setScalar(e);if(t<1)requestAnimationFrame(anim)};
  anim();
  builtStructures.push({key,mesh,position:p});
  buildingHealth[key]=100;
  for(const [k,bd] of Object.entries(BUILDINGS)){if(bd.prerequisite===key)bd.unlocked=true}
  if(b.production)productionTimers[key]=0;
  calcNetworkCoverage();
  addLog(`🏗️ ${b.name} construit`, 'info');
  showMessage(`${b.name} construit!`,'#4CAF50');
  updateHUD();
  renderBuildMenu();
}

function installSensor(buildingKey, sensorKey) {
  const sd=IOT_SENSORS[sensorKey];
  if(!canAfford(sd.cost)){showMessage('Ressources insuffisantes!','#ff4444');return}
  for(const [r,v] of Object.entries(sd.cost)) R[r]-=v;
  if(!installedSensors[buildingKey]) installedSensors[buildingKey]=[];
  installedSensors[buildingKey].push(sensorKey);
  // Add visual to building
  const struct=builtStructures.find(s=>s.key===buildingKey);
  if(struct) addSensorVisual(struct.mesh, sensorKey);
  addLog(`📡 ${sd.name} installe sur ${BUILDINGS[buildingKey].name}`, 'info');
  showMessage(`${sd.name} installe!`,'#00ccff');
  selectedIoT=null;
  calcNetworkCoverage();
  updateHUD();
  renderIoTMenu();
}

// ═══════════════════════════════════════
// INTERACTION
// ═══════════════════════════════════════
const raycaster=new THREE.Raycaster(), mouse=new THREE.Vector2();

function onPointerDown(e) {
  if(!gameStarted) return;
  mouse.x=(e.clientX/innerWidth)*2-1;
  mouse.y=-(e.clientY/innerHeight)*2+1;
  raycaster.setFromCamera(mouse,camera);

  // Building placement
  if(selectedBuilding){
    const p=buildingPositions[selectedBuilding];
    const plane=new THREE.Plane(new THREE.Vector3(0,1,0),-p.y);
    const pt=new THREE.Vector3();
    raycaster.ray.intersectPlane(plane,pt);
    if(pt&&pt.distanceTo(p)<5){buildStructure(selectedBuilding);return}
  }

  // IoT sensor placement
  if(selectedIoT){
    const sd=IOT_SENSORS[selectedIoT];
    // Check if clicking on a valid target building
    for(const targetKey of sd.targets){
      if(!BUILDINGS[targetKey].built) continue;
      const bp=buildingPositions[targetKey];
      const plane=new THREE.Plane(new THREE.Vector3(0,1,0),-bp.y);
      const pt=new THREE.Vector3();
      raycaster.ray.intersectPlane(plane,pt);
      if(pt&&pt.distanceTo(bp)<5){
        installSensor(targetKey,selectedIoT);
        return;
      }
    }
  }

  // Harvest
  const allMeshes=harvestables.flatMap(h=>h.mesh instanceof THREE.Group?h.mesh.children:[h.mesh]);
  const intersects=raycaster.intersectObjects(allMeshes,true);
  if(intersects.length===0) return;
  const hit=intersects[0].object;
  for(const h of harvestables){
    let isHit=false;
    if(h.mesh instanceof THREE.Group)h.mesh.traverse(c=>{if(c===hit)isHit=true});
    else if(h.mesh===hit)isHit=true;
    if(isHit&&h.hp>0){
      h.hp--;
      const orig=h.mesh.position.clone();
      h.mesh.position.x+=rand(-0.3,0.3);
      setTimeout(()=>{if(h.mesh.parent)h.mesh.position.copy(orig)},120);
      // Debris
      for(let p=0;p<4;p++){
        const pm=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.05,0.05),new THREE.MeshStandardMaterial({color:h.type==='tree'?0x8B5E3C:0x888}));
        pm.position.copy(intersects[0].point);scene.add(pm);
        particles.push({mesh:pm,type:'debris',vel:new THREE.Vector3(rand(-2,2),rand(1,4),rand(-2,2)),life:rand(0.5,1.2),maxLife:1.2});
      }
      if(h.hp<=0){
        R[h.resource]+=h.amount;
        const cls='res-'+h.resource;
        showPopup(e.clientX,e.clientY,`+${h.amount} ${h.resource==='wood'?'🪵':'🪨'}`,cls);
        const idx=harvestables.indexOf(h);
        let ss=1;const shrink=()=>{ss-=0.06;if(ss>0){h.mesh.scale.setScalar(ss);h.mesh.position.y-=0.02;requestAnimationFrame(shrink)}else{scene.remove(h.mesh);harvestables.splice(idx,1)}};
        shrink();
        setTimeout(()=>{
          const nx=rand(-40,40),nz=rand(-40,40);
          if(h.type==='tree'){const s=rand(0.7,1.4),t=randInt(0,2);const tree=t===0?createPineTree(nx,nz,s):t===1?createOakTree(nx,nz,s):createBirchTree(nx,nz,s);harvestables.push({type:'tree',mesh:tree,hp:3,maxHp:3,resource:'wood',amount:3})}
          else{const s=rand(0.6,1.4);const rock=createRockCluster(nx,nz,s);harvestables.push({type:'rock',mesh:rock,hp:3,maxHp:3,resource:'stone',amount:2})}
        },10000);
        updateHUD();renderBuildMenu();
      } else { showPopup(e.clientX,e.clientY,`${h.hp}/3`); }
      return;
    }
  }
}
renderer.domElement.addEventListener('pointerdown',onPointerDown);

// Tooltip
renderer.domElement.addEventListener('pointermove',(e)=>{
  if(!gameStarted)return;
  const tooltip=document.getElementById('tooltip');
  mouse.x=(e.clientX/innerWidth)*2-1;
  mouse.y=-(e.clientY/innerHeight)*2+1;
  raycaster.setFromCamera(mouse,camera);
  const meshes=harvestables.filter(h=>h.hp>0).flatMap(h=>h.mesh instanceof THREE.Group?h.mesh.children:[h.mesh]);
  const intersects=raycaster.intersectObjects(meshes,true);
  if(intersects.length>0){
    const hit=intersects[0].object;
    for(const h of harvestables){
      let isHit=false;
      if(h.mesh instanceof THREE.Group)h.mesh.traverse(c=>{if(c===hit)isHit=true});else if(h.mesh===hit)isHit=true;
      if(isHit&&h.hp>0){
        tooltip.style.display='block';tooltip.style.left=e.clientX+15+'px';tooltip.style.top=e.clientY-10+'px';
        tooltip.innerHTML=`<strong>${h.type==='tree'?'Arbre':'Rocher'}</strong> (${h.hp}/${h.maxHp})<br><span style="opacity:.6">Clic pour ${h.type==='tree'?'couper':'miner'}</span>`;
        renderer.domElement.style.cursor='pointer';return;
      }
    }
  }
  tooltip.style.display='none';
  renderer.domElement.style.cursor=selectedBuilding||selectedIoT?'crosshair':'grab';
});

// ═══════════════════════════════════════
// HUD & POPUPS
// ═══════════════════════════════════════
function updateHUD(){
  for(const [k,v] of Object.entries(R)){
    const el=document.getElementById(`r-${k}`);
    if(el){const prev=parseInt(el.textContent)||0;if(v!==prev){el.textContent=Math.round(v);el.parentElement.style.transform='scale(1.12)';setTimeout(()=>{el.parentElement.style.transform='scale(1)'},200)}}
  }
  // Coverage
  const ci=document.getElementById('coverage-ind');
  if(builtStructures.some(s=>s.key==='antenna')){
    ci.style.display='flex';
    document.getElementById('coverage-pct').textContent=networkCoverage+'%';
    const bars=ci.querySelectorAll('.bar');
    bars.forEach((b,i)=>{b.style.background=networkCoverage>i*25?'#00ff88':'#333'});
  }
}

function showPopup(x,y,text,cls='production'){
  const p=document.createElement('div');p.className=`popup ${cls}`;p.textContent=text;p.style.left=x+'px';p.style.top=y+'px';
  document.body.appendChild(p);setTimeout(()=>p.remove(),1400);
}
function showMessage(text,color='#fff'){
  const m=document.createElement('div');m.className='msg';m.textContent=text;m.style.borderLeft=`3px solid ${color}`;
  document.getElementById('messages').appendChild(m);setTimeout(()=>m.remove(),3500);
}

// ═══════════════════════════════════════
// PRODUCTION
// ═══════════════════════════════════════
function updateProduction(dt){
  for(const [key,b] of Object.entries(BUILDINGS)){
    if(!b.built||!b.production) continue;
    if(!productionTimers[key])productionTimers[key]=0;
    productionTimers[key]+=dt;
    if(productionTimers[key]<PRODUCTION_INTERVAL) continue;
    productionTimers[key]=0;
    // Health check
    const hp=buildingHealth[key]||100;
    if(hp<30) continue; // Broken
    const hpMult=hp>70?1:hp/100;
    // Consumption
    if(b.consumption){
      let ok=true;
      for(const [r,v] of Object.entries(b.consumption)){if(R[r]<v){ok=false;break}}
      if(!ok) continue;
      for(const [r,v] of Object.entries(b.consumption)) R[r]-=v;
    }
    // Efficiency
    const eff=getEfficiency(key);
    for(const [r,v] of Object.entries(b.production)){
      R[r]+=Math.round(v*eff.total*hpMult*10)/10;
    }
    // Data generation from sensors
    const sensors=installedSensors[key]||[];
    for(const sk of sensors){
      const sd=IOT_SENSORS[sk];
      if(sd) R.data+=sd.dataGen*PRODUCTION_INTERVAL;
    }
    // Visual popup
    const struct=builtStructures.find(s=>s.key===key);
    if(struct){
      const sp=struct.position.clone();sp.y+=3;sp.project(camera);
      const sx=(sp.x*0.5+0.5)*innerWidth,sy=(-sp.y*0.5+0.5)*innerHeight;
      const icons={wood:'🪵',stone:'🪨',water:'💧',food:'🌾',energy:'⚡',gold:'🪙',data:'📊'};
      const prodText=Object.entries(b.production).map(([r,v])=>{
        const actual=Math.round(v*eff.total*hpMult*10)/10;
        return `+${actual}${icons[r]}`;
      }).join(' ');
      showPopup(sx,sy,prodText);
    }
    updateHUD();
  }
}

// ═══════════════════════════════════════
// DAY/NIGHT
// ═══════════════════════════════════════
let firefliesSpawned=false;
function updateDayNight(time){
  const dayLen=80,phase=(time%dayLen)/dayLen;
  const sunAngle=phase*6.28-1.57;
  sunLight.position.set(Math.cos(sunAngle)*35,Math.sin(sunAngle)*35+10,20);
  let skyColor,sunI,ambI;
  if(phase<0.2){const t=phase/0.2;skyColor=new THREE.Color(0x0a0a2e).lerp(new THREE.Color(0xff9966),t);sunI=lerp(0.2,1.5,t);ambI=lerp(0.15,0.4,t);bloomPass.strength=lerp(0.5,0.25,t)}
  else if(phase<0.5){skyColor=new THREE.Color(0xff9966).lerp(new THREE.Color(0x87CEEB),Math.min((phase-0.2)/0.15,1));sunI=1.8;ambI=0.45;bloomPass.strength=0.25}
  else if(phase<0.7){const t=(phase-0.5)/0.2;skyColor=new THREE.Color(0x87CEEB).lerp(new THREE.Color(0xff5533),t);sunI=lerp(1.8,0.6,t);ambI=lerp(0.45,0.25,t);bloomPass.strength=lerp(0.25,0.5,t)}
  else{const t=(phase-0.7)/0.3;skyColor=new THREE.Color(0xff5533).lerp(new THREE.Color(0x0a0a2e),Math.min(t*2,1));sunI=lerp(0.6,0.15,t);ambI=lerp(0.25,0.12,t);bloomPass.strength=lerp(0.5,0.8,t)}
  scene.background=skyColor;scene.fog.color=skyColor;sunLight.intensity=sunI;ambientLight.intensity=ambI;
  // Fireflies at night
  const nowNight=phase>0.7||phase<0.15;
  if(nowNight&&!firefliesSpawned){
    for(let i=0;i<12;i++){
      const fm=new THREE.Mesh(new THREE.SphereGeometry(0.05,6,6),new THREE.MeshStandardMaterial({color:0xffee44,emissive:0xffee44,emissiveIntensity:3,transparent:true}));
      const x=rand(-25,25),z=rand(-25,25);fm.position.set(x,getY(x,z)+rand(0.5,2.5),z);
      fm.add(new THREE.PointLight(0xffee44,0.4,3));scene.add(fm);
      particles.push({mesh:fm,type:'firefly',vel:new THREE.Vector3(rand(-0.3,0.3),rand(-0.1,0.1),rand(-0.3,0.3)),phase:rand(0,6.28),life:Infinity});
    }
    firefliesSpawned=true;
  }
  if(!nowNight&&firefliesSpawned){
    for(let i=particles.length-1;i>=0;i--){if(particles[i].type==='firefly'){scene.remove(particles[i].mesh);particles.splice(i,1)}}
    firefliesSpawned=false;
  }
  const newDay=Math.floor(time/dayLen)+1;
  if(newDay!==dayCount){dayCount=newDay;document.getElementById('day-indicator').textContent=`Jour ${dayCount}`}
}

// ═══════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════
const clock=new THREE.Clock();
let leafTimer=0,smokeTimer=0,dashTimer=0,dataTimer=0;

function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),0.05);
  if(!gameStarted){controls.update();composer.render();return}

  gameTime+=dt;
  updateProduction(dt);
  updateMaintenance(dt);
  updateDayNight(gameTime);

  // Windmill blades
  for(const s of builtStructures){if(s.key==='windmill'&&s.mesh._blades)s.mesh._blades.rotation.z+=dt*0.8}
  // Antenna blink
  for(const s of builtStructures){if(s.key==='antenna'&&s.mesh._blink){s.mesh._blink.material.emissiveIntensity=Math.sin(gameTime*3)>0?2:0.2}}

  // Tree sway
  for(const h of harvestables){if(h.type==='tree'&&h.mesh.parent){h.mesh.rotation.z=Math.sin(gameTime*1.2+h.mesh.position.x*0.5)*0.025}}

  // Animated objects
  for(const ao of animatedObjects){
    if(ao.type==='chicken'||ao.type==='cow'){
      ao.phase+=dt*(ao.type==='chicken'?2:0.8);
      ao.mesh.position.x=ao.basePos.x+Math.sin(ao.phase*0.7)*0.3;
      ao.mesh.position.z=ao.basePos.z+Math.cos(ao.phase*0.5)*0.2;
      ao.mesh.rotation.y=Math.atan2(Math.cos(ao.phase*0.7)*0.3,-Math.sin(ao.phase*0.5)*0.2);
      if(ao.type==='chicken'&&Math.sin(ao.phase*3)>0.8)ao.mesh.rotation.x=0.3;else ao.mesh.rotation.x=0;
    }
    if(ao.type==='pulse'){
      ao.phase+=dt*2;
      ao.mesh.scale.setScalar(1+Math.sin(ao.phase)*0.3);
      ao.mesh.material.opacity=0.3+Math.sin(ao.phase)*0.2;
    }
  }

  // Clouds
  for(const c of cloudGroup.children){c.position.x+=c._speed*dt;if(c.position.x>75)c.position.x=-75}

  // Particles
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i];
    if(p.type==='firefly'){p.phase+=dt*2;p.mesh.position.add(p.vel.clone().multiplyScalar(dt));p.mesh.position.y+=Math.sin(p.phase)*dt*0.3;p.mesh.material.emissiveIntensity=1.5+Math.sin(p.phase*3)*1.5;if(Math.random()<0.02)p.vel.set(rand(-0.3,0.3),rand(-0.1,0.1),rand(-0.3,0.3));if(Math.abs(p.mesh.position.x)>30)p.vel.x*=-1;if(Math.abs(p.mesh.position.z)>30)p.vel.z*=-1}
    if(p.type==='debris'){p.life-=dt;p.vel.y-=9.8*dt;p.mesh.position.add(p.vel.clone().multiplyScalar(dt));p.mesh.rotation.x+=dt*5;const s=Math.max(p.life/p.maxLife,0);p.mesh.scale.setScalar(s);if(p.life<=0){scene.remove(p.mesh);particles.splice(i,1)}}
  }

  // Smoke
  smokeTimer+=dt;
  const cabinS=builtStructures.find(s=>s.key==='cabin');
  if(cabinS&&smokeTimer>0.3){
    smokeTimer=0;
    const sm=new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.1,0.2),1),new THREE.MeshStandardMaterial({color:0xccc,transparent:true,opacity:0.35,roughness:1}));
    sm.position.copy(cabinS.mesh._chimneyPos);sm.position.x+=rand(-0.1,0.1);sm.position.z+=rand(-0.1,0.1);
    scene.add(sm);
    smokeParticles.push({mesh:sm,life:0,maxLife:rand(2,4),vel:new THREE.Vector3(rand(-0.1,0.1),rand(0.5,1),rand(-0.1,0.1))});
  }
  for(let i=smokeParticles.length-1;i>=0;i--){
    const sp=smokeParticles[i];sp.life+=dt;sp.mesh.position.add(sp.vel.clone().multiplyScalar(dt));
    const t=sp.life/sp.maxLife;sp.mesh.scale.setScalar(1+t*2);sp.mesh.material.opacity=0.3*(1-t);
    if(sp.life>=sp.maxLife){scene.remove(sp.mesh);smokeParticles.splice(i,1)}
  }

  // Falling leaves
  leafTimer+=dt;
  if(leafTimer>2.5&&harvestables.some(h=>h.type==='tree')){
    leafTimer=0;
    if(Math.random()>0.5){
      const lm=new THREE.Mesh(new THREE.PlaneGeometry(0.08,0.12),new THREE.MeshStandardMaterial({color:[0x66aa33,0x88cc44,0xddaa33][randInt(0,2)],side:THREE.DoubleSide}));
      const x=rand(-30,30),z=rand(-30,30);lm.position.set(x,rand(4,8),z);scene.add(lm);
      particles.push({mesh:lm,type:'leaf',vel:new THREE.Vector3(rand(-0.2,0.2),-rand(0.3,0.8),rand(-0.2,0.2)),spin:new THREE.Vector3(rand(-2,2),rand(-1,1),rand(-2,2)),life:rand(4,8),maxLife:8});
    }
  }
  // Leaf particles
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i];
    if(p.type==='leaf'){p.life-=dt;p.mesh.position.add(p.vel.clone().multiplyScalar(dt));p.mesh.rotation.x+=p.spin.x*dt;p.mesh.rotation.z+=p.spin.z*dt;p.vel.x+=Math.sin(gameTime*2+p.mesh.position.y)*dt*0.5;if(p.life<=0||p.mesh.position.y<=getY(p.mesh.position.x,p.mesh.position.z)){scene.remove(p.mesh);particles.splice(i,1)}}
  }

  // Water animation
  lake.position.y=getY(-22,15)+0.12+Math.sin(gameTime*1.5)*0.03;

  // Data accumulation from sensors (continuous)
  dataTimer+=dt;
  if(dataTimer>=1){
    dataTimer=0;
    let dataPerSec=0;
    for(const [bk,sensors] of Object.entries(installedSensors)){
      for(const sk of sensors){const sd=IOT_SENSORS[sk];if(sd)dataPerSec+=sd.dataGen}
    }
    if(dataPerSec>0){R.data+=dataPerSec;updateHUD()}
  }

  // Ghost pulse
  if(buildingGhost&&selectedBuilding){
    const afford=canAfford(BUILDINGS[selectedBuilding].cost);
    buildingGhost.material.color.set(afford?0x4CAF50:0xff4444);
    buildingGhost.children[0].material.color.set(afford?0x66bb6a:0xff6666);
    buildingGhost.position.y+=Math.sin(gameTime*3)*0.002;
  }

  // Dashboard auto-refresh
  dashTimer+=dt;
  if(dashTimer>2&&currentTab==='dash'){dashTimer=0;renderDashboard()}

  controls.update();
  composer.render();
}
animate();

// ═══════════════════════════════════════
// START & EVENTS
// ═══════════════════════════════════════
window.startGame = function(){
  document.getElementById('intro').style.display='none';
  document.getElementById('tab-bar').style.display='flex';
  gameStarted=true;
  renderBuildMenu();
  updateHUD();
  addLog('🌱 Bienvenue dans SmartFarm!','info');
  addLog('📋 Objectif: construis et optimise ta ferme','info');
  showMessage('Recolte bois et pierre pour commencer!','#66bb6a');
  setTimeout(()=>showMessage('Construis ta cabane en premier!','#FFD54F'),3500);
};

window.addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);
});

window.addEventListener('keydown',(e)=>{
  if(e.key==='Escape'){selectedBuilding=null;selectedIoT=null;removeGhost();renderBuildMenu()}
  const n=parseInt(e.key);
  if(n>=1&&n<=9){const keys=Object.keys(BUILDINGS);if(n<=keys.length){const k=keys[n-1];if(BUILDINGS[k].unlocked&&!BUILDINGS[k].built){selectedBuilding=k;selectedIoT=null;showGhost(k);renderBuildMenu()}}}
});
