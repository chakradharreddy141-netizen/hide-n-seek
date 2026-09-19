const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Zone data (hardcoded from campus maps) ──────────────────────────
const ZONE_LEVELS = [
  {
    image: 'map_1.jpg',
    included: ['A Block','B Block','D Block','E Block','F Block','G Block','H Block','I Block','J Block','K Block','Lib Lawns','LTC Lobby','OAT','Rock Garden','Central Workshop'],
    excluded: ['Audi','Lib'],
    newlyExcluded: []
  },
  {
    image: 'map_2.jpg',
    included: ['A Block','B Block','D Block','E Block','F Block','G Block','H Block','I Block','J Block','K Block','Lib Lawns','LTC Lobby','OAT'],
    excluded: ['Audi','Lib','Rock Garden','Central Workshop'],
    newlyExcluded: ['Rock Garden','Central Workshop']
  },
  {
    image: 'map_3.jpg',
    included: ['B Block','D Block','F Block','G Block','H Block','K Block','Lib Lawns','LTC Lobby','OAT'],
    excluded: ['Audi','Lib','Rock Garden','Central Workshop','A Block','E Block','I Block','J Block'],
    newlyExcluded: ['A Block','E Block','I Block','J Block']
  },
  {
    image: 'map_4.jpg',
    included: ['B Block','D Block','F Block','G Block','Lib Lawns','LTC Lobby'],
    excluded: ['Audi','Lib','Rock Garden','Central Workshop','A Block','E Block','H Block','I Block','J Block','K Block','OAT'],
    newlyExcluded: ['H Block','K Block','OAT']
  }
];

// ── In-memory state ─────────────────────────────────────────────────
const rooms = new Map();

function genCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function makeRoom(name, hostPlayerId) {
  const code = genCode();
  const room = {
    code,
    name,
    hostId: hostPlayerId, // now stores playerId, not socket.id
    players: new Map(), // map of playerId -> { name, socketId, online, isReady }
    state: 'lobby', // lobby | hiding | seeking | ended
    settings: { seekerCount: 1, duration: 20, blipInterval: 3, blipDuration: 5, hidingGap: 120 },
    // game runtime
    seekers: new Set(), // set of playerIds
    hiders: new Set(),  // set of playerIds
    locations: new Map(), // map of playerId -> { lat, lng, ts }
    stats: { catches: new Map(), caughtAt: new Map(), startTime: null },
    zoneLevel: 0,
    eventIndex: 0,
    eventTimer: null,
    gameTimer: null,
    shrinkBannerTimer: null,
    distanceTravelled: new Map(),
    lastPositions: new Map(),
    // Absolute timers to prevent desync
    hidingEndTime: null,
    gameEndTime: null,
    blipActive: false,
    bannerActive: false
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, socket, playerId, name) {
  room.players.set(playerId, { id: playerId, socketId: socket.id, name, online: true });
  socket.join(room.code);
  socket.roomCode = room.code;
  socket.playerId = playerId;
}

function broadcastLobby(room) {
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, online: p.online, isHost: p.id === room.hostId
  }));
  io.to(room.code).emit('lobby:update', {
    roomName: room.name,
    code: room.code,
    players,
    settings: room.settings,
    hostId: room.hostId
  });
}

function emitToPlayer(room, playerId, event, data) {
  const p = room.players.get(playerId);
  if (p && p.online) {
    io.to(p.socketId).emit(event, data);
  }
}

// ── Haversine distance (meters) ─────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Game logic ──────────────────────────────────────────────────────
function startGame(room) {
  room.state = 'hiding';
  room.zoneLevel = 0;
  room.eventIndex = 0;
  room.blipActive = false;
  room.bannerActive = false;
  
  const now = Date.now();
  room.stats.startTime = now;
  room.hidingEndTime = now + (room.settings.hidingGap * 1000);
  room.gameEndTime = room.hidingEndTime + (room.settings.duration * 60 * 1000);

  room.stats.catches.clear();
  room.stats.caughtAt.clear();
  room.distanceTravelled.clear();
  room.lastPositions.clear();

  // pick seekers randomly
  const ids = [...room.players.keys()];
  const shuffled = ids.sort(() => Math.random() - 0.5);
  room.seekers = new Set(shuffled.slice(0, room.settings.seekerCount));
  room.hiders = new Set(shuffled.slice(room.settings.seekerCount));

  // init stats
  for (const id of ids) {
    room.stats.catches.set(id, 0);
    room.distanceTravelled.set(id, 0);
  }

  const seekerNames = [...room.seekers].map(id => room.players.get(id)?.name);

  io.to(room.code).emit('game:start', {
    seekers: [...room.seekers],
    seekerNames,
    hiders: [...room.hiders],
    hidingEndTime: room.hidingEndTime,
    gameEndTime: room.gameEndTime,
    zoneLevel: ZONE_LEVELS[0],
    settings: room.settings
  });

  // after hiding gap, start seeking phase
  room.gameTimer = setTimeout(() => {
    room.state = 'seeking';
    io.to(room.code).emit('game:seekingPhase');
    scheduleNextEvent(room);

    // end game timer
    room.gameTimer = setTimeout(() => endGame(room, 'timeout'), room.settings.duration * 60 * 1000);
  }, room.settings.hidingGap * 1000);
}

