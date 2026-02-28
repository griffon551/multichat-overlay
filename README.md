# 🎮 MultiChat Overlay

A self-hosted OBS browser source that combines live chat from **Twitch**, **YouTube**, **Kick.com**, and **Joystick.tv** into one unified overlay.

Runs in Docker via **Dockge** on TrueNAS (or any Docker host).

---

## 📁 File Structure

```
multichat/
├── docker-compose.yml   ← Paste into Dockge
├── Dockerfile
├── package.json
├── src/
│   └── server.js        ← Backend chat aggregator
└── public/
    └── index.html       ← OBS browser source overlay
```

---

## 🚀 Setup in Dockge (TrueNAS)

### 1. Copy files to TrueNAS

Upload this entire folder to your TrueNAS server. A good location is:
```
/mnt/your-pool/appdata/multichat/
```

### 2. Open Dockge

Navigate to your Dockge instance and create a new stack. Either:
- **Paste** the contents of `docker-compose.yml` into the compose editor, OR
- Point Dockge at the folder if it supports directory-based stacks

### 3. Fill in environment variables in Dockge

Only fill in the platforms you use — unused platforms are simply skipped.

---

## 🔑 Getting API Credentials

### Twitch *(OAuth required — one-time setup)*

> ⚠️ Twitch requires HTTPS for OAuth redirect URLs, except for `localhost`. Since TrueNAS is on a local IP, we use a `localhost` redirect and a manual copy-paste step.

1. Go to [dev.twitch.tv/console](https://dev.twitch.tv/console) and click **Register Your Application**
2. Give it any name (e.g. `My MultiChat`), set Category to **Chat Bot**
3. Set the **OAuth Redirect URL** to: `http://localhost:3000/twitch/callback`
4. Click **Create**, then copy the **Client ID** and generate a **Client Secret**
5. Add `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`, and `TWITCH_REDIRECT_URL=http://localhost:3000/twitch/callback` to your Dockge env vars
6. Deploy the stack, then visit: `http://YOUR_TRUENAS_IP:3000/twitch/manual`
7. Follow the on-screen instructions — you'll click a link, Twitch will authorize, then your browser will try to redirect to `localhost:3000` (which won't load)
8. Copy the full URL from your browser's address bar and paste it into the form on the manual page
9. Copy the `TWITCH_ACCESS_TOKEN`, `TWITCH_REFRESH_TOKEN`, and `TWITCH_BOT_USERNAME` shown into your Dockge env vars and restart
10. Tokens auto-refresh after that — no further manual steps needed

### YouTube
1. Go to https://console.cloud.google.com
2. Create a project → Enable **YouTube Data API v3**
3. Create an API Key → `YOUTUBE_API_KEY`
4. Find your YouTube Channel ID at https://www.youtube.com/account_advanced → `YOUTUBE_CHANNEL_ID`
5. That's it — the app will automatically detect when you go live and connect to your chat

> ℹ️ `YOUTUBE_LIVE_VIDEO_ID` is optional. Leave it blank to use auto-detection. You only need it if you want to force a specific stream.

### Kick
1. Set `KICK_CHANNEL_NAME` to your Kick channel name — no other credentials needed
2. The app fetches your chatroom ID and Pusher key automatically from Kick's API on startup
3. If auto-detection fails, find your chatroom ID manually by visiting:
   `https://kick.com/api/v2/channels/YOUR_CHANNEL_NAME`
   Look for `chatroom.id` in the JSON response, then set it as `KICK_CHATROOM_ID`

### Joystick.tv *(OAuth required — one-time setup)*
1. Log into Joystick.tv and go to **Settings → Bot Applications**
2. Create a new bot application
3. Set the **Redirect URL** to: `http://YOUR_TRUENAS_IP:3000/joystick/callback`
4. Request permissions: `ReadMessages`, `ReceiveStreamEvents`
5. Copy your **Client ID** and **Client Secret** into the env vars
6. Start the container, then visit: `http://YOUR_TRUENAS_IP:3000/joystick/auth`
7. Authorize the bot on Joystick
8. Copy the `JOYSTICK_ACCESS_TOKEN` and `JOYSTICK_REFRESH_TOKEN` from the page shown
9. Update those env vars in Dockge and restart the stack
10. Tokens auto-refresh after that — no further manual steps needed

---

## 📺 Adding to OBS

1. In OBS, add a **Browser Source**
2. Set URL to: `http://YOUR_TRUENAS_IP:3000/`
3. Set Width: `400`, Height: `800` (adjust to taste)
4. Check **"Shutdown source when not visible"** → uncheck
5. Check **"Refresh browser when scene becomes active"** → optional

> The overlay has a **transparent background** — no chroma key needed.

---

## 🎨 Customizing the Overlay

Edit `public/index.html` to change:

| Variable | Default | Description |
|---|---|---|
| `--msg-bg` | `rgba(15,15,20,0.82)` | Message background opacity |
| `--radius` | `10px` | Corner roundness |
| `MAX_MESSAGES` | `30` | Max messages shown at once |
| `MSG_LIFETIME_MS` | `60000` | How long messages stay (ms) |
| font-size in `.msg-text` | `14px` | Message text size |
| font-size in `.username` | `13px` | Username size |

Platform accent colors are set via CSS variables:
```css
--twitch:   #9146FF;
--youtube:  #FF0000;
--kick:     #53FC18;
--joystick: #FF6B35;
```

---

## 🔍 Checking Status

Visit `http://YOUR_TRUENAS_IP:3000/status` to see which platforms are connected:
```json
{
  "twitch": true,
  "twitchAuthed": true,
  "youtube": false,
  "kick": true,
  "joystick": true,
  "joystickAuthed": true
}
```

---

## 🐛 Troubleshooting

**Twitch not connecting**
- Make sure you completed the OAuth flow via `http://YOUR_TRUENAS_IP:3000/twitch/manual`
- Check that your redirect URL in the Twitch dev console exactly matches `http://localhost:3000/twitch/callback`
- Make sure `TWITCH_REDIRECT_URL` in Dockge is also set to `http://localhost:3000/twitch/callback`
- If your token expired and auto-refresh failed, re-run the auth flow at `/twitch/manual`

**YouTube not showing chat**
- YouTube chat only works during an active live stream
- The app checks for a live stream every 60s — it will connect automatically once you go live
- Make sure `YOUTUBE_CHANNEL_ID` is set correctly (find it at youtube.com/account_advanced)
- If you set `YOUTUBE_LIVE_VIDEO_ID` as an override, make sure it matches the current stream and not a VOD

**Kick not connecting**
- Check the logs — it will say "Successfully subscribed to chatroom" if working, or log a Pusher error if not
- If auto-detection of the chatroom ID fails, set `KICK_CHATROOM_ID` manually (see Kick section above)
- If it connects then immediately disconnects in a loop, Kick may have changed their API — check for a newer version of this project

**Joystick not connecting**
- Make sure you completed the OAuth flow at `/joystick/auth`
- Check that your redirect URL in the Joystick bot settings exactly matches `http://YOUR_TRUENAS_IP:3000/joystick/callback`

**General: check container logs in Dockge** — each platform logs its connection status clearly.
