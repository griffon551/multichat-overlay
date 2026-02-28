'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ─── Config from env ────────────────────────────────────────────────────────
const config = {
  twitch: {
    enabled: !!(process.env.TWITCH_CHANNEL && process.env.TWITCH_OAUTH_TOKEN),
    channel: process.env.TWITCH_CHANNEL,
    oauthToken: process.env.TWITCH_OAUTH_TOKEN, // "oauth:xxxx"
    botUsername: process.env.TWITCH_BOT_USERNAME || 'justinfan12345',
  },
  youtube: {
    enabled: !!(process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_LIVE_VIDEO_ID),
    apiKey: process.env.YOUTUBE_API_KEY,
    videoId: process.env.YOUTUBE_LIVE_VIDEO_ID,
    pollInterval: parseInt(process.env.YOUTUBE_POLL_INTERVAL_MS || '5000'),
  },
  kick: {
    enabled: !!(process.env.KICK_CHANNEL_NAME && process.env.KICK_PUSHER_KEY),
    channelName: process.env.KICK_CHANNEL_NAME,
    pusherKey: process.env.KICK_PUSHER_KEY || 'eb1d5f283081a78b932c',
    pusherCluster: process.env.KICK_PUSHER_CLUSTER || 'us2',
    chatroomId: process.env.KICK_CHATROOM_ID,
  },
  joystick: {
    enabled: !!(process.env.JOYSTICK_CLIENT_ID && process.env.JOYSTICK_CLIENT_SECRET),
    clientId: process.env.JOYSTICK_CLIENT_ID,
    clientSecret: process.env.JOYSTICK_CLIENT_SECRET,
    accessToken: process.env.JOYSTICK_ACCESS_TOKEN,
    refreshToken: process.env.JOYSTICK_REFRESH_TOKEN,
  },
};

// ─── Broadcast helper ────────────────────────────────────────────────────────
function broadcast(platform, username, message, color, badges) {
  const payload = {
    platform,
    username,
    message,
    color: color || null,
    badges: badges || [],
    ts: Date.now(),
  };
  console.log(`[${platform}] ${username}: ${message}`);
  io.emit('chat_message', payload);
}

