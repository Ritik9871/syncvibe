const socket = io();

// Persistent per-browser identity so a brief disconnect (screen lock, network
// blip) can rejoin the same room without the other person seeing you "leave".
function getClientId() {
  let id = localStorage.getItem("syncvibe-client-id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem("syncvibe-client-id", id);
  }
  return id;
}
const myClientId = getClientId();

// ---------- State ----------
let myName = "";
let roomCode = "";
let ytPlayer = null;
let ytReady = false;
let pendingVideoId = null;
let applyingRemote = false; // guard to avoid echoing back events we just received
let peerId = null;
let peerName = null;
let progressTimer = null;

let localStream = null;
let pc = null;
let micEnabled = false;
let micMuted = false;

let queue = [];
let wakeLock = null;
let wakeLockWanted = false;

// Which source is currently loaded/playing ("youtube" | "audius" | null),
// and which tab the user has open for adding new tracks to the queue.
let currentSource = null;
let addTab = "youtube";
let currentMeta = null; // { title, artist, artwork } for whichever track is loaded
let audiusPlayer = null; // set once DOM is ready, see below

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// ---------- Elements ----------
const el = (id) => document.getElementById(id);
const landing = el("landing");
const roomScreen = el("room");
audiusPlayer = el("audiusPlayer");

// ===================== Landing wiring =====================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    el(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

function showLandingError(msg) {
  const e = el("landingError");
  e.textContent = msg;
  e.classList.remove("hidden");
}

el("createBtn").addEventListener("click", () => {
  myName = el("nameInput").value.trim() || "Guest";
  socket.emit("create-room", { name: myName }, (res) => {
    if (!res.ok) return showLandingError("Could not create room.");
    doJoin(res.code);
  });
});

el("joinBtn").addEventListener("click", () => {
  myName = el("nameInput").value.trim() || "Guest";
  const code = el("codeInput").value.trim().toUpperCase();
  if (!code) return showLandingError("Enter a room code.");
  doJoin(code);
});

function doJoin(code) {
  socket.emit("join-room", { code, name: myName, clientId: myClientId }, (res) => {
    if (!res.ok) return showLandingError(res.error || "Could not join room.");
    roomCode = res.code;
    localStorage.setItem("syncvibe-room", roomCode);
    localStorage.setItem("syncvibe-name", myName);
    enterRoom(res);
  });
}

// If THIS device's connection drops briefly (screen lock, spotty network) and
// reconnects, silently rejoin the same room instead of leaving your friend's
// session hanging. Only acts if we'd already joined a room in this session.
socket.on("connect", () => {
  if (!roomCode || !myName) return;
  socket.emit("join-room", { code: roomCode, name: myName, clientId: myClientId }, (res) => {
    if (!res.ok) return;
    queue = res.queue || [];
    renderQueue();
    const others = (res.users || []).filter((u) => u.id !== myClientId);
    if (others.length) {
      peerId = others[0].id;
      peerName = others[0].name;
      setPeerConnected(true);
    }
  });
});

function enterRoom(res) {
  landing.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  el("roomCodeDisplay").textContent = roomCode;
  el("youAvatar").textContent = initials(myName);

  const others = (res.users || []).filter((u) => u.id !== myClientId);
  if (others.length) {
    peerId = others[0].id;
    peerName = others[0].name;
    setPeerConnected(true);
  }

  if (res.track && res.track.videoId) {
    loadTrack(res.track.source || "youtube", res.track.videoId, res.track.time, res.track.isPlaying, res.track.meta);
  }

  queue = res.queue || [];
  renderQueue();

  addSystemMessage(`You joined as ${myName}.`);
}

