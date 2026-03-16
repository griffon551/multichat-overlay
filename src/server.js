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
    enabled: !!(process.env.TWITCH_CHANNEL && process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
    channel: process.env.TWITCH_CHANNEL,
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    accessToken: process.env.TWITCH_ACCESS_TOKEN || null,
    refreshToken: process.env.TWITCH_REFRESH_TOKEN || null,
    botUsername: process.env.TWITCH_BOT_USERNAME || null,
  },
  youtube: {
    enabled: !!(process.env.YOUTUBE_API_KEY && (process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_LIVE_VIDEO_ID)),
    apiKey: process.env.YOUTUBE_API_KEY,
    channelId: process.env.YOUTUBE_CHANNEL_ID || null,   // preferred — auto-detects live stream
    videoId: process.env.YOUTUBE_LIVE_VIDEO_ID || null,  // optional override for a specific stream
    pollInterval: parseInt(process.env.YOUTUBE_POLL_INTERVAL_MS || '5000'),
  },
  kick: {
    enabled: !!(process.env.KICK_CHANNEL_NAME),
    channelName: process.env.KICK_CHANNEL_NAME,
    chatroomId: process.env.KICK_CHATROOM_ID || null,
  },
  joystick: {
    enabled: !!(process.env.JOYSTICK_CLIENT_ID && process.env.JOYSTICK_CLIENT_SECRET),
    clientId: process.env.JOYSTICK_CLIENT_ID,
    clientSecret: process.env.JOYSTICK_CLIENT_SECRET,
    accessToken: process.env.JOYSTICK_ACCESS_TOKEN || null,
    refreshToken: process.env.JOYSTICK_REFRESH_TOKEN || null,
  },
};

// ─── Broadcast helper ────────────────────────────────────────────────────────
function broadcast(platform, username, message, color, badges) {
  const payload = { platform, username, message, color: color || null, badges: badges || [], ts: Date.now() };
  console.log(`[${platform}] ${username}: ${message}`);
  io.emit('chat_message', payload);
}

// Parse Kick emotes: [emote:ID:name] → <img>
function parseKickEmotes(text) {
  return text.replace(/\[emote:(\d+):([^\]]+)\]/g, (_, id, name) => {
    return `<img src="https://files.kick.com/emotes/${id}/fullsize" style="height:1.4em;vertical-align:middle;display:inline-block;" alt="${name}">`;
  });
}

// Text emoticons → Unicode emoji
const TEXT_EMOTICONS = [
  [/:\)/g,  '🙂'], [/:-\)/g, '🙂'],
  [/:\(/g,  '😞'], [/:-(\)/g,'😞'],
  [/;\)/g,  '😉'], [/;-\)/g, '😉'],
  [/:D/g,   '😄'], [/:-D/g,  '😄'],
  [/xD/gi,  '😆'],
  [/<3/g,   '❤️'],
  [/:o/gi,  '😮'], [/:-o/gi, '😮'],
  [/:p/gi,  '😛'], [/:-p/gi, '😛'],
  [/>:/g,   '😠'],
  [/:\*/g,  '😘'],
  [/B\)/g,  '😎'],
  [/o_o/gi, '😶'],
  [/:\|/g,  '😐'],
];

// Parse Joystick emotes: :emoteName: → <img>, and text emoticons → emoji
function parseJoystickEmotes(text, payload) {
  // Build emote lookup from any emote data in the payload
  const emoteMap = {};

  // Joystick may send emotes as payload.emotes, payload.tokens, or similar
  const sources = [
    payload,
    payload?.emotes,
    payload?.tokens,
    payload?.chatEmotes,
  ].filter(Boolean);

  for (const src of sources) {
    if (Array.isArray(src)) {
      src.forEach(e => {
        const name = e.name || e.slug || e.token;
        const url  = e.url  || e.image_url || e.imageUrl || e.src;
        if (name && url) emoteMap[name] = url;
      });
    }
  }

  // Replace :emoteName: with image if we have a URL for it
  text = text.replace(/:([\w]+):/g, (match, name) => {
    if (emoteMap[name]) {
      return `<img src="${emoteMap[name]}" style="height:1.4em;vertical-align:middle;display:inline-block;" alt="${name}">`;
    }
    return match; // leave unknown :tokens: alone
  });

  // Convert text emoticons to Unicode
  TEXT_EMOTICONS.forEach(([pattern, emoji]) => {
    text = text.replace(pattern, emoji);
  });

  return text;
}