function scheduleNextEvent(room) {
  if (room.state !== 'seeking') return;
  const intervalMs = room.settings.blipInterval * 60 * 1000;

  room.eventTimer = setTimeout(() => {
    if (room.state !== 'seeking') return;

    if (room.eventIndex % 2 === 0) {
      fireBlip(room);
    } else {
      fireShrink(room);
    }
    room.eventIndex++;
    scheduleNextEvent(room);
  }, intervalMs);
}

function fireBlip(room) {
  room.blipActive = true;
  
  const hiderLocs = [];
  for (const hiderId of room.hiders) {
    const loc = room.locations.get(hiderId);
    if (loc) {
      hiderLocs.push({ id: hiderId, name: room.players.get(hiderId)?.name, lat: loc.lat, lng: loc.lng });
    }
  }

  // send to seekers only
  for (const seekerId of room.seekers) {
    emitToPlayer(room, seekerId, 'blip:start', { hiders: hiderLocs, duration: room.settings.blipDuration });
  }

  // notify hiders
  for (const hiderId of room.hiders) {
    emitToPlayer(room, hiderId, 'blip:revealed');
  }

  // end blip after duration
  setTimeout(() => {
    room.blipActive = false;
    for (const seekerId of room.seekers) {
      emitToPlayer(room, seekerId, 'blip:end');
    }
  }, room.settings.blipDuration * 1000);
}

function fireShrink(room) {
  if (room.zoneLevel >= ZONE_LEVELS.length - 1) return; // no more shrinks

  room.zoneLevel++;
  const zoneData = ZONE_LEVELS[room.zoneLevel];
  room.bannerActive = true;

  io.to(room.code).emit('shrink:start', {
    zoneLevel: room.zoneLevel,
    zoneData,
    bannerDuration: 150 // 2.5 min in seconds
  });

  // dismiss banner after 2.5 min
  if (room.shrinkBannerTimer) clearTimeout(room.shrinkBannerTimer);
  room.shrinkBannerTimer = setTimeout(() => {
    room.bannerActive = false;
    io.to(room.code).emit('shrink:bannerDismiss');
  }, 150 * 1000);
}

function catchHider(room, seekerId, hiderId) {
  if (!room.hiders.has(hiderId) || !room.seekers.has(seekerId)) return false;

  const seekerLoc = room.locations.get(seekerId);
  const hiderLoc = room.locations.get(hiderId);

  // proximity check (~100m tolerance for GPS inaccuracy)
  if (seekerLoc && hiderLoc) {
    const dist = haversine(seekerLoc.lat, seekerLoc.lng, hiderLoc.lat, hiderLoc.lng);
    if (dist > 100) return false;
  }

  // convert hider to seeker
  room.hiders.delete(hiderId);
  room.seekers.add(hiderId);
  room.stats.caughtAt.set(hiderId, Date.now() - room.stats.startTime);
  room.stats.catches.set(seekerId, (room.stats.catches.get(seekerId) || 0) + 1);

  const hiderName = room.players.get(hiderId)?.name;
  const seekerName = room.players.get(seekerId)?.name;

  io.to(room.code).emit('game:caught', {
    hiderId,
    hiderName,
    seekerId,
    seekerName,
    remainingHiders: room.hiders.size
  });

  emitToPlayer(room, hiderId, 'game:roleSwitch', { newRole: 'seeker' });

  // check win condition
  if (room.hiders.size === 0) {
    endGame(room, 'allCaught');
  }

  return true;
}

function endGame(room, reason) {
  room.state = 'ended';
  if (room.eventTimer) clearTimeout(room.eventTimer);
  if (room.gameTimer) clearTimeout(room.gameTimer);
  if (room.shrinkBannerTimer) clearTimeout(room.shrinkBannerTimer);

  const gameDuration = Date.now() - room.stats.startTime;

  const playerStats = [];
  for (const [id, player] of room.players) {
    const catches = room.stats.catches.get(id) || 0;
    const caughtAt = room.stats.caughtAt.get(id);
    const distance = Math.round(room.distanceTravelled.get(id) || 0);
    const wasOriginalSeeker = ![...room.hiders].includes(id) && !room.stats.caughtAt.has(id) && room.seekers.has(id);
    const survived = caughtAt != null ? caughtAt : (wasOriginalSeeker ? null : gameDuration);

    playerStats.push({
      id, name: player.name, catches, caughtAt,
      survived, distance, wasOriginalSeeker
    });
  }

  const hiderStats = playerStats.filter(p => !p.wasOriginalSeeker);
  hiderStats.sort((a, b) => (b.survived || Infinity) - (a.survived || Infinity));
  const lastSurvivor = hiderStats[0]?.name || 'N/A';

  const hunterStats = [...playerStats].sort((a, b) => b.catches - a.catches);
  const topHunter = hunterStats[0]?.catches > 0 ? hunterStats[0].name : 'N/A';

  io.to(room.code).emit('game:end', {
    reason,
    gameDuration,
    lastSurvivor,
    topHunter,
    playerStats,
    zonesEliminated: room.zoneLevel
  });

  setTimeout(() => rooms.delete(room.code), 60000);
}