// ===================== Unified track loading (YouTube or Audius) =====================
// Dispatches to the right player and swaps the visible UI (YouTube iframe vs
// Audius audio bar) based on `source`.
function loadTrack(source, id, startTime = 0, autoplay = false, meta = null, broadcast = false) {
  currentSource = source;
  currentMeta = meta || currentMeta;
  el("playerPlaceholder").classList.add("hidden");
  el("playPauseBtn").disabled = false;
  el("seekBar").disabled = false;

  if (source === "audius") {
    el("ytPlayer").classList.add("hidden");
    el("audiusNowPlaying").classList.remove("hidden");
    el("playerWrap").classList.add("audius-active");
    el("audioModeBtn").disabled = true; // audio mode only applies to the YouTube iframe
    if (currentMeta) {
      el("audiusTitle").textContent = currentMeta.title || "Untitled";
      el("audiusArtist").textContent = currentMeta.artist || "";
      el("audiusArtwork").src = currentMeta.artwork || "";
      el("audiusArtwork").style.visibility = currentMeta.artwork ? "visible" : "hidden";
    }
    applyingRemote = true;
    const currentId = audiusPlayer.dataset.trackId;
    if (currentId !== String(id)) {
      audiusPlayer.dataset.trackId = String(id);
      audiusPlayer.src = `/api/audius/stream/${encodeURIComponent(id)}`;
    }
    audiusPlayer.currentTime = startTime || 0;
    if (autoplay) audiusPlayer.play().catch(() => {});
    else audiusPlayer.pause();
    setTimeout(() => (applyingRemote = false), 500);
    if (broadcast) sendPlaybackAction("load", id, startTime, autoplay);
    startProgressLoop();
    setTimeout(updateMediaSession, 300);
  } else {
    el("audiusNowPlaying").classList.add("hidden");
    el("ytPlayer").classList.remove("hidden");
    el("playerWrap").classList.remove("audius-active");
    el("audioModeBtn").disabled = false;
    loadVideo(id, startTime, autoplay, broadcast);
  }
}

function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function setPeerConnected(connected) {
  const status = el("peerStatus");
  const avatar = el("friendAvatar");
  const dot = el("connDot");
  if (connected) {
    status.textContent = `Listening with ${peerName || "your friend"}`;
    status.classList.add("connected");
    avatar.textContent = initials(peerName);
    avatar.classList.add("online");
    dot.classList.add("live");
  } else {
    status.textContent = "Waiting for your friend to join…";
    status.classList.remove("connected");
    avatar.textContent = "?";
    avatar.classList.remove("online");
    dot.classList.remove("live");
  }
}

el("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    el("copyCodeBtn").textContent = "copied";
    setTimeout(() => (el("copyCodeBtn").textContent = "copy"), 1500);
  });
});

el("leaveBtn").addEventListener("click", () => location.reload());

// ===================== Source tabs (YouTube / Audius) =====================
// This controls which "add a track" form is shown — it's independent of
// whichever source is *currently playing*, which is tracked by currentSource.
document.querySelectorAll(".src-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const src = btn.dataset.src;
    if (src !== "youtube" && src !== "audius") return; // spotify placeholder, ignore
    addTab = src;
    document.querySelectorAll(".src-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    el("loadForm").classList.toggle("hidden", src !== "youtube");
    el("audiusPanel").classList.toggle("hidden", src !== "audius");
  });
});

// ===================== Audius search =====================
el("audiusSearchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = el("audiusSearchInput").value.trim();
  if (!q) return;
  const list = el("audiusResults");
  list.innerHTML = `<li class="audius-hint">Searching…</li>`;
  try {
    const res = await fetch(`/api/audius/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.ok) {
      list.innerHTML = `<li class="audius-hint">${escapeHtml(data.error || "Search failed.")}</li>`;
      return;
    }
    renderAudiusResults(data.tracks || []);
  } catch (err) {
    list.innerHTML = `<li class="audius-hint">Couldn't reach Audius. Check your connection and try again.</li>`;
  }
});

function renderAudiusResults(tracks) {
  const list = el("audiusResults");
  list.innerHTML = "";
  if (!tracks.length) {
    list.innerHTML = `<li class="audius-hint">No results — try a different search.</li>`;
    return;
  }
  tracks.forEach((t) => {
    const li = document.createElement("li");
    li.className = "audius-result";
    li.innerHTML = `
      <img class="audius-result-art" src="${t.artwork ? escapeHtml(t.artwork) : ""}" alt="" onerror="this.style.visibility='hidden'">
      <div class="audius-result-meta">
        <div class="audius-result-title"></div>
        <div class="audius-result-artist"></div>
      </div>
      <button class="btn primary small audius-add-btn">Add</button>
    `;
    li.querySelector(".audius-result-title").textContent = t.title;
    li.querySelector(".audius-result-artist").textContent = t.artist;
    li.querySelector(".audius-add-btn").addEventListener("click", () => {
      socket.emit("queue-add", {
        code: roomCode,
        source: "audius",
        videoId: String(t.id),
        title: t.title,
        artist: t.artist,
        artwork: t.artwork || "",
      });
    });
    list.appendChild(li);
  });
}