// ─── TWITCH ──────────────────────────────────────────────────────────────────
function connectTwitch() {
  if (!config.twitch.enabled) return console.log('[Twitch] Disabled - missing env vars');

  const channel = config.twitch.channel.toLowerCase().replace('#', '');
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

  ws.on('open', () => {
    ws.send(`PASS ${config.twitch.oauthToken}`);
    ws.send(`NICK ${config.twitch.botUsername}`);
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send(`JOIN #${channel}`);
    console.log(`[Twitch] Connected to #${channel}`);
  });

  ws.on('message', (raw) => {
    const data = raw.toString();
    if (data.startsWith('PING')) {
      ws.send('PONG :tmi.twitch.tv');
      return;
    }

    const tagMatch = data.match(/^@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #\S+ :(.+)$/);
    if (!tagMatch) return;

    const tags = {};
    tagMatch[1].split(';').forEach(t => {
      const [k, v] = t.split('=');
      tags[k] = v;
    });

    const username = tags['display-name'] || tagMatch[2];
    const message = tagMatch[3].trim();
    const color = tags['color'] || null;
    const badges = tags['badges'] ? tags['badges'].split(',').map(b => b.split('/')[0]) : [];

    broadcast('twitch', username, message, color, badges);
  });

  ws.on('close', () => {
    console.log('[Twitch] Disconnected, reconnecting in 5s...');
    setTimeout(connectTwitch, 5000);
  });

  ws.on('error', (err) => console.error('[Twitch] Error:', err.message));
}

// ─── YOUTUBE ─────────────────────────────────────────────────────────────────
function connectYoutube() {
  if (!config.youtube.enabled) return console.log('[YouTube] Disabled - missing env vars');

  let liveChatId = null;
  let nextPageToken = null;
  const seenIds = new Set();

  async function getLiveChatId() {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${config.youtube.videoId}&key=${config.youtube.apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  }

  async function pollMessages() {
    try {
      if (!liveChatId) {
        liveChatId = await getLiveChatId();
        if (!liveChatId) {
          console.log('[YouTube] No active live chat found, retrying in 30s...');
          setTimeout(pollMessages, 30000);
          return;
        }
        console.log('[YouTube] Connected to live chat:', liveChatId);
      }

      let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${config.youtube.apiKey}`;
      if (nextPageToken) url += `&pageToken=${nextPageToken}`;

      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        console.error('[YouTube] API Error:', data.error.message);
        setTimeout(pollMessages, 30000);
        return;
      }

      nextPageToken = data.nextPageToken;

      for (const item of (data.items || [])) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        if (seenIds.size > 500) {
          const first = seenIds.values().next().value;
          seenIds.delete(first);
        }

        const author = item.authorDetails;
        const text = item.snippet?.displayMessage;
        if (!text) continue;

        const badges = [];
        if (author.isChatOwner) badges.push('owner');
        if (author.isChatModerator) badges.push('moderator');
        if (author.isChatSponsor) badges.push('member');

        broadcast('youtube', author.displayName, text, null, badges);
      }

      const pollIn = Math.max(data.pollingIntervalMillis || config.youtube.pollInterval, 2000);
      setTimeout(pollMessages, pollIn);
    } catch (err) {
      console.error('[YouTube] Error:', err.message);
      setTimeout(pollMessages, 10000);
    }
  }

  pollMessages();
}

// ─── KICK ────────────────────────────────────────────────────────────────────
// Kick uses Pusher for real-time chat
function connectKick() {
  if (!config.kick.enabled) return console.log('[Kick] Disabled - missing env vars');

  // Connect to Kick's Pusher instance
  const pusherKey = config.kick.pusherKey;
  const cluster = config.kick.pusherCluster;
  const chatroomId = config.kick.chatroomId;

  if (!chatroomId) {
    // Try to fetch chatroom ID from Kick API
    fetchKickChatroomId().then(id => {
      if (id) connectKickPusher(pusherKey, cluster, id);
      else console.error('[Kick] Could not get chatroom ID');
    });
  } else {
    connectKickPusher(pusherKey, cluster, chatroomId);
  }
}

async function fetchKickChatroomId() {
  try {
    const channelName = config.kick.channelName;
    const res = await fetch(`https://kick.com/api/v2/channels/${channelName}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MultiChat/1.0' }
    });
    const data = await res.json();
    const id = data?.chatroom?.id;
    if (id) console.log(`[Kick] Got chatroom ID: ${id}`);
    return id;
  } catch (err) {
    console.error('[Kick] Failed to fetch chatroom ID:', err.message);
    return null;
  }
}

function connectKickPusher(pusherKey, cluster, chatroomId) {
  const pusherUrl = `wss://ws-${cluster}.pusher.com/app/${pusherKey}?protocol=7&client=js&version=7.6.0&flash=false`;
  const ws = new WebSocket(pusherUrl);

  ws.on('open', () => {
    console.log(`[Kick] Pusher connected, joining chatroom ${chatroomId}`);
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'pusher:ping') {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        return;
      }
      if (msg.event === 'App\\Events\\ChatMessageEvent') {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const username = data?.sender?.username || data?.sender?.slug || 'Unknown';
        const text = data?.content || '';
        const color = data?.sender?.identity?.color || null;
        const badges = (data?.sender?.identity?.badges || []).map(b => b.type);
        if (text) broadcast('kick', username, text, color, badges);
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    console.log('[Kick] Disconnected, reconnecting in 5s...');
    setTimeout(() => connectKickPusher(pusherKey, cluster, chatroomId), 5000);
  });

  ws.on('error', (err) => console.error('[Kick] Error:', err.message));
}

// ─── JOYSTICK ────────────────────────────────────────────────────────────────
let joystickAccessToken = config.joystick.accessToken;
let joystickRefreshToken = config.joystick.refreshToken;

function getJoystickBasicKey() {
  return Buffer.from(`${config.joystick.clientId}:${config.joystick.clientSecret}`).toString('base64');
}

async function refreshJoystickToken() {
  try {
    const res = await fetch(
      `https://joystick.tv/api/oauth/token?grant_type=refresh_token&refresh_token=${joystickRefreshToken}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${getJoystickBasicKey()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      }
    );
    const data = await res.json();
    if (data.access_token) {
      joystickAccessToken = data.access_token;
      joystickRefreshToken = data.refresh_token;
      console.log('[Joystick] Token refreshed successfully');
      return true;
    }
    console.error('[Joystick] Token refresh failed:', data);
    return false;
  } catch (err) {
    console.error('[Joystick] Token refresh error:', err.message);
    return false;
  }
}

function connectJoystick() {
  if (!config.joystick.enabled) return console.log('[Joystick] Disabled - missing env vars');
  if (!joystickAccessToken) {
    console.log('[Joystick] No access token. Please complete OAuth flow at http://localhost:' + PORT + '/joystick/auth');
    return;
  }

  const basicKey = getJoystickBasicKey();
  const ws = new WebSocket(`wss://joystick.tv/cable?token=${basicKey}`, 'actioncable-v1-json');

  ws.on('open', () => {
    console.log('[Joystick] Connected, subscribing to GatewayChannel...');
    ws.send(JSON.stringify({
      command: 'subscribe',
      identifier: JSON.stringify({ channel: 'GatewayChannel' }),
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') return;
      if (msg.type === 'confirm_subscription') {
        console.log('[Joystick] Subscribed to GatewayChannel');
        return;
      }

      const payload = msg.message;
      if (!payload) return;

      if (payload.event === 'ChatMessage' && payload.type === 'new_message') {
        const username = payload.author?.username || 'Unknown';
        const text = payload.text || '';
        const color = payload.author?.usernameColor || null;
        const badges = [];
        if (payload.author?.isStreamer) badges.push('streamer');
        if (payload.author?.isModerator) badges.push('moderator');
        if (payload.author?.isSubscriber) badges.push('subscriber');
        if (text) broadcast('joystick', username, text, color, badges);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', async () => {
    console.log('[Joystick] Disconnected, attempting reconnect...');
    const refreshed = await refreshJoystickToken();
    setTimeout(connectJoystick, refreshed ? 1000 : 10000);
  });

  ws.on('error', (err) => console.error('[Joystick] Error:', err.message));
}

// ─── JOYSTICK OAUTH HELPER ROUTES ────────────────────────────────────────────
app.get('/joystick/auth', (req, res) => {
  const url = `https://joystick.tv/api/oauth/authorize?response_type=code&client_id=${config.joystick.clientId}&scope=bot`;
  res.redirect(url);
});

app.get('/joystick/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code received');

  try {
    const response = await fetch(
      `https://joystick.tv/api/oauth/token?redirect_uri=unused&code=${code}&grant_type=authorization_code`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${getJoystickBasicKey()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      }
    );
    const data = await response.json();
    if (data.access_token) {
      joystickAccessToken = data.access_token;
      joystickRefreshToken = data.refresh_token;
      res.send(`
        <h2>✅ Joystick Authorized!</h2>
        <p>Add these to your docker-compose.yml environment variables, then restart:</p>
        <pre>
JOYSTICK_ACCESS_TOKEN=${data.access_token}
JOYSTICK_REFRESH_TOKEN=${data.refresh_token}
        </pre>
        <p>Connecting now...</p>
      `);
      connectJoystick();
    } else {
      res.send('Error: ' + JSON.stringify(data));
    }
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

// ─── Status endpoint ─────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    twitch: config.twitch.enabled,
    youtube: config.youtube.enabled,
    kick: config.kick.enabled,
    joystick: config.joystick.enabled,
    joystickAuthed: !!joystickAccessToken,
  });
});

// ─── Static browser source ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── Socket.io connection ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[WS] OBS browser source connected');
  socket.emit('status', {
    twitch: config.twitch.enabled,
    youtube: config.youtube.enabled,
    kick: config.kick.enabled,
    joystick: config.joystick.enabled,
  });
});

// ─── Start everything ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮 MultiChat server running on port ${PORT}`);
  console.log(`   Browser source URL: http://localhost:${PORT}/`);
  console.log(`   Status: http://localhost:${PORT}/status\n`);

  connectTwitch();
  connectYoutube();
  connectKick();
  connectJoystick();
});
