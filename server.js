const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// roomCode -> { users: Map(socketId -> {name}), track: {videoId, isPlaying, time, updatedAt} }
const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function roomUserList(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, name: u.name }));
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("create-room", ({ name }, cb) => {
    const code = makeRoomCode();
    rooms.set(code, { users: new Map(), track: null });
    cb({ ok: true, code });
  });

  socket.on("join-room", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Room not found. Check the code." });
    if (room.users.size >= 2) return cb({ ok: false, error: "Room is full (max 2 listeners)." });

    currentRoom = code;
    socket.join(code);
    room.users.set(socket.id, { name: name || "Guest" });

    cb({ ok: true, code, users: roomUserList(room), track: room.track });

    socket.to(code).emit("peer-joined", { id: socket.id, name: name || "Guest" });
    io.to(code).emit("room-users", roomUserList(room));
  });

  // --- Playback sync ---
  socket.on("playback-action", ({ code, action, videoId, time, isPlaying }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.track = {
      videoId: videoId ?? room.track?.videoId,
      isPlaying: isPlaying ?? room.track?.isPlaying ?? false,
      time: time ?? 0,
      updatedAt: Date.now(),
    };
    socket.to(code).emit("playback-action", { action, videoId, time, isPlaying, from: socket.id });
  });

  socket.on("request-sync", ({ code }) => {
    socket.to(code).emit("request-sync", { from: socket.id });
  });

  // --- Chat ---
  socket.on("chat-message", ({ code, name, text }) => {
    io.to(code).emit("chat-message", { name, text, ts: Date.now() });
  });

  // --- Mic mute status (just for showing UI indicator to peer) ---
  socket.on("mic-status", ({ code, muted }) => {
    socket.to(code).emit("mic-status", { muted, from: socket.id });
  });

  // --- WebRTC signaling relay ---
  socket.on("webrtc-signal", ({ code, signal }) => {
    socket.to(code).emit("webrtc-signal", { signal, from: socket.id });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(currentRoom).emit("peer-left", { id: socket.id });
    io.to(currentRoom).emit("room-users", roomUserList(room));
    if (room.users.size === 0) rooms.delete(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SyncVibe server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-local-ip>:${PORT}  (for same-WiFi friends)`);
  console.log(`For friends on a different network, expose this port with a tunnel (see README.md).`);
});