// ===================== Socket: room events =====================
socket.on("peer-joined", ({ id, name }) => {
  peerId = id;
  peerName = name;
  setPeerConnected(true);
  addSystemMessage(`${name} joined the room.`);
  // If we already have a track loaded, share current state with the newcomer
  if (currentSource === "audius" && audiusPlayer.dataset.trackId) {
    sendPlaybackAction("sync", audiusPlayer.dataset.trackId, audiusPlayer.currentTime, !audiusPlayer.paused);
  } else if (ytPlayer && ytReady && ytPlayer.getVideoData && ytPlayer.getVideoData().video_id) {
    sendPlaybackAction("sync", ytPlayer.getVideoData().video_id, ytPlayer.getCurrentTime(), getIsPlaying());
  }
  // Re-initiate voice if mic already enabled
  if (micEnabled) startWebRTC(true);
});

socket.on("peer-left", () => {
  addSystemMessage(`${peerName || "Your friend"} left the room.`);
  peerId = null;
  peerName = null;
  setPeerConnected(false);
  teardownWebRTC();
});

socket.on("room-users", (users) => {
  const others = users.filter((u) => u.id !== myClientId);
  if (others.length) {
    peerId = others[0].id;
    peerName = others[0].name;
    setPeerConnected(true);
  }
});

// ===================== YouTube player =====================
function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player("ytPlayer", {
    height: "100%",
    width: "100%",
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingVideoId) loadVideo(pendingVideoId, 0, false);
      },
      onStateChange: onPlayerStateChange,
    },
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function extractVideoId(input) {
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const shorts = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return shorts[1];
  } catch (e) {
    /* not a full URL */
  }
  return null;
}

el("loadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = el("videoUrlInput").value;
  const id = extractVideoId(raw);
  if (!id) return addSystemMessage("Couldn't read that link — paste a full YouTube URL or the 11-character video ID.");
  el("videoUrlInput").value = "";

  let title = id;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    if (res.ok) {
      const data = await res.json();
      if (data.title) title = data.title;
    }
  } catch (e) {
    /* best effort only */
  }

  socket.emit("queue-add", { code: roomCode, source: "youtube", videoId: id, title });
});

function loadVideo(videoId, startTime = 0, autoplay = false, broadcast = false) {
  el("playerPlaceholder").classList.add("hidden");
  el("playPauseBtn").disabled = false;
  el("seekBar").disabled = false;

  if (!ytReady) {
    pendingVideoId = videoId;
    return;
  }
  applyingRemote = true;
  if (autoplay) {
    ytPlayer.loadVideoById({ videoId, startSeconds: startTime });
  } else {
    ytPlayer.cueVideoById({ videoId, startSeconds: startTime });
  }
  setTimeout(() => (applyingRemote = false), 500);

  if (broadcast) sendPlaybackAction("load", videoId, startTime, autoplay);
  startProgressLoop();
  setTimeout(updateMediaSession, 300);
}

function getIsPlaying() {
  return ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
}