// ─── TWITCH ──────────────────────────────────────────────────────────────────
let twitchAccessToken = config.twitch.accessToken;
let twitchRefreshToken = config.twitch.refreshToken;
let twitchUsername = config.twitch.botUsername;

async function refreshTwitchToken() {
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: twitchRefreshToken,
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      twitchAccessToken = data.access_token;
      twitchRefreshToken = data.refresh_token;
      console.log('[Twitch] Token refreshed successfully');
      return true;
    }
    console.error('[Twitch] Token refresh failed:', data);
    return false;
  } catch (err) {
    console.error('[Twitch] Token refresh error:', err.message);
    return false;
  }
}

async function fetchTwitchUsername() {
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${twitchAccessToken}`,
        'Client-Id': config.twitch.clientId,
      },
    });
    const data = await res.json();
    return data.data?.[0]?.login || null;
  } catch (err) {
    console.error('[Twitch] Failed to fetch username:', err.message);
    return null;
  }
}

function connectTwitch() {
  if (!config.twitch.enabled) return console.log('[Twitch] Disabled - missing env vars');
  if (!twitchAccessToken) {
    console.log('[Twitch] No access token. Visit http://localhost:' + PORT + '/twitch/auth to authorize.');
    return;
  }

  const channel = config.twitch.channel.toLowerCase().replace('#', '');
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

  ws.on('open', async () => {
    if (!twitchUsername) twitchUsername = await fetchTwitchUsername();
    ws.send(`PASS oauth:${twitchAccessToken}`);
    ws.send(`NICK ${twitchUsername || 'justinfan12345'}`);
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send(`JOIN #${channel}`);
    console.log(`[Twitch] Connected to #${channel} as ${twitchUsername}`);
  });

  ws.on('message', (raw) => {
    // Twitch can send multiple IRC lines in one WebSocket message
    const lines = raw.toString().split('\r\n').filter(Boolean);
    for (const data of lines) {
      if (data.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      if (data.includes('NOTICE * :Login authentication failed')) {
        console.log('[Twitch] Auth failed, attempting token refresh...');
        ws.close();
        return;
      }
      const tagMatch = data.match(/^@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #\S+ :(.+)$/);
      if (!tagMatch) continue;
      const tags = {};
      tagMatch[1].split(';').forEach(t => { const [k, v] = t.split('='); tags[k] = v; });
      const username = tags['display-name'] || tagMatch[2];
      const rawMessage = tagMatch[3].trim();
      const color = tags['color'] || null;
      const badges = tags['badges'] ? tags['badges'].split(',').map(b => b.split('/')[0]) : [];
      // Replace Twitch emotes with images using the emotes tag
      let message = rawMessage;
      if (tags['emotes']) {
        // emotes tag format: emoteId:start-end,start-end/emoteId2:start-end
        const emoteMap = {};
        tags['emotes'].split('/').forEach(entry => {
          const [id, positions] = entry.split(':');
          if (!id || !positions) return;
          const pos = positions.split(',')[0].split('-');
          const start = parseInt(pos[0]);
          const end = parseInt(pos[1]);
          const name = rawMessage.substring(start, end + 1);
          emoteMap[name] = `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0" style="height:1.4em;vertical-align:middle;display:inline-block;" alt="${name}">`;
        });
        // Replace emote names with images (longest first to avoid partial matches)
        Object.keys(emoteMap).sort((a,b) => b.length - a.length).forEach(name => {
          message = message.split(name).join(emoteMap[name]);
        });
      }
      broadcast('twitch', username, message, color, badges);
    }
  });

  ws.on('close', async () => {
    console.log('[Twitch] Disconnected, attempting reconnect...');
    const refreshed = await refreshTwitchToken();
    setTimeout(connectTwitch, refreshed ? 1000 : 10000);
  });

  ws.on('error', (err) => console.error('[Twitch] Error:', err.message));
}

// ─── TWITCH OAUTH ROUTES ─────────────────────────────────────────────────────
// Twitch requires HTTPS for redirect URIs except for localhost.
// Set TWITCH_REDIRECT_URL in your env to override (e.g. http://localhost:3000/twitch/callback).
// Then in the Twitch dev console, register that exact URL as your OAuth Redirect URL.

function getTwitchRedirectUri(host) {
  return process.env.TWITCH_REDIRECT_URL || `http://${host}/twitch/callback`;
}

// Step 1 — redirect user to Twitch to authorize
app.get('/twitch/auth', (req, res) => {
  const redirectUri = getTwitchRedirectUri(req.headers.host);
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'chat:read chat:edit',
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

// Step 2 — Twitch redirects back here with ?code=...
// If using localhost redirect, Twitch lands on your PC not the server.
// In that case use /twitch/manual to paste the full redirect URL instead.
app.get('/twitch/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code received');
  await exchangeTwitchCode(code, getTwitchRedirectUri(req.headers.host), res);
});

// Manual entry page — paste the full redirect URL from your browser here
// Useful when using localhost redirect on a headless server
app.get('/twitch/manual', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Twitch Manual Auth</title>
    <style>
      body { font-family: sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; background: #0e0e10; color: #efeff1; }
      h2 { color: #9146ff; }
      input { width: 100%; padding: 10px; margin: 10px 0; background: #1f1f23; border: 1px solid #3a3a3d; color: #efeff1; border-radius: 4px; font-size: 14px; }
      button { background: #9146ff; color: white; border: none; padding: 10px 24px; border-radius: 4px; font-size: 15px; cursor: pointer; }
      button:hover { background: #772ce8; }
      ol { line-height: 2; }
      code { background: #1f1f23; padding: 2px 6px; border-radius: 3px; }
    </style>
    </head>
    <body>
      <h2>🔐 Twitch Manual Authorization</h2>
      <p>Use this if your server can't receive the Twitch redirect directly.</p>
      <ol>
        <li>Register <code>http://localhost:3000/twitch/callback</code> as your OAuth Redirect URL in the <a href="https://dev.twitch.tv/console" style="color:#9146ff">Twitch dev console</a></li>
        <li>Set <code>TWITCH_REDIRECT_URL=http://localhost:3000/twitch/callback</code> in your Dockge env vars</li>
        <li>On the machine you're reading this from, visit <a href="/twitch/auth" style="color:#9146ff">this link to start the Twitch auth flow</a></li>
        <li>Twitch will redirect your browser to <code>http://localhost:3000/twitch/callback?code=...</code> — that page won't load, but copy the full URL from your browser address bar</li>
        <li>Paste the full URL below and click Submit</li>
      </ol>
      <input type="text" id="url" placeholder="http://localhost:3000/twitch/callback?code=abc123&scope=..." />
      <button onclick="submit()">Submit</button>
      <div id="result" style="margin-top:20px"></div>
      <script>
        async function submit() {
          const raw = document.getElementById('url').value.trim();
          let code;
          try { code = new URL(raw).searchParams.get('code'); } catch(e) {}
          if (!code) { document.getElementById('result').innerHTML = '<p style="color:red">Could not find a code in that URL. Make sure you pasted the full redirect URL.</p>'; return; }
          document.getElementById('result').innerHTML = '<p>Exchanging code...</p>';
          const res = await fetch('/twitch/exchange?code=' + encodeURIComponent(code));
          const text = await res.text();
          document.getElementById('result').innerHTML = text;
        }
      </script>
    </body>
    </html>
  `);
});

// Internal exchange endpoint used by the manual page
app.get('/twitch/exchange', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<p style="color:red">No code provided.</p>');
  await exchangeTwitchCode(code, getTwitchRedirectUri(req.headers.host), res);
});

async function exchangeTwitchCode(code, redirectUri, res) {
  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const data = await tokenRes.json();
    if (data.access_token) {
      twitchAccessToken = data.access_token;
      twitchRefreshToken = data.refresh_token;
      twitchUsername = await fetchTwitchUsername();
      res.send(`
        <h2>✅ Twitch Authorized!</h2>
        <p>Add these to your docker-compose.yml environment variables, then restart:</p>
        <pre>
TWITCH_ACCESS_TOKEN=${data.access_token}
TWITCH_REFRESH_TOKEN=${data.refresh_token}
TWITCH_BOT_USERNAME=${twitchUsername || ''}
        </pre>
        <p>Connecting now...</p>
      `);
      connectTwitch();
    } else {
      res.send('<h2>❌ Authorization failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
  } catch (err) {
    res.send('Error: ' + err.message);
  }
}

// ─── YOUTUBE ─────────────────────────────────────────────────────────────────
const YOUTUBE_TIMEOUT_MS  = 15 * 60 * 1000; // 15 minutes
const YOUTUBE_RECONNECT_DELAY = 10 * 1000;  // 10s reconnect on transient error

let youtubeActive    = false;
let youtubePollTimer = null;
let youtubeExpireTimer = null;
let youtubeLiveChatId  = null;
let youtubeNextToken   = null;
const youtubeSeenIds   = new Set();

function youtubeReset(reason) {
  console.log(`[YouTube] Reset: ${reason}`);
  youtubeActive = false;
  youtubeLiveChatId = null;
  youtubeNextToken  = null;
  if (youtubePollTimer)   { clearTimeout(youtubePollTimer);   youtubePollTimer   = null; }
  if (youtubeExpireTimer) { clearTimeout(youtubeExpireTimer); youtubeExpireTimer = null; }
}

async function youtubeGetLiveChatId() {
  if (config.youtube.videoId) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${config.youtube.videoId}&key=${config.youtube.apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    return data.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
  } else {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${config.youtube.channelId}&eventType=live&type=video&key=${config.youtube.apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) { console.error('[YouTube] Search API error:', data.error.message); return null; }
    const videoId = data.items?.[0]?.id?.videoId;
    if (!videoId) return null;
    console.log('[YouTube] Found live stream:', videoId);
    const vRes  = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${config.youtube.apiKey}`);
    const vData = await vRes.json();
    return vData.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
  }
}

async function youtubePoll() {
  youtubePollTimer = null;
  if (!youtubeActive) return;
  try {
    if (!youtubeLiveChatId) {
      youtubeLiveChatId = await youtubeGetLiveChatId();
      if (!youtubeLiveChatId) {
        console.log('[YouTube] No active live stream found, retrying in 30s...');
        youtubePollTimer = setTimeout(youtubePoll, 30000);
        return;
      }
      console.log('[YouTube] Connected to live chat:', youtubeLiveChatId);
    }

    let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${youtubeLiveChatId}&part=snippet,authorDetails&key=${config.youtube.apiKey}`;
    if (youtubeNextToken) url += `&pageToken=${youtubeNextToken}`;

    const res  = await fetch(url);
    const data = await res.json();

    if (data.error) {
      const code = data.error.code;
      const msg  = data.error.message || '';
      console.error('[YouTube] API Error:', msg);

      if (msg.includes('quota')) {
        console.log('[YouTube] Quota exceeded — resetting. Re-trigger when ready.');
        youtubeReset('quota exceeded');
        return;
      }
      if (code === 403 || code === 404) {
        // Stream ended — auto-reconnect after short delay in case of blip
        console.log('[YouTube] Chat unavailable, attempting reconnect in 10s...');
        youtubeLiveChatId = null;
        youtubeNextToken  = null;
        youtubePollTimer  = setTimeout(youtubePoll, YOUTUBE_RECONNECT_DELAY);
        return;
      }
      // Other transient error — retry
      youtubePollTimer = setTimeout(youtubePoll, YOUTUBE_RECONNECT_DELAY);
      return;
    }

    youtubeNextToken = data.nextPageToken;
    for (const item of (data.items || [])) {
      if (youtubeSeenIds.has(item.id)) continue;
      youtubeSeenIds.add(item.id);
      if (youtubeSeenIds.size > 500) { const first = youtubeSeenIds.values().next().value; youtubeSeenIds.delete(first); }
      const author = item.authorDetails;
      const text   = item.snippet?.displayMessage;
      if (!text) continue;
      const badges = [];
      if (author.isChatOwner)     badges.push('owner');
      if (author.isChatModerator) badges.push('moderator');
      if (author.isChatSponsor)   badges.push('member');
      broadcast('youtube', author.displayName, text, null, badges);
    }

    // Respect YouTube's requested interval, minimum 30s to preserve quota
    const pollIn = Math.max(data.pollingIntervalMillis || config.youtube.pollInterval, 30000);
    youtubePollTimer = setTimeout(youtubePoll, pollIn);

  } catch (err) {
    console.error('[YouTube] Error:', err.message);
    if (youtubeActive) youtubePollTimer = setTimeout(youtubePoll, YOUTUBE_RECONNECT_DELAY);
  }
}

function connectYoutube(manual = false) {
  if (!config.youtube.enabled) return console.log('[YouTube] Disabled - missing env vars');
  if (youtubeActive) {
    console.log('[YouTube] Already active — resetting first');
    youtubeReset('re-triggered');
  }
  console.log(`[YouTube] ${manual ? 'Manual trigger' : 'Auto-start'} — connecting...`);
  youtubeActive = true;

  // 15-minute auto-expire timeout
  youtubeExpireTimer = setTimeout(() => {
    console.log('[YouTube] 15-minute timeout reached — resetting. Re-trigger to reconnect.');
    youtubeReset('15-minute timeout');
  }, YOUTUBE_TIMEOUT_MS);

  youtubePoll();
}

// ─── KICK ────────────────────────────────────────────────────────────────────
// Kick uses their own WebSocket endpoint (not Pusher directly)
async function fetchKickChannelInfo() {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${config.kick.channelName}`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://kick.com/',
        'Origin': 'https://kick.com',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      }
    });

    if (!res.ok) {
      console.error(`[Kick] API returned ${res.status} ${res.statusText}`);
      // If blocked, suggest setting KICK_CHATROOM_ID manually
      if (res.status === 403 || res.status === 401 || res.status === 429) {
        console.error('[Kick] Access denied by Kick API. Set KICK_CHATROOM_ID manually in your env vars.');
        console.error(`[Kick] Find your chatroom ID at: https://kick.com/api/v2/channels/${config.kick.channelName}`);
      }
      return null;
    }

    const data = await res.json();
    const chatroomId = data?.chatroom?.id || null;
    if (chatroomId) console.log(`[Kick] Channel ID: ${data?.id}, Chatroom ID: ${chatroomId}`);
    return {
      chatroomId,
      pusherKey: '32cbd69e4b950bf97679',
      pusherCluster: 'us2',
    };
  } catch (err) {
    console.error('[Kick] Failed to fetch channel info:', err.message);
    return null;
  }
}

async function connectKick() {
  if (!config.kick.enabled) return console.log('[Kick] Disabled - missing KICK_CHANNEL_NAME');

  let chatroomId = config.kick.chatroomId;
  let pusherKey = '32cbd69e4b950bf97679';

  if (!chatroomId) {
    console.log('[Kick] Fetching channel info...');
    const info = await fetchKickChannelInfo();
    if (!info || !info.chatroomId) {
      console.error('[Kick] Could not get chatroom ID, retrying in 30s...');
      setTimeout(connectKick, 30000);
      return;
    }
    chatroomId = info.chatroomId;
    pusherKey = info.pusherKey;
    console.log(`[Kick] Got chatroom ID: ${chatroomId}`);
  }

  connectKickWebSocket(chatroomId, pusherKey);
}

function connectKickWebSocket(chatroomId, pusherKey) {
  // Kick's WebSocket — connect to their Pusher-compatible endpoint
  const wsUrl = `wss://ws-us2.pusher.com/app/${pusherKey}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
  const ws = new WebSocket(wsUrl, {
    headers: {
      'Origin': 'https://kick.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
  });

  let pingInterval = null;

  ws.on('open', () => {
    console.log(`[Kick] WebSocket connected, subscribing to chatroom ${chatroomId}`);
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
    }));

    // Keep-alive ping every 30s
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'pusher:connection_established') {
        console.log('[Kick] Connection established');
        return;
      }
      if (msg.event === 'pusher:pong' || msg.event === 'pusher:ping') return;
      if (msg.event === 'pusher_internal:subscription_succeeded') {
        console.log('[Kick] Successfully subscribed to chatroom');
        return;
      }
      if (msg.event === 'pusher:error') {
        console.error('[Kick] Pusher error:', msg.data);
        return;
      }

      if (msg.event === 'App\\Events\\ChatMessageEvent') {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const username = data?.sender?.username || data?.sender?.slug || 'Unknown';
        const rawText = data?.content || '';
        const color = data?.sender?.identity?.color || null;
        const badges = (data?.sender?.identity?.badges || []).map(b => b.type);
        const text = parseKickEmotes(rawText);
        if (text) broadcast('kick', username, text, color, badges);
      }
    } catch (e) { /* ignore parse errors */ }
  });

  ws.on('close', (code, reason) => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    console.log(`[Kick] Disconnected (${code}), reconnecting in 10s...`);
    setTimeout(() => connectKickWebSocket(chatroomId, pusherKey), 10000);
  });

  ws.on('error', (err) => {
    console.error('[Kick] WebSocket error:', err.message);
  });
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
    console.log('[Joystick] No access token. Visit http://localhost:' + PORT + '/joystick/auth to authorize.');
    return;
  }

  const basicKey = getJoystickBasicKey();
  const ws = new WebSocket(`wss://joystick.tv/cable?token=${basicKey}`, 'actioncable-v1-json');

  ws.on('open', () => {
    console.log('[Joystick] Connected, subscribing to GatewayChannel...');
    ws.send(JSON.stringify({ command: 'subscribe', identifier: JSON.stringify({ channel: 'GatewayChannel' }) }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') return;
      if (msg.type === 'confirm_subscription') { console.log('[Joystick] Subscribed to GatewayChannel'); return; }
      if (msg.type === 'reject_subscription') { console.error('[Joystick] Subscription rejected — check credentials'); return; }
      const payload = msg.message;
      if (!payload) return;
      if (payload.event === 'ChatMessage' && payload.type === 'new_message') {
        console.log('[Joystick] RAW PAYLOAD:', JSON.stringify(payload).substring(0, 500));
        const username = payload.author?.username || 'Unknown';
        const rawText = payload.text || '';
        const color = payload.author?.usernameColor || null;
        const badges = [];
        if (payload.author?.isStreamer) badges.push('streamer');
        if (payload.author?.isModerator) badges.push('moderator');
        if (payload.author?.isSubscriber) badges.push('subscriber');
        const text = parseJoystickEmotes(rawText, payload);
        if (text) broadcast('joystick', username, text, color, badges);
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', async () => {
    console.log('[Joystick] Disconnected, attempting reconnect...');
    const refreshed = await refreshJoystickToken();
    setTimeout(connectJoystick, refreshed ? 1000 : 10000);
  });

  ws.on('error', (err) => console.error('[Joystick] Error:', err.message));
}

// ─── JOYSTICK OAUTH ROUTES ───────────────────────────────────────────────────
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
      res.send('<h2>❌ Authorization failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

// ─── Streamer.bot webhooks — start / reset YouTube ───────────────────────────
// Start: call at stream begin  →  GET http://SERVER:3030/youtube/start
// Reset: call at stream end    →  GET http://SERVER:3030/youtube/reset
['get','post'].forEach(method => {
  app[method]('/youtube/start', (req, res) => {
    console.log('[YouTube] /start triggered');
    connectYoutube(true);
    res.json({ ok: true, status: 'started' });
  });
  app[method]('/youtube/reset', (req, res) => {
    console.log('[YouTube] /reset triggered');
    youtubeReset('manual reset via webhook');
    res.json({ ok: true, status: 'reset' });
  });
});

// ─── Status endpoint ─────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    twitch: config.twitch.enabled,
    twitchAuthed: !!twitchAccessToken,
    youtube: config.youtube.enabled,
    kick: config.kick.enabled,
    joystick: config.joystick.enabled,
    joystickAuthed: !!joystickAccessToken,
  });
});

// ─── Static browser source ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[WS] OBS browser source connected');
  socket.emit('status', {
    twitch: config.twitch.enabled,
    youtube: config.youtube.enabled,
    kick: config.kick.enabled,
    joystick: config.joystick.enabled,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮 MultiChat server running on port ${PORT}`);
  console.log(`   Browser source:  http://localhost:${PORT}/`);
  console.log(`   Status:          http://localhost:${PORT}/status`);
  console.log(`   Twitch auth:     http://localhost:${PORT}/twitch/auth`);
  console.log(`   Joystick auth:   http://localhost:${PORT}/joystick/auth\n`);

  connectTwitch();
  if (!process.env.YOUTUBE_STREAMERBOT_TRIGGER) connectYoutube(); // auto-start unless manual trigger mode
  connectKick();
  connectJoystick();
});
