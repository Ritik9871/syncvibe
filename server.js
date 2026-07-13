const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Security headers ---
// CSP and cross-origin isolation headers are disabled because this app
// intentionally embeds third-party content (YouTube iframe, Google Fonts)
// and loads the YouTube IFrame API script — a strict CSP would break those.
// The rest of Helmet's defaults (X-Content-Type-Options, X-Frame-Options,
// hiding X-Powered-By, etc.) still apply.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

app.use(express.static(path.join(__dirname, "public")));

// --- Audius integration ---
// Audius is a decentralized, free-to-use music streaming network with an open
// API — unlike YouTube's embed, Audius gives us a real direct audio stream URL,
// so the client can play it through a plain <audio> tag. Plain <audio> elements
// are far more likely to keep playing in the background / with the screen off
// than a cross-origin YouTube iframe, especially combined with the Media
// Session API (this is the same mechanism SoundCloud/YouTube Music's own web
// players rely on, but it works more reliably here because there's no iframe
// boundary involved).
//
// Audius has no single central server — clients are supposed to pick a live
// "discovery node" from a list. We do that server-side, cache the chosen node
// for a while, and proxy search through it so the browser never needs to know
// which node is in use (and so CORS/host-picking isn't the client's problem).
const AUDIUS_APP_NAME = "SyncVibe";
const AUDIUS_BOOTSTRAP_URL = "https://api.audius.co";
let audiusHostCache = { host: null, fetchedAt: 0 };
const AUDIUS_HOST_TTL_MS = 10 * 60 * 1000;

async function getAudiusHost() {
  const now = Date.now();
  if (audiusHostCache.host && now - audiusHostCache.fetchedAt < AUDIUS_HOST_TTL_MS) {
    return audiusHostCache.host;
  }
  const res = await fetch(AUDIUS_BOOTSTRAP_URL);
  if (!res.ok) throw new Error("Could not reach Audius network directory.");
  const body = await res.json();
  const hosts = Array.isArray(body.data) ? body.data : [];
  if (!hosts.length) throw new Error("No Audius nodes available right now.");
  const host = hosts[Math.floor(Math.random() * hosts.length)];
  audiusHostCache = { host, fetchedAt: now };
  return host;
}

const AUDIUS_TRACK_ID_RE = /^[a-zA-Z0-9]{1,32}$/;

app.get("/api/audius/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().slice(0, 100);
  if (!q) return res.status(400).json({ ok: false, error: "Missing search query." });
  try {
    const host = await getAudiusHost();
    const url = `${host}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=${AUDIUS_APP_NAME}&limit=15`;
    const apiRes = await fetch(url);
    if (!apiRes.ok) throw new Error("Audius search failed.");
    const data = await apiRes.json();
    const tracks = (data.data || []).map((t) => ({
      id: t.id,
      title: (t.title || "Untitled").slice(0, 150),
      artist: (t.user && t.user.name ? t.user.name : "Unknown artist").slice(0, 100),
      artwork: (t.artwork && (t.artwork["150x150"] || t.artwork["480x480"])) || null,
      duration: typeof t.duration === "number" ? t.duration : null,
    }));
    res.json({ ok: true, tracks });
  } catch (err) {
    // Bootstrap host may have gone stale/unhealthy — clear cache so next request retries fresh.
    audiusHostCache = { host: null, fetchedAt: 0 };
    res.status(502).json({ ok: false, error: "Couldn't reach Audius right now. Try again in a moment." });
  }
});

app.get("/api/audius/stream/:id", async (req, res) => {
  const id = req.params.id;
  if (!AUDIUS_TRACK_ID_RE.test(id)) return res.status(400).end();
  try {
    const host = await getAudiusHost();
    const url = `${host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${AUDIUS_APP_NAME}`;
    // Redirect the <audio> element straight to the real stream URL rather than
    // proxying the audio bytes through this server — cheaper and avoids
    // buffering the whole track here.
    res.redirect(302, url);
  } catch (err) {
    audiusHostCache = { host: null, fetchedAt: 0 };
    res.status(502).end();
  }
});

// roomCode -> {
//   users: Map(clientId -> { socketId, name }),
//   pendingRemovals: Map(clientId -> timeout handle),
//   track: { source: 'youtube'|'audius', videoId, isPlaying, time, meta: {title,artist,artwork}, updatedAt } | null,
//   queue: [{ source, videoId, title, artist, artwork }],
//   lastAdvanceAt
// }
const rooms = new Map();
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars (no I/O/0/1)
const ROOM_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const RECONNECT_GRACE_MS = 25000;

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function roomUserList(room) {
  return Array.from(room.users.entries()).map(([clientId, u]) => ({ id: clientId, name: u.name }));
}