function onPlayerStateChange(event) {
  if (applyingRemote) return; // this state change was caused by an incoming remote action
  if (!ytPlayer || !ytPlayer.getVideoData) return;
  const videoId = ytPlayer.getVideoData().video_id;
  if (!videoId) return;

  if (event.data === YT.PlayerState.PLAYING) {
    el("playPauseBtn").textContent = "⏸";
    sendPlaybackAction("play", videoId, ytPlayer.getCurrentTime());
    document.querySelector(".thread").classList.add("playing");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    updateMediaSession();
  } else if (event.data === YT.PlayerState.PAUSED) {
    el("playPauseBtn").textContent = "▶";
    sendPlaybackAction("pause", videoId, ytPlayer.getCurrentTime());
    document.querySelector(".thread").classList.remove("playing");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  } else if (event.data === YT.PlayerState.ENDED) {
    document.querySelector(".thread").classList.remove("playing");
    socket.emit("track-ended", { code: roomCode });
  } else if (event.data === YT.PlayerState.CUED) {
    updateMediaSession();
  }
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  if (currentSource === "audius") {
    if (!currentMeta) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentMeta.title || "SyncVibe",
      artist: currentMeta.artist || (peerName ? `Listening with ${peerName}` : "SyncVibe"),
      album: "SyncVibe",
      artwork: currentMeta.artwork ? [{ src: currentMeta.artwork, sizes: "480x480", type: "image/jpeg" }] : [],
    });
    return;
  }
  if (!ytPlayer || !ytPlayer.getVideoData) return;
  const data = ytPlayer.getVideoData();
  if (!data || !data.video_id) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: data.title || "SyncVibe",
    artist: data.author || (peerName ? `Listening with ${peerName}` : "SyncVibe"),
    album: "SyncVibe",
  });
}

// ===================== Audius player events =====================
// Mirrors onPlayerStateChange above but for the native <audio> element. Plain
// <audio> + Media Session is what lets playback survive the screen locking —
// there's no cross-origin iframe boundary for the OS to suspend.
audiusPlayer.addEventListener("play", () => {
  if (applyingRemote || currentSource !== "audius") return;
  el("playPauseBtn").textContent = "⏸";
  document.querySelector(".thread").classList.add("playing");
  sendPlaybackAction("play", audiusPlayer.dataset.trackId, audiusPlayer.currentTime);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  updateMediaSession();
});

audiusPlayer.addEventListener("pause", () => {
  if (applyingRemote || currentSource !== "audius") return;
  el("playPauseBtn").textContent = "▶";
  document.querySelector(".thread").classList.remove("playing");
  // Native <audio> also fires "pause" right before "ended" — don't double-report that as a manual pause.
  if (audiusPlayer.ended) return;
  sendPlaybackAction("pause", audiusPlayer.dataset.trackId, audiusPlayer.currentTime);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});

audiusPlayer.addEventListener("ended", () => {
  if (currentSource !== "audius") return;
  document.querySelector(".thread").classList.remove("playing");
  socket.emit("track-ended", { code: roomCode });
});

if ("mediaSession" in navigator) {
  // Re-register handlers so they work for whichever source is active — the
  // handlers below check currentSource and route to the right player.
  navigator.mediaSession.setActionHandler("play", () => {
    if (currentSource === "audius") audiusPlayer.play().catch(() => {});
    else if (ytPlayer) ytPlayer.playVideo();
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (currentSource === "audius") audiusPlayer.pause();
    else if (ytPlayer) ytPlayer.pauseVideo();
  });
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    if (currentSource === "audius" && audiusPlayer.dataset.trackId) {
      socket.emit("track-ended", { code: roomCode });
    } else if (ytPlayer && ytPlayer.getVideoData && ytPlayer.getVideoData().video_id) {
      socket.emit("track-ended", { code: roomCode });
    }
  });
}

el("playPauseBtn").addEventListener("click", () => {
  if (currentSource === "audius") {
    if (!audiusPlayer.dataset.trackId) return;
    if (audiusPlayer.paused) {
      audiusPlayer.play().catch(() => {});
    } else {
      audiusPlayer.pause();
    }
    return;
  }
  if (!ytPlayer) return;
  if (getIsPlaying()) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
});

let seeking = false;
el("seekBar").addEventListener("input", () => (seeking = true));
el("seekBar").addEventListener("change", () => {
  if (currentSource === "audius") {
    if (!audiusPlayer.dataset.trackId) return;
    const duration = audiusPlayer.duration || 0;
    const target = (el("seekBar").value / 100) * duration;
    audiusPlayer.currentTime = target;
    sendPlaybackAction("seek", audiusPlayer.dataset.trackId, target, !audiusPlayer.paused);
    seeking = false;
    return;
  }
  if (!ytPlayer) return;
  const duration = ytPlayer.getDuration() || 0;
  const target = (el("seekBar").value / 100) * duration;
  ytPlayer.seekTo(target, true);
  sendPlaybackAction("seek", ytPlayer.getVideoData().video_id, target, getIsPlaying());
  seeking = false;
});

