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
1. Go to [dev.twitch.tv/console](https://dev.twitch.tv/console) and click **Register Your Application**
2. Give it any name (e.g. `My MultiChat`), set Category to **Chat Bot**
3. Set the **OAuth Redirect URL** to: `http://YOUR_TRUENAS_IP:3000/twitch/callback`
4. Click **Create**, then copy the **Client ID** and generate a **Client Secret**
5. Add those to `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in Dockge, along with your `TWITCH_CHANNEL`
6. Deploy the stack, then visit: `http://YOUR_TRUENAS_IP:3000/twitch/auth`
7. Authorize the app on Twitch
8. Copy the `TWITCH_ACCESS_TOKEN`, `TWITCH_REFRESH_TOKEN`, and `TWITCH_BOT_USERNAME` from the page shown
9. Update those env vars in Dockge and restart the stack
10. Tokens auto-refresh after that — no further manual steps needed

### YouTube
1. Go to https://console.cloud.google.com
2. Create a project → Enable **YouTube Data API v3**
3. Create an API Key → `YOUTUBE_API_KEY`
4. When you go live, grab the video ID from your stream URL (`?v=XXXXXXXXX`) → `YOUTUBE_LIVE_VIDEO_ID`

> ⚠️ YouTube requires a new video ID each stream. You'll need to update this env var and restart the container each time you go live. Alternatively, use a YouTube Scheduler to get a persistent stream key and video ID.

### Kick
1. Set `KICK_CHANNEL_NAME` to your Kick channel name
2. The app will auto-detect your chatroom ID
3. If auto-detection fails, find your chatroom ID by visiting:
   `https://kick.com/api/v2/channels/YOUR_CHANNEL_NAME`
   Look for `chatroom.id` in the JSON response

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
- Make sure you completed the OAuth flow at `/twitch/auth`
- Check that your redirect URL in the Twitch dev console exactly matches `http://YOUR_TRUENAS_IP:3000/twitch/callback`
- If your token expired and auto-refresh failed, re-run the auth flow at `/twitch/auth`

**YouTube not showing chat**
- YouTube chat only works during an active live stream
- Make sure the video ID matches the current stream, not a VOD

**Kick not connecting**
- Try setting `KICK_CHATROOM_ID` manually (see Kick section above)
- Kick's API occasionally changes — check container logs

**Joystick not connecting**
- Make sure you completed the OAuth flow at `/joystick/auth`
- Check that your redirect URL in the Joystick bot settings exactly matches `http://YOUR_TRUENAS_IP:3000/joystick/callback`

**General: check container logs in Dockge** — each platform logs its connection status clearly.