// ---- Input validation / sanitization helpers ----
function cleanName(name) {
  const s = (typeof name === "string" ? name : "").trim().slice(0, 24);
  return s || "Guest";
}
function cleanText(text, maxLen) {
  return (typeof text === "string" ? text : "").slice(0, maxLen);
}
function isValidRoomCode(code) {
  return typeof code === "string" && ROOM_CODE_RE.test(code);
}
function isValidVideoId(id) {
  return typeof id === "string" && VIDEO_ID_RE.test(id);
}
function isValidSource(source) {
  return source === "youtube" || source === "audius";
}
// Validates a track's id against whichever source it claims to be from.
function isValidTrackRef(source, id) {
  if (source === "youtube") return isValidVideoId(id);
  if (source === "audius") return AUDIUS_TRACK_ID_RE.test(String(id || ""));
  return false;
}
function isValidClientId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

// ---- Very simple per-socket rate limiting for room create/join ----
// Mitigates brute-forcing room codes or spamming room creation.
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 15;
function checkRateLimit(socket) {
  const now = Date.now();
  if (!socket._rl || now - socket._rl.windowStart > RATE_LIMIT_WINDOW_MS) {
    socket._rl = { windowStart: now, count: 0 };
  }
  socket._rl.count++;
  return socket._rl.count <= RATE_LIMIT_MAX;
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let myClientId = null;

  socket.on("create-room", ({ name } = {}, cb) => {
    if (typeof cb !== "function") return;
    if (!checkRateLimit(socket)) return cb({ ok: false, error: "Too many attempts. Wait a moment and try again." });
    const code = makeRoomCode();
    rooms.set(code, {
      users: new Map(),
      pendingRemovals: new Map(),
      track: null,
      queue: [],
      lastAdvanceAt: 0,
    });
    cb({ ok: true, code });
  });

  socket.on("join-room", ({ code, name, clientId } = {}, cb) => {
    if (typeof cb !== "function") return;
    if (!checkRateLimit(socket)) return cb({ ok: false, error: "Too many attempts. Wait a moment and try again." });

    code = (code || "").toUpperCase().trim();
    if (!isValidRoomCode(code)) return cb({ ok: false, error: "Room not found. Check the code." });
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Room not found. Check the code." });
    if (!isValidClientId(clientId)) return cb({ ok: false, error: "Could not join — please refresh and try again." });

    const cleanedName = cleanName(name);
    const reconnecting = room.users.has(clientId);

    if (!reconnecting && room.users.size >= 2) {
      return cb({ ok: false, error: "Room is full (max 2 listeners)." });
    }

    // Cancel any pending "peer-left" removal — this is the same person reconnecting
    // (e.g. their phone briefly dropped connection while the screen was locked).
    if (room.pendingRemovals.has(clientId)) {
      clearTimeout(room.pendingRemovals.get(clientId));
      room.pendingRemovals.delete(clientId);
    }

    currentRoom = code;
    myClientId = clientId;
    socket.join(code);
    room.users.set(clientId, { socketId: socket.id, name: cleanedName });

    cb({ ok: true, code, users: roomUserList(room), track: room.track, queue: room.queue, reconnected: reconnecting });

    if (!reconnecting) {
      socket.to(code).emit("peer-joined", { id: clientId, name: cleanedName });
    }
    io.to(code).emit("room-users", roomUserList(room));
  });

  // --- Playback sync ---
  socket.on("playback-action", ({ code, action, source, videoId, time, isPlaying, meta } = {}) => {
    if (!isValidRoomCode(code)) return;
    const room = rooms.get(code);
    if (!room) return;
    const effectiveSource = isValidSource(source) ? source : room.track?.source;
    if (videoId !== undefined && videoId !== null) {
      if (!effectiveSource || !isValidTrackRef(effectiveSource, videoId)) return;
    }
    const safeTime = typeof time === "number" && isFinite(time) && time >= 0 ? time : 0;
    const allowedActions = new Set(["load", "sync", "play", "pause", "seek"]);
    if (!allowedActions.has(action)) return;

    const safeMeta =
      meta && typeof meta === "object"
        ? { title: cleanText(meta.title, 150), artist: cleanText(meta.artist, 100), artwork: cleanText(meta.artwork, 500) || null }
        : room.track?.meta;

    room.track = {
      source: effectiveSource,
      videoId: videoId ?? room.track?.videoId,
      isPlaying: isPlaying ?? room.track?.isPlaying ?? false,
      time: safeTime,
      meta: safeMeta,
      updatedAt: Date.now(),
    };
    socket.to(code).emit("playback-action", {
      action,
      source: effectiveSource,
      videoId,
      time: safeTime,
      isPlaying,
      meta: safeMeta,
      from: socket.id,
    });
  });

  socket.on("request-sync", ({ code } = {}) => {
    if (!isValidRoomCode(code)) return;
    socket.to(code).emit("request-sync", { from: socket.id });
  });

  // --- Queue ("up next") ---
  socket.on("queue-add", ({ code, source, videoId, title, artist, artwork } = {}) => {
    if (!isValidRoomCode(code)) return;
    const safeSource = isValidSource(source) ? source : "youtube"; // back-compat default
    if (!isValidTrackRef(safeSource, videoId)) return;
    const room = rooms.get(code);
    if (!room) return;
    const safeTitle = cleanText(title, 150) || videoId;
    const safeArtist = cleanText(artist, 100) || null;
    const safeArtwork = cleanText(artwork, 500) || null;
    const meta = { title: safeTitle, artist: safeArtist, artwork: safeArtwork };

    if (!room.track || !room.track.videoId) {
      room.track = { source: safeSource, videoId, isPlaying: true, time: 0, meta, updatedAt: Date.now() };
      io.to(code).emit("playback-action", {
        action: "load",
        source: safeSource,
        videoId,
        time: 0,
        isPlaying: true,
        meta,
        from: "server",
      });
    } else {
      if (room.queue.length >= 50) return; // sane cap
      room.queue.push({ source: safeSource, videoId, title: safeTitle, artist: safeArtist, artwork: safeArtwork });
      io.to(code).emit("queue-updated", { queue: room.queue });
    }
  });

  socket.on("queue-remove", ({ code, index } = {}) => {
    if (!isValidRoomCode(code)) return;
    const room = rooms.get(code);
    if (!room) return;
    if (Number.isInteger(index) && index >= 0 && index < room.queue.length) {
      room.queue.splice(index, 1);
      io.to(code).emit("queue-updated", { queue: room.queue });
    }
  });

  // Fired when a client's player naturally finishes a track (or a manual "skip").
  // Debounced server-side since both peers' players may report this near-simultaneously.
  socket.on("track-ended", ({ code } = {}) => {
    if (!isValidRoomCode(code)) return;
    const room = rooms.get(code);
    if (!room) return;
    const now = Date.now();
    if (now - room.lastAdvanceAt < 2500) return;
    room.lastAdvanceAt = now;

    if (room.queue.length > 0) {
      const next = room.queue.shift();
      const meta = { title: next.title || null, artist: next.artist || null, artwork: next.artwork || null };
      room.track = { source: next.source, videoId: next.videoId, isPlaying: true, time: 0, meta, updatedAt: now };
      io.to(code).emit("playback-action", {
        action: "load",
        source: next.source,
        videoId: next.videoId,
        time: 0,
        isPlaying: true,
        meta,
        from: "server",
      });
      io.to(code).emit("queue-updated", { queue: room.queue });
    } else {
      if (room.track) room.track.isPlaying = false;
      io.to(code).emit("queue-empty");
    }
  });

  // --- Chat ---
  socket.on("chat-message", ({ code, name, text } = {}) => {
    if (!isValidRoomCode(code)) return;
    const room = rooms.get(code);
    if (!room) return;
    const safeText = cleanText(text, 500).trim();
    if (!safeText) return;
    io.to(code).emit("chat-message", { name: cleanName(name), text: safeText, ts: Date.now() });
  });

  // --- Mic mute status ---
  socket.on("mic-status", ({ code, muted } = {}) => {
    if (!isValidRoomCode(code)) return;
    socket.to(code).emit("mic-status", { muted: !!muted, from: socket.id });
  });

  // --- WebRTC signaling relay ---
  socket.on("webrtc-signal", ({ code, signal } = {}) => {
    if (!isValidRoomCode(code) || !signal) return;
    socket.to(code).emit("webrtc-signal", { signal, from: socket.id });
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !myClientId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Grace period: don't tell the other peer you left yet. If this was a brief
    // drop (phone screen locked, network blip while backgrounded, etc.) and you
    // reconnect within the window, nothing changes for the other person at all —
    // their playback, voice, and chat state stay exactly as they were.
    const timeout = setTimeout(() => {
      const stillThere = room.users.get(myClientId);
      if (stillThere && stillThere.socketId === socket.id) {
        room.users.delete(myClientId);
        room.pendingRemovals.delete(myClientId);
        io.to(currentRoom).emit("peer-left", { id: myClientId });
        io.to(currentRoom).emit("room-users", roomUserList(room));
        if (room.users.size === 0) rooms.delete(currentRoom);
      }
    }, RECONNECT_GRACE_MS);

    room.pendingRemovals.set(myClientId, timeout);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SyncVibe server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-local-ip>:${PORT}  (for same-WiFi friends)`);
  console.log(`For friends on a different network, expose this port with a tunnel (see README.md).`);
});
