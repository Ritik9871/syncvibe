# SyncVibe

Listen to music together in real time — synced play/pause/seek, voice chat, and text chat. You run the server yourself (laptop or phone); no data goes through anyone else's servers.

## What it does
- **Sync playback** — paste any YouTube link, both sides play/pause/seek together.
- **Audius source** — search and play tracks from [Audius](https://audius.org), a free, legal, decentralized music streaming network with an open API. Audius plays through a real `<audio>` element instead of an embedded video, which is much more likely to keep playing when your screen locks (see below).
- **Up Next queue** — add several links or Audius tracks; when one song ends, the next in queue plays automatically for both of you (like a real playlist), regardless of which source each item came from. Either side can add or remove queued tracks, or hit "skip" to jump ahead.
- **Voice chat** — real mic-to-mic call (WebRTC), with mute.
- **Text chat** — for typing while you talk/listen.
- **Lock-screen media controls** — play/pause/skip show up in your phone's media controls (Media Session API), same as a real music app, for both YouTube and Audius.
- **Keep screen on** toggle — stops your phone from auto-locking from inactivity while you're listening (see limitation below).
- **Audio mode** — for YouTube, hides the video and shows a slim audio bar instead, for a Spotify-like feel. Still the same official YouTube embed underneath (just visually hidden), so it's fully within YouTube's terms. (Audius already plays as a compact audio bar by default, since there's no video.)
- **Reconnect grace period** — if your or your friend's connection drops briefly (screen lock, spotty mobile data), the room waits ~25s before telling the other person you left, so a normal screen-lock doesn't blow up the session.
- **Rooms** — one person creates a room and shares a 5-character code; the other joins with it. Max 2 people per room.
- Spotify support is not built yet (see "About Spotify" below) — YouTube and Audius work out of the box.

## About playback when your screen locks
Turning the screen off in the browser suspends the tab — this is an OS/browser restriction, not something a website can fully override. It affects an **embedded YouTube video** the most, because it's a cross-origin iframe. What this version does to help:
- **Audius tab (recommended for background listening)** — click the "Audius" source tab, search for a track, and add it. Audius plays through a plain `<audio>` element rather than a video iframe, which browsers (especially Android Chrome, and often iOS Safari too) are much more willing to keep running in the background when combined with Media Session metadata. This is the most reliable option in this app for playback that survives a screen lock.
- **Media Session integration** — for either source, the app registers itself as active media (title/artist/artwork + play/pause/skip handlers), which is the signal Android Chrome (and iOS Safari, for `<audio>`) use to keep audio playing after the screen locks — the same mechanism web players like SoundCloud's web player rely on.
- **"Keep screen on"** button — stops the screen from auto-locking from inactivity in the first place.
- **YouTube + iOS Safari is the strictest combination** — background audio for an embedded (cross-origin) video generally does not survive a manual screen lock there, regardless of what a website does. If you're on iPhone and want music through a locked screen, prefer the Audius tab.
- There's still no 100% guarantee on every device/browser version — a native app with a background-audio permission is the only fully reliable version of this, which is outside what a browser-based tool can do. But Audius + Media Session gets you meaningfully closer than the YouTube embed alone.

## About the "MP3" request
I didn't add a feature to extract/download audio from YouTube links — doing that violates YouTube's Terms of Service and is the same thing "YouTube-to-MP3" sites do, which is why those sites keep getting shut down or sued for copyright infringement. What's here instead is **Audio mode**, which just hides the video visually while the real, official YouTube player keeps running — same legitimate embed, just looks like an audio player.

## Security notes
Since you're exposing this to the internet, here's what's in place and what to keep in mind:
- **Room code = your access control.** There's no login — anyone with the 5-character code can join. That's a deliberate simplicity trade-off, but it means: don't post your room code publicly, and treat it like a shared secret.
- **Rate limiting** on room creation/joining (15 attempts/minute per connection) to slow down anyone trying to brute-force codes or spam-create rooms.
- **Server-side validation** on everything the server accepts — room codes, video IDs, names, and chat text are all format-checked and length-capped server-side (not just in the UI), so a modified/malicious client can't send garbage or oversized payloads.
- **XSS protection** — chat messages and names are HTML-escaped before being displayed, so pasting `<script>` tags or similar into chat can't run code in your friend's browser.
- **Security headers** (via Helmet) — hides the Express version fingerprint, sets `X-Content-Type-Options` and `X-Frame-Options`, etc.
- **What's still on you:** always tunnel through HTTPS (ngrok/Cloudflare Tunnel do this automatically), don't leave the server running/exposed when you're not using it, and don't share the room code outside the friend you're listening with. This is a fun project for you and a friend, not something to run as a public, always-on service without more hardening (proper auth, persistent storage, logging, etc.).

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
3. Pick a source at the top of the player:
   - **YouTube** — paste a link (full URL or just the video ID) → **Add to queue**.
   - **Audius** — type a song or artist name → **Search** → **Add** on the result you want. Prefer this tab if you want playback to survive a locked screen.
   - If nothing's playing yet, whatever you add starts right away; otherwise it joins the "Up Next" list.
4. Add more tracks any time from either source — they'll auto-play in order as each song finishes. Use **skip** to jump to the next one early, or the ✕ on a queued item to remove it.
5. Play/pause/seek from either side — it stays synced. Use **resync** if it ever drifts.
6. Click **Enable mic** to start voice chat, **Mute** to mute yourself. Type in the chat box any time.
7. Toggle **keep screen on** if you want to stop your phone from auto-locking while you listen.

## About Spotify
Spotify playback control (via the Web Playback SDK) requires:
- A Spotify **Premium** account for whoever's audio is playing,
- Registering an app in the Spotify Developer Dashboard (Client ID + OAuth redirect setup),
- A logged-in Spotify session in the browser tab that's producing the audio.

That's a fair bit of setup (and Spotify's terms restrict some usage), so it's left out of this first version. If you want it added, the cleanest approach is: keep this same room/sync/chat/voice system, and swap in the Spotify Web Playback SDK as a second "source" tab next to YouTube (the UI already has a disabled "Spotify — soon" tab as a placeholder). Happy to build that next once you've registered a Spotify Developer app.

## Notes on voice chat reliability
Voice uses WebRTC with public STUN servers, which works for most home networks without extra setup. A small number of networks (strict corporate/mobile-carrier NATs) block direct peer connections and would need a TURN server to relay audio — if voice chat fails to connect for you two specifically, that's the likely cause, and I can add a TURN server (e.g. via a free tier from Twilio or Metered) if it comes up.

## About Audius
[Audius](https://audius.org) is a free, ad-free music streaming network built by independent artists and labels, with an open, keyless API — no account or API key needed. The server picks a live Audius "discovery node" automatically and proxies search requests through it; the `<audio>` element then streams directly from Audius's own servers.
- Your server needs outbound internet access to reach Audius's API for this to work (same as any other feature that calls out to the internet).
- Audius's catalog is different from YouTube's — it's independent/underground-leaning rather than mainstream-label music, so not everything will be there. If a track isn't on Audius, the YouTube tab still covers anything on YouTube.

## Project structure
```
syncvibe/
  server.js          Express + Socket.io server (rooms, sync relay, chat relay, WebRTC signaling, Audius search/stream proxy)
  public/
    index.html        Page structure
    style.css          Styling
    app.js             All client logic (YouTube + Audius players, sync, chat, WebRTC)
  package.json
```
