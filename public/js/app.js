const socket = io();

// State
let myId = null;
let myName = '';
let myRole = ''; // 'seeker' | 'hider'
let roomCode = '';
let isHost = false;

// Geolocation tracking
let watchId = null;
let currentLat = null;
let currentLng = null;

// Leaflet
let map = null;
let myMarker = null;
let hiderMarkers = [];

// DOM Elements
const screens = {
  landing: document.getElementById('screen-landing'),
  menu: document.getElementById('screen-menu'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  stats: document.getElementById('screen-stats')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── Audio Context ──────────────────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(freq = 440, type = 'sine', duration = 0.2) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

// ── Geolocation ────────────────────────────────────────────────────
function startTracking() {
  if (!navigator.geolocation) {
    document.getElementById('landing-error').textContent = 'Geolocation is not supported by your browser';
    return;
  }
  
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      currentLat = pos.coords.latitude;
      currentLng = pos.coords.longitude;
      
      // Update own marker if map exists
      if (map) {
        if (!myMarker) {
          myMarker = L.marker([currentLat, currentLng]).addTo(map);
          map.setView([currentLat, currentLng], 17);
        } else {
          myMarker.setLatLng([currentLat, currentLng]);
          map.setView([currentLat, currentLng]);
        }
      }
      
      // Send to server if in game
      if (roomCode) {
        socket.emit('location:update', { lat: currentLat, lng: currentLng });
      }
    },
    (err) => {
      console.error(err);
      if (screens.landing.classList.contains('active')) {
        document.getElementById('landing-error').textContent = 'Location access denied or failed.';
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
  );
  
  // Init map early so it's ready
  initMap();
}

function initMap() {
  if (map) return;
  map = L.map('gps-map-container', {
    zoomControl: false,
    attributionControl: false,
    dragging: false, // compact map is centered on player
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false
  }).setView([0,0], 17);
  
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(map);
}

// ── Landing & Menu ─────────────────────────────────────────────────
document.getElementById('btn-enter').addEventListener('click', () => {
  const nameInput = document.getElementById('player-name').value.trim();
  if (!nameInput) {
    document.getElementById('landing-error').textContent = 'Please enter a name';
    return;
  }
  myName = nameInput;
  document.getElementById('menu-player-name').textContent = myName;
  startTracking();
  showScreen('menu');
});

document.getElementById('btn-create').addEventListener('click', () => {
  const roomName = document.getElementById('create-room-name').value.trim() || `${myName}'s Game`;
  socket.emit('room:create', { playerName: myName, roomName }, (res) => {
    if (res.ok) {
      roomCode = res.code;
      showScreen('lobby');
    }
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const code = document.getElementById('join-room-code').value.trim().toUpperCase();
  if (code.length !== 6) return;
  socket.emit('room:join', { playerName: myName, code }, (res) => {
    if (res.ok) {
      roomCode = res.code;
      showScreen('lobby');
    } else {
      document.getElementById('menu-error').textContent = res.error;
    }
  });
});

// ── Lobby ──────────────────────────────────────────────────────────
socket.on('lobby:update', (data) => {
  document.getElementById('lobby-room-name').textContent = data.roomName;
  document.getElementById('lobby-room-code').textContent = data.code;
  
  const me = data.players.find(p => p.id === socket.id);
  isHost = me?.isHost;
  
  const playersUl = document.getElementById('lobby-players');
  playersUl.innerHTML = '';
  data.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name} ${p.id === socket.id ? '(You)' : ''}</span> 
                    ${p.isHost ? '<span class="badge-host">HOST</span>' : ''}`;
    playersUl.appendChild(li);
  });
  document.getElementById('lobby-player-count').textContent = data.players.length;
  
  const settingsReadonly = document.getElementById('lobby-settings-readonly');
  const settingsHost = document.getElementById('lobby-settings');
  const btnStart = document.getElementById('btn-start');
  const waitMsg = document.getElementById('waiting-host-msg');
  
  if (isHost) {
    settingsReadonly.classList.add('hidden');
    settingsHost.classList.remove('hidden');
    btnStart.classList.remove('hidden');
    waitMsg.classList.add('hidden');
    
    // Update inputs to match state
    document.getElementById('set-seekers').value = data.settings.seekerCount;
    document.getElementById('set-duration').value = data.settings.duration;
    document.getElementById('set-blip-int').value = data.settings.blipInterval;
    document.getElementById('set-blip-dur').value = data.settings.blipDuration;
    document.getElementById('set-gap').value = data.settings.hidingGap;
  } else {
    settingsHost.classList.add('hidden');
    settingsReadonly.classList.remove('hidden');
    btnStart.classList.add('hidden');
    waitMsg.classList.remove('hidden');
    
    const ul = document.getElementById('settings-list');
    ul.innerHTML = `
      <li>Seekers: ${data.settings.seekerCount}</li>
      <li>Duration: ${data.settings.duration} min</li>
      <li>Blip: every ${data.settings.blipInterval} min (for ${data.settings.blipDuration}s)</li>
      <li>Hiding gap: ${data.settings.hidingGap}s</li>
    `;
  }
});

// Host settings listeners
const settingsInputs = ['set-seekers', 'set-duration', 'set-blip-int', 'set-blip-dur', 'set-gap'];
settingsInputs.forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if (!isHost) return;
    socket.emit('room:settings', {
      seekerCount: parseInt(document.getElementById('set-seekers').value),
      duration: parseInt(document.getElementById('set-duration').value),
      blipInterval: parseInt(document.getElementById('set-blip-int').value),
      blipDuration: parseInt(document.getElementById('set-blip-dur').value),
      hidingGap: parseInt(document.getElementById('set-gap').value)
    });
  });
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('game:startRequest');
});

document.getElementById('btn-leave').addEventListener('click', () => {
  window.location.reload();
});

// ── Game ───────────────────────────────────────────────────────────
let gameEndTimer = null;
let gameEndTime = 0;

function formatTime(ms) {
  if (ms < 0) ms = 0;
  const totalSecs = Math.floor(ms / 1000);
  const m = Math.floor(totalSecs / 60).toString().padStart(2, '0');
  const s = (totalSecs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateZonesUI(zoneData) {
  document.getElementById('map-image').src = `/maps/${zoneData.image}`;
  
  const incUl = document.getElementById('included-areas');
  incUl.innerHTML = '';
  zoneData.included.forEach(area => {
    const li = document.createElement('li');
    li.textContent = area;
    incUl.appendChild(li);
  });
  
  const excUl = document.getElementById('excluded-areas');
  excUl.innerHTML = '';
  zoneData.excluded.forEach(area => {
    const li = document.createElement('li');
    li.textContent = area;
    excUl.appendChild(li);
  });
}

function applyRole(role) {
  myRole = role;
  const badge = document.getElementById('player-role-badge');
  badge.textContent = role.toUpperCase();
  badge.className = `role-badge ${role}`;
  
  if (role === 'seeker') {
    document.getElementById('btn-catch').classList.remove('hidden');
  } else {
    document.getElementById('btn-catch').classList.add('hidden');
  }
}

socket.on('game:start', (data) => {
  showScreen('game');
  
  if (data.seekers.includes(socket.id)) applyRole('seeker');
  else applyRole('hider');
  
  updateZonesUI(data.zoneLevel);
  
  // Hiding phase UI
  document.getElementById('hiding-overlay').classList.remove('hidden');
  
  let gapRemaining = data.hidingGap;
  const gapEl = document.getElementById('hiding-timer');
  gapEl.textContent = formatTime(gapRemaining * 1000);
  
  const int = setInterval(() => {
    gapRemaining--;
    gapEl.textContent = formatTime(gapRemaining * 1000);
    if (gapRemaining <= 3 && gapRemaining > 0) playBeep(330, 'square', 0.1);
    if (gapRemaining <= 0) {
      clearInterval(int);
      playBeep(440, 'square', 0.5);
    }
  }, 1000);
});

socket.on('game:seekingPhase', () => {
  document.getElementById('hiding-overlay').classList.add('hidden');
});

// Overall game timer tick from server isn't strictly necessary, we can just run it client side based on end time
socket.on('game:start', (data) => {
  // start game timer locally
  gameEndTime = Date.now() + (data.settings.hidingGap * 1000) + (data.duration * 60 * 1000);
  if (gameEndTimer) clearInterval(gameEndTimer);
  gameEndTimer = setInterval(() => {
    const ms = gameEndTime - Date.now();
    document.getElementById('game-timer').textContent = formatTime(ms);
  }, 1000);
});

// Role switch for caught hider
socket.on('game:roleSwitch', (data) => {
  applyRole(data.newRole);
});

// Notifications
socket.on('game:caught', (data) => {
  if (data.hiderId === socket.id) {
    alert('YOU WERE CAUGHT! You are now a SEEKER.');
  } else {
    // maybe a small toast, for now just log
    console.log(`${data.hiderName} caught by ${data.seekerName}`);
  }
});

// ── Blip & Shrink Events ───────────────────────────────────────────

function showBanner(title, desc) {
  const banner = document.getElementById('event-banner');
  document.getElementById('event-title').textContent = title;
  document.getElementById('event-desc').textContent = desc;
  banner.classList.remove('hidden');
}
function hideBanner() {
  document.getElementById('event-banner').classList.add('hidden');
}

// Blip warning
let blipWarnInt;
socket.on('blip:start', (data) => {
  // only seekers get this, hiders get 'blip:revealed'
  showBanner('BLIP ACTIVE', 'Hider locations on GPS map!');
  playBeep(880, 'sine', 0.2);
  
  // draw hiders
  hiderMarkers.forEach(m => map.removeLayer(m));
  hiderMarkers = [];
  
  const hiderIcon = L.divIcon({ className: 'hider-marker', iconSize: [15,15] });
  data.hiders.forEach(h => {
    const m = L.marker([h.lat, h.lng], { icon: hiderIcon }).addTo(map);
    hiderMarkers.push(m);
  });
});

socket.on('blip:end', () => {
  hideBanner();
  hiderMarkers.forEach(m => map.removeLayer(m));
  hiderMarkers = [];
});

socket.on('blip:revealed', () => {
  showBanner('BLIPPED', 'Your location is revealed to seekers!');
  playBeep(220, 'sawtooth', 0.4);
  setTimeout(hideBanner, 5000);
});

socket.on('shrink:start', (data) => {
  updateZonesUI(data.zoneData);
  const areas = data.zoneData.newlyExcluded.join(', ');
  showBanner('⚠️ ZONE SHRINKING', `OUT OF BOUNDS: ${areas}`);
  playBeep(110, 'sawtooth', 1.0);
});

socket.on('shrink:bannerDismiss', () => {
  hideBanner();
});

// ── Catch System ───────────────────────────────────────────────────
const btnCatch = document.getElementById('btn-catch');
const modalCatch = document.getElementById('catch-modal');
const listCatch = document.getElementById('nearby-hiders-list');

btnCatch.addEventListener('click', () => {
  socket.emit('game:nearbyHiders', null, (hiders) => {
    listCatch.innerHTML = '';
    if (hiders.length === 0) {
      listCatch.innerHTML = '<p>No hiders nearby.</p>';
    } else {
      hiders.forEach(h => {
        const li = document.createElement('li');
        li.textContent = `${h.name} (${h.distance}m)`;
        li.onclick = () => {
          socket.emit('game:catch', { hiderId: h.id }, (res) => {
            if (res.ok) modalCatch.classList.add('hidden');
            else alert('Failed to catch (too far?)');
          });
        };
        listCatch.appendChild(li);
      });
    }
    modalCatch.classList.remove('hidden');
  });
});

document.getElementById('btn-close-catch').addEventListener('click', () => {
  modalCatch.classList.add('hidden');
});

// ── End Game Stats ─────────────────────────────────────────────────
socket.on('game:end', (data) => {
  if (gameEndTimer) clearInterval(gameEndTimer);
  showScreen('stats');
  
  let reasonMsg = data.reason === 'allCaught' ? 'SEEKERS WIN (All Caught)' : 'HIDERS WIN (Time Limit)';
  document.getElementById('stats-reason').textContent = reasonMsg;
  
  document.getElementById('stat-survivor').textContent = data.lastSurvivor;
  document.getElementById('stat-hunter').textContent = data.topHunter;
  document.getElementById('stat-duration').textContent = formatTime(data.gameDuration);
  document.getElementById('stat-zones').textContent = data.zonesEliminated;
  
  const tbody = document.querySelector('#stats-table tbody');
  tbody.innerHTML = '';
  
  data.playerStats.sort((a,b) => b.catches - a.catches).forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.name} ${p.id === socket.id ? '(You)' : ''}</td>
      <td>${p.wasOriginalSeeker ? 'Seeker' : 'Hider'}</td>
      <td>${p.catches}</td>
      <td>${p.survived !== null ? formatTime(p.survived) : '-'}</td>
      <td>${p.distance}</td>
    `;
    tbody.appendChild(tr);
  });
});

document.getElementById('btn-home').addEventListener('click', () => {
  window.location.reload();
});

// Force map to invalidate size once its container is visible (fixes Leaflet grey tiles bug)
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.target.classList.contains('active') && mutation.target.id === 'screen-game') {
      if (map) setTimeout(() => map.invalidateSize(), 100);
    }
  });
});
observer.observe(screens.game, { attributes: true, attributeFilter: ['class'] });
