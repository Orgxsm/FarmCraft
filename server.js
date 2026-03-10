const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingTimeout: 30000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════
const MAP_SIZE = 200;
const GRID_SIZE = 2; // snap grid
const PRODUCTION_INTERVAL = 8; // seconds
const HARVEST_RESPAWN_TIME = 12000; // ms
const PLAYER_COLORS = ['#66bb6a','#42a5f5','#ff7043','#ab47bc','#ffca28','#26c6da','#ec407a','#8d6e63'];
const MAX_PLAYERS = 8;
const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SAVE_INTERVAL = 30000; // save every 30s

// ═══════════════════════════════════════
// BUILDING DEFINITIONS (shared)
// ═══════════════════════════════════════
const BUILDINGS = {
  cabin:{ name:'Cabane',icon:'🏡',cost:{wood:8,stone:4},size:[3,3],production:null,prerequisite:null,category:'farm' },
  well:{ name:'Puits',icon:'🪣',cost:{wood:5,stone:6},size:[2,2],production:{water:2},prerequisite:'cabin',category:'farm' },
  field:{ name:'Champ',icon:'🌾',cost:{wood:6,stone:3},size:[5,5],production:{food:3},consumption:{water:1},prerequisite:'well',category:'farm' },
  barn:{ name:'Grange',icon:'🏚️',cost:{wood:18,stone:10},size:[4,3],production:null,prerequisite:'field',category:'farm' },
  coop:{ name:'Poulailler',icon:'🐔',cost:{wood:12,stone:5,food:8},size:[3,3],production:{gold:2},consumption:{food:2},prerequisite:'barn',category:'farm' },
  greenhouse:{ name:'Serre',icon:'🍅',cost:{wood:20,stone:15,gold:5},size:[4,4],production:{food:4},consumption:{water:2},prerequisite:'barn',category:'farm' },
  pasture:{ name:'Enclos',icon:'🐄',cost:{wood:25,stone:12,food:15},size:[5,5],production:{gold:3},consumption:{food:3},prerequisite:'coop',category:'farm' },
  silo:{ name:'Silo',icon:'🏗️',cost:{wood:22,stone:18,gold:8},size:[3,3],production:{gold:1},prerequisite:'greenhouse',category:'farm' },
  windmill:{ name:'Moulin',icon:'⚙️',cost:{wood:28,stone:20,gold:10},size:[3,3],production:{food:6},consumption:{water:1},prerequisite:'silo',category:'farm' },
  solar:{ name:'Solaire',icon:'☀️',cost:{stone:15,gold:12},size:[4,3],production:{energy:5},prerequisite:'cabin',category:'tech' },
  antenna:{ name:'Antenne',icon:'📡',cost:{stone:10,gold:8,energy:5},size:[2,2],production:{data:1},prerequisite:'solar',category:'tech',coverageRadius:18 },
  server:{ name:'Serveur',icon:'🖥️',cost:{stone:20,gold:20,energy:10},size:[3,3],production:{data:3},consumption:{energy:3},prerequisite:'antenna',category:'tech' }
};

// ═══════════════════════════════════════
// WORLD STATE
// ═══════════════════════════════════════
const world = {
  players: {},        // socketId -> playerState
  harvestables: [],   // {id, type, treeType, x, z, hp, maxHp, resource, amount}
  animals: [],        // {id, type, x, z, rot, targetX, targetZ, speed, moving}
  occupiedCells: new Set(), // "x,z" strings for collision
  nextHarvestId: 0,
  nextAnimalId: 0
};

// Spawn positions for players (spread around the map)
const SPAWN_POINTS = [
  { x: 0, z: 0 },
  { x: 50, z: 50 },
  { x: -50, z: 50 },
  { x: 50, z: -50 },
  { x: -50, z: -50 },
  { x: 0, z: 60 },
  { x: 60, z: 0 },
  { x: -60, z: 0 }
];

