# Hide N Seek — MrBeast Edition
## Game Design Document

**Location:** BITS Pilani Hyderabad Campus
**Theme:** Fully dark — pitch black backgrounds, neon accents

---

## 1. Overview

A browser-based, real-time multiplayer hide and seek game played on the BITS Pilani Hyderabad campus. Players join via their phones, get assigned roles (seeker/hider), and play in the real world using GPS tracking. The game screen shows a campus map screenshot alongside a live GPS map, with alternating BLIP and SHRINK events creating escalating tension.

---

## 2. Tech Stack

- **Server:** Node.js + Express
- **Real-time:** Socket.IO
- **Maps:** Leaflet.js (dark CartoDB tiles, always-visible GPS map)
- **Location:** Browser Geolocation API
- **Database:** None (in-memory, games are ephemeral)
- **Frontend:** Vanilla HTML/CSS/JS, single-page app

---

## 3. Game Flow

1. **Landing** — Player enters name, grants location permission
2. **Menu** — Create or join a room
3. **Lobby** — Players wait, host configures settings, starts game
4. **Hiding Phase** — Seekers announced, hiders get a head start
5. **Seeking Phase** — Alternating BLIP/SHRINK events, seekers hunt hiders
6. **End** — Timer expires or all hiders caught, stats displayed

---

## 4. Player Entry

- Name input with auto-generated fun name suggestion
- Location permission request with explanation
- Unique player ID generated server-side

---

## 5. Room System

- **Create Room:** Host picks a room name, gets a 6-char alphanumeric code
- **Join Room:** Enter the code
- Real-time player list, host badge, player count

---

## 6. Settings (Host Only)

| Setting          | Range         | Default |
|------------------|---------------|---------|
| Number of seekers| 1 to (n-1)    | 1       |
| Game duration    | 10–60 min     | 20 min  |
| Blip interval    | 1–10 min      | 3 min   |
| Blip duration    | 3–10 sec      | 5 sec   |
| Hiding gap       | 30s–5 min     | 2 min   |

**Zones and shrink timing are NOT configurable.** They are hardcoded from the uploaded campus maps.

---

## 7. Zone Data (Hardcoded from Campus Maps)

### Level 0 — Initial Map (map_1.jpg)
**Included:** A, B, D, E, F, G, H, I, J, K blocks · Lib lawns · LTC lobby · OAT · Rock garden · Central workshop
**Excluded:** Audi · Lib

### Level 1 — 1st Shrink (map_2.jpg)
**Included:** A, B, D, E, F, G, H, I, J, K blocks · Lib lawns · LTC lobby · OAT
**Excluded:** Audi · Lib · Rock garden · Central workshop
**Newly excluded:** Rock garden, Central workshop

### Level 2 — 2nd Shrink (map_3.jpg)
**Included:** B, D, F, G, H, K blocks · Lib lawns · LTC lobby · OAT
**Excluded:** Audi · Lib · Rock garden · Central workshop · A, E, I, J blocks
**Newly excluded:** A, E, I, J blocks

### Level 3 — 3rd Shrink (map_4.jpg)
**Included:** B, D, F, G blocks · Lib lawns · LTC lobby
**Excluded:** Audi · Lib · Rock garden · Central workshop · A, E, H, I, J, K blocks · OAT
**Newly excluded:** H, K blocks, OAT

---

## 8. Game Screen Layout (During Play)

All elements visible simultaneously:

- **Screenshot image** — Current campus map (swaps on SHRINK)
- **Included areas** — Green list of safe zones
- **Excluded areas** — Red list of out-of-bounds zones
- **Live GPS map** — Leaflet with dark tiles, always shows player's own pin
- **Game timer** — Countdown to end
- **Role badge** — SEEKER or HIDER
- **Catch button** — Seekers only

---

## 9. Alternating Event System (BLIP ↔ SHRINK)

Events alternate, all spaced by the same blip interval:

| #  | Event     | What happens                                              |
|----|-----------|-----------------------------------------------------------|
| 1  | **BLIP**  | Hider markers appear on GPS map for seekers (5s)          |
| 2  | **SHRINK**| Screenshot swaps, area lists update, alert stays 2.5 min  |
| 3  | **BLIP**  | Hider markers appear on GPS map for seekers (5s)          |
| 4  | **SHRINK**| Screenshot swaps, area lists update, alert stays 2.5 min  |
| ...| ...       | Continues alternating                                     |

### BLIP Event
- 3-second countdown warning ("BLIP INCOMING" with sound)
- For seekers only: hider location markers appear on the GPS map as pulsing neon dots for configured duration
- After duration, markers fade out — GPS map returns to showing only the player's own pin
- Hiders get notified "Your location was revealed!"

### SHRINK Event
- Screenshot image swaps to the next shrink-level image
- Included areas list updates (areas removed)
- Excluded areas list updates (newly excluded areas added in red)
- Dramatic announcement banner: "⚠️ ZONE SHRINKING! [areas] ARE NOW OUT OF BOUNDS!"
- Alert stays visible for 2.5 minutes (relocation time for players)
- After 2.5 min, banner dismisses; new screenshot + area lists remain
- Once all 3 shrink images are used, only BLIPs continue

---

## 10. Catch System (Infection Mode)

- Seekers see a "CATCH" button
- Shows list of nearby hiders (within ~50m GPS)
- Caught hider immediately becomes a seeker
- All players notified: "[Player] was caught by [Seeker]! They are now a SEEKER!"
- Game gets progressively harder as the seeker team grows

---

## 11. End-Game Stats

Game ends when timer runs out OR all hiders are caught.

| Stat             | Description                                    |
|------------------|------------------------------------------------|
| Last Survivor    | Hider who lasted the longest                   |
| Top Hunter       | Seeker who caught the most hiders              |
| Time Survived    | Per-hider survival duration                    |
| Catches          | Per-seeker catch count (including converts)     |
| Distance Walked  | Total distance each player moved               |
| Game Duration    | How long the actual game lasted                |
| Zones Eliminated | How many zones were knocked out                |

---

## 12. File Structure

```
Hide n Seek/
├── PLAN.md
├── map details.docx
├── maps/                    (extracted map images)
│   ├── map_1.jpg            (initial — full area)
│   ├── map_2.jpg            (1st shrink)
│   ├── map_3.jpg            (2nd shrink)
│   └── map_4.jpg            (3rd shrink)
├── package.json
├── server.js
└── public/
    ├── index.html
    ├── css/
    │   └── style.css
    ├── js/
    │   └── app.js
    └── maps/                (copied for serving)
        ├── map_1.jpg
        ├── map_2.jpg
        ├── map_3.jpg
        └── map_4.jpg
```
