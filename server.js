const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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
  occupiedCells: new Set(), // "x,z" strings for collision
  nextHarvestId: 0
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

function createPlayerState(id, name, spawnIndex) {
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length];
  return {
    id,
    name: name || `Joueur ${spawnIndex + 1}`,
    color: PLAYER_COLORS[spawnIndex % PLAYER_COLORS.length],
    spawnIndex,
    spawn,
    resources: { wood: 0, stone: 0, water: 0, food: 0, energy: 0, gold: 0, data: 0 },
    buildings: {}, // key -> {built, x, z, health}
    unlockedBuildings: ['cabin'], // prerequisite chain
    installedSensors: {},
    unlockedTech: [],
    productionTimers: {},
    cameraPos: { x: spawn.x, z: spawn.z }
  };
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
    for (const [key, bdata] of Object.entries(player.buildings)) {
      if (!bdata.built) continue;
      const bdef = BUILDINGS[key];
      if (!bdef.production) continue;

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
    const name = (data.name || '').trim().substring(0, 16) || `Joueur ${playerCount + 1}`;
    const spawnIndex = playerCount;
    const player = createPlayerState(socket.id, name, spawnIndex);
    world.players[socket.id] = player;

    // Send full world state to new player
    socket.emit('joined', {
      playerId: socket.id,
      player,
      players: getPlayersPublic(),
      harvestables: world.harvestables,
      mapSize: MAP_SIZE,
      gridSize: GRID_SIZE,
      buildings: BUILDINGS
    });

    // Notify others
    socket.broadcast.emit('playerJoined', getPlayerPublic(socket.id));
    console.log(`${name} joined at spawn ${spawnIndex}`);
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

    // Validate: not already built, unlocked, can afford, can place
    if (player.buildings[key]?.built) return;
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

    // Place building
    occupyCells(sx, sz, bdef.size[0], bdef.size[1]);
    player.buildings[key] = { built: true, x: sx, z: sz, health: 100 };

    // Unlock next buildings
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
      x: sx, z: sz,
      building: bdef
    });

    console.log(`${player.name} built ${bdef.name} at (${sx}, ${sz})`);

    // Check win condition
    const allBuilt = Object.keys(BUILDINGS).every(k => player.buildings[k]?.built);
    if (allBuilt) {
      io.emit('playerWon', { playerId: socket.id, playerName: player.name });
    }
  });

  // ─── REPAIR ───
  socket.on('repair', (data) => {
    const player = world.players[socket.id];
    if (!player) return;
    const b = player.buildings[data.key];
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

  // ─── CAMERA POSITION (for showing other players) ───
  socket.on('cameraMove', (data) => {
    const player = world.players[socket.id];
    if (!player) return;
    player.cameraPos = { x: data.x, z: data.z };
    socket.broadcast.emit('playerMoved', { playerId: socket.id, x: data.x, z: data.z });
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
      console.log(`${player.name} disconnected`);
      // Free occupied cells from this player's buildings
      for (const [key, bdata] of Object.entries(player.buildings)) {
        if (bdata.built) {
          const bdef = BUILDINGS[key];
          const cells = getBuildingCells(bdata.x, bdata.z, bdef.size[0], bdef.size[1]);
          cells.forEach(c => world.occupiedCells.delete(c));
        }
      }
      delete world.players[socket.id];
      io.emit('playerLeft', { playerId: socket.id, playerName: player.name });
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
    cameraPos: p.cameraPos
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
spawnHarvestables();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SmartFarm Multiplayer server running on port ${PORT}`);
  console.log(`Map size: ${MAP_SIZE}x${MAP_SIZE}, Max players: ${MAX_PLAYERS}`);
});