// Saved sessions: name -> player state (persists across disconnects AND restarts)
const savedSessions = {};
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24h (longer since we persist to disk)
const sessionTimers = {};

function createPlayerState(id, name, spawnIndex) {
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length];
  return {
    id,
    name: name || `Joueur ${spawnIndex + 1}`,
    color: PLAYER_COLORS[spawnIndex % PLAYER_COLORS.length],
    spawnIndex,
    spawn,
    resources: { wood: 0, stone: 0, water: 0, food: 0, energy: 0, gold: 0, data: 0 },
    buildings: {}, // buildingId -> {type, built, x, z, health}
    buildingCounter: 0,
    unlockedBuildings: ['cabin'],
    installedSensors: {},
    unlockedTech: [],
    productionTimers: {},
    position: { x: spawn.x, z: spawn.z },
    rotation: 0
  };
}

// ═══════════════════════════════════════
// STATE PERSISTENCE
// ═══════════════════════════════════════
function saveState() {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const state = {
      harvestables: world.harvestables,
      nextHarvestId: world.nextHarvestId,
      animals: world.animals.map(a => ({ id: a.id, type: a.type, x: a.x, z: a.z, rot: a.rot })),
      nextAnimalId: world.nextAnimalId,
      savedSessions: { ...savedSessions },
      // Also save currently connected players as sessions
      connectedPlayers: {}
    };
    // Save connected players too so they survive restarts
    for (const [sid, player] of Object.entries(world.players)) {
      state.connectedPlayers[player.name] = { ...player };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log(`State saved (${Object.keys(state.savedSessions).length} sessions, ${Object.keys(state.connectedPlayers).length} active players, ${world.animals.length} animals)`);
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    // Restore harvestables
    if (data.harvestables && data.harvestables.length > 0) {
      world.harvestables = data.harvestables;
      world.nextHarvestId = data.nextHarvestId || 0;
    } else {
      return false; // no valid state, generate fresh
    }

    // Restore animals
    if (data.animals && data.animals.length > 0) {
      world.nextAnimalId = data.nextAnimalId || 0;
      for (const a of data.animals) {
        const animal = createAnimal(a.type, a.x, a.z, a.id);
        animal.rot = a.rot || 0;
        world.animals.push(animal);
      }
    }

    // Restore saved sessions
    if (data.savedSessions) {
      for (const [name, session] of Object.entries(data.savedSessions)) {
        savedSessions[name] = session;
      }
    }
    // Restore connected players as saved sessions (they were connected when server stopped)
    if (data.connectedPlayers) {
      for (const [name, session] of Object.entries(data.connectedPlayers)) {
        if (!savedSessions[name]) {
          savedSessions[name] = session;
        }
      }
    }

    console.log(`State loaded: ${world.harvestables.length} harvestables, ${world.animals.length} animals, ${Object.keys(savedSessions).length} saved sessions`);
    return true;
  } catch (e) {
    console.error('Failed to load state:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════
// HARVESTABLE SPAWNING
// ═══════════════════════════════════════
function spawnHarvestables() {
  world.harvestables = [];
  world.nextHarvestId = 0;

  // Trees: 120 spread across the large map
  const treeZones = [];
  for (let i = 0; i < 120; i++) {
    const x = (Math.random() - 0.5) * (MAP_SIZE - 20);
    const z = (Math.random() - 0.5) * (MAP_SIZE - 20);
    treeZones.push({ id: world.nextHarvestId++, type: 'tree', treeType: Math.floor(Math.random() * 3), x, z, hp: 3, maxHp: 3, resource: 'wood', amount: 3 });
  }

  // Rocks: 60 spread across the map
  const rockZones = [];
  for (let i = 0; i < 60; i++) {
    const x = (Math.random() - 0.5) * (MAP_SIZE - 20);
    const z = (Math.random() - 0.5) * (MAP_SIZE - 20);
    rockZones.push({ id: world.nextHarvestId++, type: 'rock', x, z, hp: 3, maxHp: 3, resource: 'stone', amount: 2 });
  }

  world.harvestables = [...treeZones, ...rockZones];
}

function respawnHarvestable(type) {
  const x = (Math.random() - 0.5) * (MAP_SIZE - 20);
  const z = (Math.random() - 0.5) * (MAP_SIZE - 20);
  const h = {
    id: world.nextHarvestId++,
    type,
    x, z,
    hp: 3, maxHp: 3,
    resource: type === 'tree' ? 'wood' : 'stone',
    amount: type === 'tree' ? 3 : 2
  };
  if (type === 'tree') h.treeType = Math.floor(Math.random() * 3);
  world.harvestables.push(h);
  io.emit('harvestableSpawned', h);
}

// ═══════════════════════════════════════
// ANIMALS
// ═══════════════════════════════════════
function createAnimal(type, x, z, id) {
  const speeds = { chicken: 2.5, cow: 1.2, pig: 1.8 };
  return {
    id: id !== undefined ? id : world.nextAnimalId++,
    type,
    x: x !== undefined ? x : (Math.random() - 0.5) * (MAP_SIZE - 40),
    z: z !== undefined ? z : (Math.random() - 0.5) * (MAP_SIZE - 40),
    rot: Math.random() * Math.PI * 2,
    targetX: 0,
    targetZ: 0,
    speed: speeds[type] || 1.5,
    moving: false,
    waitTimer: 0
  };
}

function spawnAnimals() {
  world.animals = [];
  world.nextAnimalId = 0;
  for (let i = 0; i < 10; i++) world.animals.push(createAnimal('chicken'));
  for (let i = 0; i < 6; i++) world.animals.push(createAnimal('cow'));
  for (let i = 0; i < 6; i++) world.animals.push(createAnimal('pig'));
  // Set initial targets
  world.animals.forEach(a => setNewAnimalTarget(a));
}

function setNewAnimalTarget(animal) {
  const range = 20;
  animal.targetX = animal.x + (Math.random() - 0.5) * range;
  animal.targetZ = animal.z + (Math.random() - 0.5) * range;
  const half = MAP_SIZE / 2 - 10;
  animal.targetX = Math.max(-half, Math.min(half, animal.targetX));
  animal.targetZ = Math.max(-half, Math.min(half, animal.targetZ));
  animal.moving = true;
}

function updateAnimals(dt) {
  for (const animal of world.animals) {
    if (animal.waitTimer > 0) {
      animal.waitTimer -= dt;
      animal.moving = false;
      continue;
    }

    const dx = animal.targetX - animal.x;
    const dz = animal.targetZ - animal.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.5) {
      animal.moving = false;
      // Wait 2-6 seconds then pick new target
      animal.waitTimer = 2 + Math.random() * 4;
      setNewAnimalTarget(animal);
    } else {
      animal.moving = true;
      const step = animal.speed * dt;
      animal.x += (dx / dist) * step;
      animal.z += (dz / dist) * step;
      animal.rot = Math.atan2(dx, dz);
    }
  }
}

// Update animals at ~20Hz
let lastAnimalUpdate = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastAnimalUpdate) / 1000;
  lastAnimalUpdate = now;
  updateAnimals(dt);
}, 50);