function startProgressLoop() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (seeking) return;
    if (currentSource === "audius") {
      if (!audiusPlayer.dataset.trackId) return;
      const duration = audiusPlayer.duration || 0;
      const current = audiusPlayer.currentTime || 0;
      if (duration > 0) el("seekBar").value = (current / duration) * 100;
      el("timeDisplay").textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
      return;
    }
    if (!ytPlayer || !ytPlayer.getDuration) return;
    const duration = ytPlayer.getDuration() || 0;
    const current = ytPlayer.getCurrentTime() || 0;
    if (duration > 0) el("seekBar").value = (current / duration) * 100;
    el("timeDisplay").textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
  }, 500);
}

function fmtTime(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

el("resyncBtn").addEventListener("click", () => {
  socket.emit("request-sync", { code: roomCode });
  addSystemMessage("Requested a re-sync from your friend.");
});

socket.on("request-sync", () => {
  if (currentSource === "audius") {
    if (audiusPlayer.dataset.trackId) {
      sendPlaybackAction("sync", audiusPlayer.dataset.trackId, audiusPlayer.currentTime, !audiusPlayer.paused);
    }
    return;
  }
  if (!ytPlayer || !ytPlayer.getVideoData) return;
  const videoId = ytPlayer.getVideoData().video_id;
  if (videoId) sendPlaybackAction("sync", videoId, ytPlayer.getCurrentTime(), getIsPlaying());
});

function sendPlaybackAction(action, videoId, time, isPlaying, meta) {
  const isAud = currentSource === "audius";
  socket.emit("playback-action", {
    code: roomCode,
    action,
    source: currentSource || "youtube",
    videoId,
    time,
    isPlaying: isPlaying ?? (isAud ? !audiusPlayer.paused : getIsPlaying()),
    meta: meta || currentMeta || undefined,
  });
}

socket.on("playback-action", ({ action, source, videoId, time, isPlaying, meta }) => {
  applyingRemote = true;
  const effectiveSource = source || currentSource || "youtube";

  if (effectiveSource === "audius") {
    if (action === "load" || action === "sync") {
      currentSource = "audius";
      if (meta) currentMeta = meta;
      el("ytPlayer").classList.add("hidden");
      el("audiusNowPlaying").classList.remove("hidden");
      el("playerWrap").classList.add("audius-active");
      el("playerPlaceholder").classList.add("hidden");
      el("playPauseBtn").disabled = false;
      el("seekBar").disabled = false;
      el("audioModeBtn").disabled = true;
      if (currentMeta) {
        el("audiusTitle").textContent = currentMeta.title || "Untitled";
        el("audiusArtist").textContent = currentMeta.artist || "";
        el("audiusArtwork").src = currentMeta.artwork || "";
        el("audiusArtwork").style.visibility = currentMeta.artwork ? "visible" : "hidden";
      }
      const currentId = audiusPlayer.dataset.trackId;
      if (currentId !== String(videoId)) {
        audiusPlayer.dataset.trackId = String(videoId);
        audiusPlayer.src = `/api/audius/stream/${encodeURIComponent(videoId)}`;
      }
      audiusPlayer.currentTime = time || 0;
      isPlaying ? audiusPlayer.play().catch(() => {}) : audiusPlayer.pause();
      el("playPauseBtn").textContent = isPlaying ? "⏸" : "▶";
      startProgressLoop();
      setTimeout(updateMediaSession, 300);
    } else if (action === "play") {
      audiusPlayer.currentTime = time;
      audiusPlayer.play().catch(() => {});
      el("playPauseBtn").textContent = "⏸";
      document.querySelector(".thread").classList.add("playing");
    } else if (action === "pause") {
      audiusPlayer.currentTime = time;
      audiusPlayer.pause();
      el("playPauseBtn").textContent = "▶";
      document.querySelector(".thread").classList.remove("playing");
    } else if (action === "seek") {
      audiusPlayer.currentTime = time;
      isPlaying ? audiusPlayer.play().catch(() => {}) : audiusPlayer.pause();
    }
    setTimeout(() => (applyingRemote = false), 500);
    return;
  }

  // ---- YouTube ----
  currentSource = "youtube";
  if (meta) currentMeta = meta;
  el("audiusNowPlaying").classList.add("hidden");
  el("ytPlayer").classList.remove("hidden");
  el("playerWrap").classList.remove("audius-active");
  el("audioModeBtn").disabled = false;
  if (action === "load" || action === "sync") {
    if (!ytReady) {
      pendingVideoId = videoId;
    } else {
      el("playerPlaceholder").classList.add("hidden");
      el("playPauseBtn").disabled = false;
      el("seekBar").disabled = false;
      const currentId = ytPlayer.getVideoData ? ytPlayer.getVideoData().video_id : null;
      if (currentId !== videoId) {
        isPlaying ? ytPlayer.loadVideoById({ videoId, startSeconds: time }) : ytPlayer.cueVideoById({ videoId, startSeconds: time });
      } else {
        ytPlayer.seekTo(time, true);
      }
      isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
      el("playPauseBtn").textContent = isPlaying ? "⏸" : "▶";
      startProgressLoop();
      setTimeout(updateMediaSession, 300);
    }
  } else if (action === "play") {
    ytPlayer.seekTo(time, true);
    ytPlayer.playVideo();
    el("playPauseBtn").textContent = "⏸";
    document.querySelector(".thread").classList.add("playing");
  } else if (action === "pause") {
    ytPlayer.seekTo(time, true);
    ytPlayer.pauseVideo();
    el("playPauseBtn").textContent = "▶";
    document.querySelector(".thread").classList.remove("playing");
  } else if (action === "seek") {
    ytPlayer.seekTo(time, true);
    isPlaying ? ytPlayer.playVideo() : ytPlayer.pauseVideo();
  }
  setTimeout(() => (applyingRemote = false), 500);
});

// ===================== Chat =====================
el("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el("chatInput").value.trim();
  if (!text) return;
  socket.emit("chat-message", { code: roomCode, name: myName, text });
  el("chatInput").value = "";
});