// ── Socket handlers ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('room:create', ({ playerId, playerName, roomName }, cb) => {
    const room = makeRoom(roomName, playerId);
    addPlayer(room, socket, playerId, playerName);
    cb({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('room:join', ({ playerId, playerName, code }, cb) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ ok: false, error: 'Room not found' });
    
    // Check if rejoining
    if (room.players.has(playerId)) {
      const p = room.players.get(playerId);
      p.socketId = socket.id;
      p.online = true;
      socket.join(room.code);
      socket.roomCode = room.code;
      socket.playerId = playerId;
      
      cb({ ok: true, code: room.code });
      
      // If game is in progress, sync state
      if (room.state === 'hiding' || room.state === 'seeking') {
        socket.emit('game:sync', {
          state: room.state,
          role: room.seekers.has(playerId) ? 'seeker' : 'hider',
          hidingEndTime: room.hidingEndTime,
          gameEndTime: room.gameEndTime,
          zoneLevel: ZONE_LEVELS[room.zoneLevel],
          bannerActive: room.bannerActive,
          blipActive: room.blipActive && room.seekers.has(playerId),
          seekers: [...room.seekers],
          hiders: [...room.hiders]
        });
      } else if (room.state === 'lobby') {
        broadcastLobby(room);
      }
      return;
    }

    if (room.state !== 'lobby') return cb({ ok: false, error: 'Game already in progress' });
    
    addPlayer(room, socket, playerId, playerName);
    cb({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('room:settings', (settings) => {
    const room = rooms.get(socket.roomCode);
    if (!room || socket.playerId !== room.hostId) return;
    Object.assign(room.settings, settings);
    broadcastLobby(room);
  });

  socket.on('game:startRequest', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || socket.playerId !== room.hostId) return;
    if (room.players.size < 2) return;
    startGame(room);
  });

  socket.on('location:update', ({ lat, lng }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state === 'lobby' || room.state === 'ended') return;

    const prev = room.locations.get(socket.playerId);
    room.locations.set(socket.playerId, { lat, lng, ts: Date.now() });

    if (prev) {
      const d = haversine(prev.lat, prev.lng, lat, lng);
      if (d < 200) {
        room.distanceTravelled.set(socket.playerId, (room.distanceTravelled.get(socket.playerId) || 0) + d);
      }
    }
  });

  socket.on('game:catch', ({ hiderId }, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'seeking') return cb?.({ ok: false });
    const ok = catchHider(room, socket.playerId, hiderId);
    cb?.({ ok });
  });

  socket.on('game:nearbyHiders', (_, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'seeking' || !room.seekers.has(socket.playerId)) return cb?.([]);
    const myLoc = room.locations.get(socket.playerId);
    if (!myLoc) return cb?.([]);

    const nearby = [];
    for (const hiderId of room.hiders) {
      const p = room.players.get(hiderId);
      if (!p || !p.online) continue; // optionally ignore offline players for catching? Let's allow catching offline players
      
      const loc = room.locations.get(hiderId);
      if (loc) {
        const dist = haversine(myLoc.lat, myLoc.lng, loc.lat, loc.lng);
        if (dist <= 100) {
          nearby.push({ id: hiderId, name: p.name, distance: Math.round(dist) });
        }
      }
    }
    nearby.sort((a, b) => a.distance - b.distance);
    cb?.(nearby);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const player = room.players.get(socket.playerId);
    if (player) {
      player.online = false;
      player.socketId = null;
    }

    // Determine active players
    let activeCount = 0;
    for (const p of room.players.values()) {
      if (p.online) activeCount++;
    }

    if (activeCount === 0) {
      // If everyone drops, maybe wait a bit before destroying? Let's just let the timer run its course or destroy immediately if lobby
      if (room.state === 'lobby') {
        rooms.delete(room.code);
        return;
      }
    }

    if (room.state === 'lobby') {
      // In lobby, we can safely remove them completely to allow others to join cleanly
      room.players.delete(socket.playerId);
      if (socket.playerId === room.hostId && room.players.size > 0) {
        room.hostId = room.players.keys().next().value;
      }
      broadcastLobby(room);
    } else if (room.state === 'seeking') {
      // If all hiders drop, they are still "hiders", game won't end unless caught or timer.
      // But if we want to end when all active hiders are caught, we'd check online status.
      // For now, offline players remain hiders until caught or timeout.
    }
  });
});

// ── Start server ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Hide N Seek running on http://localhost:${PORT}`);
});
