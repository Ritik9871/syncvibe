# SyncVibe

Listen to music together in real time — synced play/pause/seek, voice chat, and text chat. You run the server yourself (laptop or phone); no data goes through anyone else's servers.

## What it does
- **Sync playback** — paste any YouTube link, both sides play/pause/seek together.
- **Voice chat** — real mic-to-mic call (WebRTC), with mute.
- **Text chat** — for typing while you talk/listen.
- **Rooms** — one person creates a room and shares a 5-character code; the other joins with it. Max 2 people per room.
- Spotify support is not built yet (see "About Spotify" below) — YouTube works out of the box.

## 1. Install
You need [Node.js](https://nodejs.org) (v18+) installed. Then, in this folder:
```bash
npm install
```

## 2. Run
```bash
npm start
```
You'll see:
```
Local:   http://localhost:3000
Network: http://<your-local-ip>:3000
```

## 3. Connect with your friend (different networks)
Since you said you and your friend are on different networks, `localhost` won't reach across the internet — you need to expose your server with a tunnel. Easiest option: **ngrok**.

1. Sign up free at https://ngrok.com and install it.
2. With your server running (`npm start`), open another terminal and run:
   ```bash
   ngrok http 3000
   ```
3. ngrok gives you a public URL like `https://abcd-1234.ngrok-free.app`. Send that to your friend — you both open it in a browser (works on phone or laptop).

Alternatives to ngrok: Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`), or deploying this folder to a free host like Render/Railway so it's always on and you don't need your laptop running as the server.

> Note: the free ngrok URL changes every time you restart it — reshare it with your friend each session, or get a paid ngrok static domain if you want a permanent link.

## 4. Using it
1. One person: enter a name → **Create room** → share the 5-letter code shown at the top.
2. Other person: enter a name → **Join a room** → paste the code.
3. Paste a YouTube link (full URL or just the video ID) → **Load**.
4. Play/pause/seek from either side — it stays synced. Use **resync** if it ever drifts.
5. Click **Enable mic** to start voice chat, **Mute** to mute yourself. Type in the chat box any time.

## About Spotify
Spotify playback control (via the Web Playback SDK) requires:
- A Spotify **Premium** account for whoever's audio is playing,
- Registering an app in the Spotify Developer Dashboard (Client ID + OAuth redirect setup),
- A logged-in Spotify session in the browser tab that's producing the audio.

That's a fair bit of setup (and Spotify's terms restrict some usage), so it's left out of this first version. If you want it added, the cleanest approach is: keep this same room/sync/chat/voice system, and swap in the Spotify Web Playback SDK as a second "source" tab next to YouTube (the UI already has a disabled "Spotify — soon" tab as a placeholder). Happy to build that next once you've registered a Spotify Developer app.

## Notes on voice chat reliability
Voice uses WebRTC with public STUN servers, which works for most home networks without extra setup. A small number of networks (strict corporate/mobile-carrier NATs) block direct peer connections and would need a TURN server to relay audio — if voice chat fails to connect for you two specifically, that's the likely cause, and I can add a TURN server (e.g. via a free tier from Twilio or Metered) if it comes up.

## Project structure
```
syncvibe/
  server.js          Express + Socket.io server (rooms, sync relay, chat relay, WebRTC signaling)
  public/
    index.html        Page structure
    style.css          Styling
    app.js             All client logic (YouTube player, sync, chat, WebRTC)
  package.json
```