// Broadcast animal positions at 4Hz
setInterval(() => {
  if (Object.keys(world.players).length === 0) return;
  io.emit('animalsUpdate', world.animals.map(a => ({
    id: a.id, type: a.type, x: a.x, z: a.z, rot: a.rot, moving: a.moving
  })));
}, 250);

// ═══════════════════════════════════════
// GRID & COLLISION
// ═══════════════════════════════════════
function snapToGrid(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

function getBuildingCells(x, z, sizeX, sizeZ) {
  const cells = [];
  const sx = snapToGrid(x);
  const sz = snapToGrid(z);
  for (let dx = 0; dx < sizeX; dx += GRID_SIZE) {
    for (let dz = 0; dz < sizeZ; dz += GRID_SIZE) {
      cells.push(`${sx + dx},${sz + dz}`);
    }
  }
  return cells;
}

function canPlaceBuilding(x, z, sizeX, sizeZ) {
  const cells = getBuildingCells(x, z, sizeX, sizeZ);
  for (const c of cells) {
    if (world.occupiedCells.has(c)) return false;
  }
  // Check map bounds
  const sx = snapToGrid(x);
  const sz = snapToGrid(z);
  const half = MAP_SIZE / 2 - 10;
  if (Math.abs(sx) > half || Math.abs(sz) > half) return false;
  if (Math.abs(sx + sizeX) > half || Math.abs(sz + sizeZ) > half) return false;
  return true;
}

function occupyCells(x, z, sizeX, sizeZ) {
  const cells = getBuildingCells(x, z, sizeX, sizeZ);
  cells.forEach(c => world.occupiedCells.add(c));
}

// ═══════════════════════════════════════
// PRODUCTION LOGIC (server-side)
// ═══════════════════════════════════════
function runProduction() {
  for (const [pid, player] of Object.entries(world.players)) {
    const produced = {};
    for (const [bid, bdata] of Object.entries(player.buildings)) {
      if (!bdata.built) continue;
      const bdef = BUILDINGS[bdata.type];
      if (!bdef || !bdef.production) continue;

      // Health check
      if (bdata.health < 30) continue;
      const hpMult = bdata.health > 70 ? 1 : bdata.health / 100;

      // Check consumption
      if (bdef.consumption) {
        let canProduce = true;
        for (const [r, v] of Object.entries(bdef.consumption)) {
          if ((player.resources[r] || 0) < v) { canProduce = false; break; }
        }
        if (!canProduce) continue;
        for (const [r, v] of Object.entries(bdef.consumption)) {
          player.resources[r] -= v;
        }
      }

      // Produce
      for (const [r, v] of Object.entries(bdef.production)) {
        const amount = v * hpMult;
        player.resources[r] = (player.resources[r] || 0) + amount;
        if (!produced[r]) produced[r] = 0;
        produced[r] += amount;
      }

      // Health degradation
      bdata.health = Math.max(0, bdata.health - 0.5);
    }

    // Notify player of production
    if (Object.keys(produced).length > 0) {
      const socket = io.sockets.sockets.get(pid);
      if (socket) {
        socket.emit('production', { resources: player.resources, produced });
      }
    }
  }
}

// Run production every PRODUCTION_INTERVAL seconds
setInterval(runProduction, PRODUCTION_INTERVAL * 1000);

// ═══════════════════════════════════════
// SOCKET.IO CONNECTION
// ═══════════════════════════════════════
io.on('connection', (socket) => {
  const playerCount = Object.keys(world.players).length;

  if (playerCount >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect();
    return;
  }

  console.log(`Player connected: ${socket.id} (${playerCount + 1}/${MAX_PLAYERS})`);

  // ─── JOIN ───
  socket.on('join', (data) => {
    // Prevent double-join
    if (world.players[socket.id]) {
      console.log(`${world.players[socket.id].name} tried to join again, ignoring`);
      return;
    }
    const name = (data.name || '').trim().substring(0, 16) || `Joueur ${playerCount + 1}`;
    let player;
    let restored = false;

    // Check for saved session
    if (savedSessions[name]) {
      player = savedSessions[name];
      player.id = socket.id; // Update socket id
      delete savedSessions[name];
      // Clear expiry timer
      if (sessionTimers[name]) { clearTimeout(sessionTimers[name]); delete sessionTimers[name]; }
      // Re-occupy cells for restored buildings
      for (const [bid, bdata] of Object.entries(player.buildings)) {
        if (bdata.built) {
          const bdef = BUILDINGS[bdata.type];
          if (!bdef) continue;
          const cells = getBuildingCells(bdata.x, bdata.z, bdef.size[0], bdef.size[1]);
          cells.forEach(c => world.occupiedCells.add(c));
        }
      }
      restored = true;
      console.log(`${name} restored session (spawn ${player.spawnIndex})`);
    } else {
      const spawnIndex = playerCount;
      player = createPlayerState(socket.id, name, spawnIndex);
      console.log(`${name} joined at spawn ${spawnIndex}`);
    }

    world.players[socket.id] = player;

    // Send full world state to player
    socket.emit('joined', {
      playerId: socket.id,
      player,
      players: getPlayersPublic(),
      harvestables: world.harvestables,
      animals: world.animals.map(a => ({ id: a.id, type: a.type, x: a.x, z: a.z, rot: a.rot, moving: a.moving })),
      mapSize: MAP_SIZE,
      gridSize: GRID_SIZE,
      buildings: BUILDINGS,
      restored
    });

    // Notify others
    socket.broadcast.emit('playerJoined', getPlayerPublic(socket.id));
  });

  // ─── HARVEST ───
  socket.on('harvest', (data) => {
    const player = world.players[socket.id];
    if (!player) return;

    const h = world.harvestables.find(h => h.id === data.id);
    if (!h || h.hp <= 0) return;

    h.hp--;
    io.emit('harvestableHit', { id: h.id, hp: h.hp, playerId: socket.id });

    if (h.hp <= 0) {
      // Give resources to the player who harvested
      player.resources[h.resource] += h.amount;
      socket.emit('resourceUpdate', player.resources);

      io.emit('harvestableDestroyed', { id: h.id, playerId: socket.id, resource: h.resource, amount: h.amount });

      // Remove and respawn
      const type = h.type;
      const idx = world.harvestables.indexOf(h);
      if (idx >= 0) world.harvestables.splice(idx, 1);

      setTimeout(() => respawnHarvestable(type), HARVEST_RESPAWN_TIME);
    }
  });

  // ─── BUILD ───
  socket.on('build', (data) => {
    const player = world.players[socket.id];
    if (!player) return;
    const { key, x, z } = data;
    const bdef = BUILDINGS[key];
    if (!bdef) return;

    // Validate: unlocked, can afford, can place
    if (!player.unlockedBuildings.includes(key)) return;

    for (const [r, v] of Object.entries(bdef.cost)) {
      if ((player.resources[r] || 0) < v) {
        socket.emit('buildError', 'Ressources insuffisantes!');
        return;
      }
    }

    const sx = snapToGrid(x);
    const sz = snapToGrid(z);
    if (!canPlaceBuilding(sx, sz, bdef.size[0], bdef.size[1])) {
      socket.emit('buildError', 'Emplacement occupe!');
      return;
    }

    // Deduct resources
    for (const [r, v] of Object.entries(bdef.cost)) {
      player.resources[r] -= v;
    }

    // Place building with unique ID
    const buildingId = `${key}_${player.buildingCounter++}`;
    occupyCells(sx, sz, bdef.size[0], bdef.size[1]);
    player.buildings[buildingId] = { type: key, built: true, x: sx, z: sz, health: 100 };

    // Unlock next buildings (first time building this type)
    for (const [bk, bd] of Object.entries(BUILDINGS)) {
      if (bd.prerequisite === key && !player.unlockedBuildings.includes(bk)) {
        player.unlockedBuildings.push(bk);
      }
    }

    socket.emit('resourceUpdate', player.resources);
    socket.emit('buildingUnlocks', player.unlockedBuildings);

    // Notify all players
    io.emit('buildingPlaced', {
      playerId: socket.id,
      playerName: player.name,
      playerColor: player.color,
      key,
      buildingId,
      x: sx, z: sz,
      building: bdef
    });

    console.log(`${player.name} built ${bdef.name} (${buildingId}) at (${sx}, ${sz})`);

    // Check win condition: at least one of each type
    const allBuilt = Object.keys(BUILDINGS).every(k =>
      Object.values(player.buildings).some(b => b.type === k && b.built)
    );
    if (allBuilt) {
      io.emit('playerWon', { playerId: socket.id, playerName: player.name });
    }
  });

  // ─── REPAIR ───
  socket.on('repair', (data) => {
    const player = world.players[socket.id];
    if (!player) return;
    const b = player.buildings[data.buildingId || data.key];
    if (!b || !b.built) return;

    const cost = Math.ceil((100 - b.health) * 0.1);
    if (player.resources.gold < cost) {
      socket.emit('buildError', 'Pas assez d\'or!');
      return;
    }

    player.resources.gold -= cost;
    b.health = 100;
    socket.emit('resourceUpdate', player.resources);
    socket.emit('buildingRepaired', { key: data.key, health: 100 });
  });

  // ─── PLAYER MOVEMENT ───
  socket.on('playerMove', (data) => {
    const player = world.players[socket.id];
    if (!player) return;
    const half = MAP_SIZE / 2 - 3;
    player.position = {
      x: Math.max(-half, Math.min(half, data.x || 0)),
      z: Math.max(-half, Math.min(half, data.z || 0))
    };
    player.rotation = data.rot || 0;
    socket.broadcast.emit('playerMoved', {
      playerId: socket.id,
      x: player.position.x,
      z: player.position.z,
      rot: player.rotation,
      moving: data.moving || false
    });
  });

  // ─── CHAT ───
  socket.on('chat', (data) => {
    const player = world.players[socket.id];
    if (!player) return;
    const msg = (data.msg || '').trim().substring(0, 200);
    if (!msg) return;
    io.emit('chatMessage', { playerId: socket.id, name: player.name, color: player.color, msg });
  });

  // ─── DISCONNECT ───
  socket.on('disconnect', () => {
    const player = world.players[socket.id];
    if (player) {
      console.log(`${player.name} disconnected — session saved`);
      // Free occupied cells temporarily
      for (const [bid, bdata] of Object.entries(player.buildings)) {
        if (bdata.built) {
          const bdef = BUILDINGS[bdata.type];
          if (!bdef) continue;
          const cells = getBuildingCells(bdata.x, bdata.z, bdef.size[0], bdef.size[1]);
          cells.forEach(c => world.occupiedCells.delete(c));
        }
      }
      // Save session by player name
      savedSessions[player.name] = { ...player };
      // Set expiry timer
      if (sessionTimers[player.name]) clearTimeout(sessionTimers[player.name]);
      sessionTimers[player.name] = setTimeout(() => {
        delete savedSessions[player.name];
        delete sessionTimers[player.name];
        console.log(`Session expired for ${player.name}`);
      }, SESSION_TIMEOUT);

      delete world.players[socket.id];
      io.emit('playerLeft', { playerId: socket.id, playerName: player.name });

      // Save state after disconnect
      saveState();
    }
  });
});

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function getPlayerPublic(id) {
  const p = world.players[id];
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    spawn: p.spawn,
    buildings: p.buildings,
    position: p.position,
    rotation: p.rotation
  };
}

function getPlayersPublic() {
  const result = {};
  for (const [id, p] of Object.entries(world.players)) {
    result[id] = getPlayerPublic(id);
  }
  return result;
}

// ═══════════════════════════════════════
// INIT & START
// ═══════════════════════════════════════

// Try to load saved state, otherwise generate fresh
const loaded = loadState();
if (!loaded) {
  console.log('No saved state found, generating fresh world...');
  spawnHarvestables();
  spawnAnimals();
} else {
  // If animals weren't loaded (old save format), spawn them
  if (world.animals.length === 0) {
    spawnAnimals();
  }
}

// Periodic state save
setInterval(saveState, SAVE_INTERVAL);

// Save state on shutdown
function gracefulShutdown(signal) {
  console.log(`\n${signal} received, saving state...`);
  saveState();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SmartFarm Multiplayer server running on port ${PORT}`);
  console.log(`Map size: ${MAP_SIZE}x${MAP_SIZE}, Max players: ${MAX_PLAYERS}`);
  console.log(`Animals: ${world.animals.length}, Harvestables: ${world.harvestables.length}`);
});
