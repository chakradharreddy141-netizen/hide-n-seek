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

function makeRoom(name, hostSocket) {
  const code = genCode();
  const room = {
    code,
    name,
    hostId: hostSocket.id,
    players: new Map(),
    state: 'lobby', // lobby | hiding | seeking | ended
    settings: { seekerCount: 1, duration: 20, blipInterval: 3, blipDuration: 5, hidingGap: 120 },
    // game runtime
    seekers: new Set(),
    hiders: new Set(),
    locations: new Map(),
    stats: { catches: new Map(), caughtAt: new Map(), startTime: null },
    zoneLevel: 0,
    eventIndex: 0,      // toggles 0=blip, 1=shrink
    eventTimer: null,
    gameTimer: null,
    shrinkBannerTimer: null,
    distanceTravelled: new Map(),
    lastPositions: new Map()
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, socket, name) {
  room.players.set(socket.id, { id: socket.id, name, ready: false });
  socket.join(room.code);
  socket.roomCode = room.code;
  socket.playerName = name;
}

function broadcastLobby(room) {
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, isHost: p.id === room.hostId
  }));
  io.to(room.code).emit('lobby:update', {
    roomName: room.name,
    code: room.code,
    players,
    settings: room.settings,
    hostId: room.hostId
  });
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
  room.stats.startTime = Date.now();
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
    hidingGap: room.settings.hidingGap,
    duration: room.settings.duration,
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
  // collect hider locations
  const hiderLocs = [];
  for (const hiderId of room.hiders) {
    const loc = room.locations.get(hiderId);
    if (loc) {
      hiderLocs.push({ id: hiderId, name: room.players.get(hiderId)?.name, lat: loc.lat, lng: loc.lng });
    }
  }

  // send to seekers only
  for (const seekerId of room.seekers) {
    io.to(seekerId).emit('blip:start', { hiders: hiderLocs, duration: room.settings.blipDuration });
  }

  // notify hiders
  for (const hiderId of room.hiders) {
    io.to(hiderId).emit('blip:revealed');
  }

  // end blip after duration
  setTimeout(() => {
    for (const seekerId of room.seekers) {
      io.to(seekerId).emit('blip:end');
    }
  }, room.settings.blipDuration * 1000);
}

function fireShrink(room) {
  if (room.zoneLevel >= ZONE_LEVELS.length - 1) return; // no more shrinks

  room.zoneLevel++;
  const zoneData = ZONE_LEVELS[room.zoneLevel];

  io.to(room.code).emit('shrink:start', {
    zoneLevel: room.zoneLevel,
    zoneData,
    bannerDuration: 150 // 2.5 min in seconds
  });

  // dismiss banner after 2.5 min
  if (room.shrinkBannerTimer) clearTimeout(room.shrinkBannerTimer);
  room.shrinkBannerTimer = setTimeout(() => {
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

  // tell the caught player to switch role
  io.to(hiderId).emit('game:roleSwitch', { newRole: 'seeker' });

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

  // build stats
  const playerStats = [];
  for (const [id, player] of room.players) {
    const catches = room.stats.catches.get(id) || 0;
    const caughtAt = room.stats.caughtAt.get(id);
    const distance = Math.round(room.distanceTravelled.get(id) || 0);
    const wasOriginalSeeker = ![...room.hiders].includes(id) && !room.stats.caughtAt.has(id) && room.seekers.has(id);
    // ponytail: survival time is either when caught or full game duration
    const survived = caughtAt != null ? caughtAt : (wasOriginalSeeker ? null : gameDuration);

    playerStats.push({
      id, name: player.name, catches, caughtAt,
      survived, distance, wasOriginalSeeker
    });
  }

  // find last survivor (hider who survived longest or was never caught)
  const hiderStats = playerStats.filter(p => !p.wasOriginalSeeker);
  hiderStats.sort((a, b) => (b.survived || Infinity) - (a.survived || Infinity));
  const lastSurvivor = hiderStats[0]?.name || 'N/A';

  // top hunter
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

  // clean up room after 60s
  setTimeout(() => rooms.delete(room.code), 60000);
}

// ── Socket handlers ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('room:create', ({ playerName, roomName }, cb) => {
    const room = makeRoom(roomName, socket);
    addPlayer(room, socket, playerName);
    cb({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('room:join', ({ playerName, code }, cb) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.state !== 'lobby') return cb({ ok: false, error: 'Game already in progress' });
    addPlayer(room, socket, playerName);
    cb({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('room:settings', (settings) => {
    const room = rooms.get(socket.roomCode);
    if (!room || socket.id !== room.hostId) return;
    Object.assign(room.settings, settings);
    broadcastLobby(room);
  });

  socket.on('game:startRequest', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.players.size < 2) return;
    startGame(room);
  });

  socket.on('location:update', ({ lat, lng }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state === 'lobby' || room.state === 'ended') return;

    const prev = room.locations.get(socket.id);
    room.locations.set(socket.id, { lat, lng, ts: Date.now() });

    // track distance
    if (prev) {
      const d = haversine(prev.lat, prev.lng, lat, lng);
      if (d < 200) { // ignore GPS jumps > 200m
        room.distanceTravelled.set(socket.id, (room.distanceTravelled.get(socket.id) || 0) + d);
      }
    }
  });

  socket.on('game:catch', ({ hiderId }, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'seeking') return cb?.({ ok: false });
    const ok = catchHider(room, socket.id, hiderId);
    cb?.({ ok });
  });

  socket.on('game:nearbyHiders', (_, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'seeking' || !room.seekers.has(socket.id)) return cb?.([]);
    const myLoc = room.locations.get(socket.id);
    if (!myLoc) return cb?.([]);

    const nearby = [];
    for (const hiderId of room.hiders) {
      const loc = room.locations.get(hiderId);
      if (loc) {
        const dist = haversine(myLoc.lat, myLoc.lng, loc.lat, loc.lng);
        if (dist <= 100) {
          nearby.push({ id: hiderId, name: room.players.get(hiderId)?.name, distance: Math.round(dist) });
        }
      }
    }
    nearby.sort((a, b) => a.distance - b.distance);
    cb?.(nearby);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.players.delete(socket.id);
    room.seekers.delete(socket.id);
    room.hiders.delete(socket.id);
    room.locations.delete(socket.id);

    if (room.players.size === 0) {
      if (room.eventTimer) clearTimeout(room.eventTimer);
      if (room.gameTimer) clearTimeout(room.gameTimer);
      if (room.shrinkBannerTimer) clearTimeout(room.shrinkBannerTimer);
      rooms.delete(room.code);
      return;
    }

    // transfer host if needed
    if (socket.id === room.hostId) {
      room.hostId = room.players.keys().next().value;
    }

    if (room.state === 'lobby') {
      broadcastLobby(room);
    } else if (room.state === 'seeking' && room.hiders.size === 0) {
      endGame(room, 'allCaught');
    }
  });
});

// ── Start server ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Hide N Seek running on http://localhost:${PORT}`);
});