socket.on("chat-message", ({ name, text }) => {
  const box = el("chatMessages");
  const div = document.createElement("div");
  div.className = "chat-msg";
  const who = name === myName ? "You" : name;
  div.innerHTML = `<span class="who">${escapeHtml(who)}:</span>${escapeHtml(text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

function addSystemMessage(text) {
  const box = el("chatMessages");
  const div = document.createElement("div");
  div.className = "chat-msg system";
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ===================== Voice chat (WebRTC) =====================
el("micBtn").addEventListener("click", async () => {
  if (micEnabled) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micEnabled = true;
    el("micBtn").textContent = "🎙️ Mic on";
    el("micBtn").disabled = true;
    el("muteBtn").disabled = false;
    el("voiceStatus").textContent = "Voice: connecting…";
    if (peerId) startWebRTC(true);
    else el("voiceStatus").textContent = "Voice: ready (waiting for friend)";
  } catch (err) {
    addSystemMessage("Couldn't access your microphone. Check browser permissions.");
  }
});

el("muteBtn").addEventListener("click", () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  el("muteBtn").textContent = micMuted ? "Unmute" : "Mute";
  socket.emit("mic-status", { code: roomCode, muted: micMuted });
});

socket.on("mic-status", ({ muted }) => {
  el("voiceStatus").textContent = muted ? `Voice: ${peerName || "friend"} muted` : "Voice: connected";
});

function createPeerConnection() {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn.onicecandidate = (e) => {
    if (e.candidate) socket.emit("webrtc-signal", { code: roomCode, signal: { type: "ice", candidate: e.candidate } });
  };
  conn.ontrack = (e) => {
    const audioEl = el("remoteAudio");
    audioEl.srcObject = e.streams[0];
    el("voiceStatus").textContent = "Voice: connected";
  };
  conn.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(conn.connectionState)) {
      el("voiceStatus").textContent = "Voice: disconnected";
    }
  };
  if (localStream) localStream.getTracks().forEach((t) => conn.addTrack(t, localStream));
  return conn;
}

async function startWebRTC(isInitiator) {
  teardownWebRTC(false);
  pc = createPeerConnection();
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-signal", { code: roomCode, signal: { type: "offer", sdp: offer } });
  }
}

socket.on("webrtc-signal", async ({ signal }) => {
  if (!localStream) {
    // Friend wants to talk but our mic isn't on yet — ignore until user enables mic.
    if (signal.type === "offer") addSystemMessage(`${peerName || "Your friend"} started voice chat. Enable your mic to join.`);
    return;
  }
  if (signal.type === "offer") {
    if (!pc) pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-signal", { code: roomCode, signal: { type: "answer", sdp: answer } });
  } else if (signal.type === "answer") {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
  } else if (signal.type === "ice") {
    if (pc) {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (e) {
        /* ignore late candidates */
      }
    }
  }
});

function teardownWebRTC(clearUI = true) {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (clearUI) el("voiceStatus").textContent = micEnabled ? "Voice: ready (waiting for friend)" : "Voice: off";
}

// ===================== Queue ("up next") =====================
function renderQueue() {
  const list = el("queueList");
  list.innerHTML = "";
  if (!queue.length) {
    const li = document.createElement("li");
    li.className = "queue-empty-hint";
    li.textContent = "Nothing queued — add a link above and it'll play automatically once the current song ends.";
    list.appendChild(li);
    return;
  }
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "queue-item";
    const icon = item.source === "audius" ? "🎧" : "▶";
    li.innerHTML = `<span class="qnum">${i + 1}</span><span class="qsrc" title="${item.source === "audius" ? "Audius" : "YouTube"}">${icon}</span><span class="qtitle"></span><button class="qremove" title="Remove">✕</button>`;
    const label = item.artist ? `${item.title} — ${item.artist}` : item.title || item.videoId;
    li.querySelector(".qtitle").textContent = label;
    li.querySelector(".qremove").addEventListener("click", () => {
      socket.emit("queue-remove", { code: roomCode, index: i });
    });
    list.appendChild(li);
  });
}

socket.on("queue-updated", ({ queue: q }) => {
  queue = q || [];
  renderQueue();
});

socket.on("queue-empty", () => {
  addSystemMessage("Queue's empty — add another link to keep the music going.");
});

el("skipBtn").addEventListener("click", () => {
  if (currentSource === "audius") {
    if (!audiusPlayer.dataset.trackId) return;
  } else if (!ytPlayer || !ytPlayer.getVideoData || !ytPlayer.getVideoData().video_id) {
    return;
  }
  socket.emit("track-ended", { code: roomCode });
});

// ===================== Screen Wake Lock =====================
// Prevents the screen from auto-locking from inactivity while you're listening.
// Note: this does NOT override a manual power-button lock — that's an OS-level
// restriction no website can bypass, and it will pause the embedded video.
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    addSystemMessage("Your browser doesn't support keeping the screen awake — try Chrome on Android.");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLockWanted = true;
    el("wakeLockBtn").textContent = "keep screen on: on";
    el("wakeLockBtn").classList.add("active");
    wakeLock.addEventListener("release", () => {
      el("wakeLockBtn").textContent = "keep screen on: off";
      el("wakeLockBtn").classList.remove("active");
    });
  } catch (err) {
    addSystemMessage("Couldn't enable keep-screen-on for this browser/device.");
  }
}

function releaseWakeLock() {
  wakeLockWanted = false;
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
  el("wakeLockBtn").textContent = "keep screen on: off";
  el("wakeLockBtn").classList.remove("active");
}

el("wakeLockBtn").addEventListener("click", () => {
  if (wakeLock) releaseWakeLock();
  else requestWakeLock();
});

el("audioModeBtn").addEventListener("click", () => {
  const wrap = el("playerWrap");
  const on = wrap.classList.toggle("audio-mode");
  el("audioModeBtn").textContent = on ? "audio mode: on" : "audio mode: off";
  el("audioModeBtn").classList.toggle("active", on);
});

document.addEventListener("visibilitychange", () => {
  // Wake locks are released by the browser when the tab is hidden; re-acquire
  // when the tab becomes visible again if the user had it turned on.
  if (wakeLockWanted && document.visibilityState === "visible" && !wakeLock) {
    requestWakeLock();
  }
});
