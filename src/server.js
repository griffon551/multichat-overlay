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
    enabled: !!((process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_ACCESS_TOKEN) && (process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_LIVE_VIDEO_ID)),
    apiKey: process.env.YOUTUBE_API_KEY || null,           // legacy API key (no emoji images)
    clientId: process.env.YOUTUBE_CLIENT_ID || null,       // OAuth client ID
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || null,
    accessToken: process.env.YOUTUBE_ACCESS_TOKEN || null,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || null,
    channelId: process.env.YOUTUBE_CHANNEL_ID || null,
    videoId: process.env.YOUTUBE_LIVE_VIDEO_ID || null,
    pollInterval: parseInt(process.env.YOUTUBE_POLL_INTERVAL_MS || '30000'),
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
  const logMsg = message.replace(/<[^>]+>/g, '[emote]');
  console.log(`[${platform}] ${username}: ${logMsg}`);
  io.emit('chat_message', payload);
}

// Emit platform connection status to overlay
// state: 'connected' | 'reconnecting' | 'disconnected'
function broadcastStatus(platform, state, message) {
  io.emit('platform_status', { platform, state, message: message || '' });
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
  [/:\(/g,  '😞'], [/:-\(/g, '😞'],
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
  [/:P/g,   '😛'], [/:-P/g,  '😛'],
  [/:p/g,   '😛'], [/:-p/g,  '😛'],
];

// Parse Joystick emotes: :emoteName: → <img>, and text emoticons → emoji
function parseJoystickEmotes(text, payload) {
  // Build emote lookup from emotesUsed array (code + signedUrl)
  const emoteMap = {};
  const emotesUsed = payload?.emotesUsed;
  if (Array.isArray(emotesUsed)) {
    emotesUsed.forEach(e => {
      const code = e.code; // e.g. ":Griffon551hug:"
      const url  = e.signedUrl || e.url;
      if (code && url) emoteMap[code] = url; // store with colons as-is
    });
  }

  // Replace full :code: patterns (including surrounding colons) with images
  // Sort longest first to avoid partial matches
  Object.keys(emoteMap)
    .sort((a, b) => b.length - a.length)
    .forEach(code => {
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const name = code.replace(/:/g, '');
      text = text.split(code).join(
        `<img src="${emoteMap[code]}" style="height:1.4em;vertical-align:middle;display:inline-block;" alt="${name}">`
      );
    });

  // Convert text emoticons to Unicode
  TEXT_EMOTICONS.forEach(([pattern, emoji]) => {
    text = text.replace(pattern, emoji);
  });

  return text;
}


// YouTube emoji shortcodes → actual CDN image URLs (from yt3.ggpht.com)
const YOUTUBE_EMOJI_URLS = {
  ':hand-pink-waving:': 'https://yt3.ggpht.com/KOxdr_z3A5h1Gb7kqnxqOCnbZrBmxI2B_tRQ453BhTWUhYAlpg5ZP8IKEBkcvRoY8grY91Q=w48-h48-c-k-nd',
  ':face-blue-smiling:': 'https://yt3.ggpht.com/cktIaPxFwnrPwn-alHvnvedHLUJwbHi8HCK3AgbHpphrMAW99qw0bDfxuZagSY5ieE9BBrA=w48-h48-c-k-nd',
  ':face-red-droopy-eyes:': 'https://yt3.ggpht.com/oih9s26MOYPWC_uL6tgaeOlXSGBv8MMoDrWzBt-80nEiVSL9nClgnuzUAKqkU9_TWygF6CI=w48-h48-c-k-nd',
  ':face-purple-crying:': 'https://yt3.ggpht.com/g6_km98AfdHbN43gvEuNdZ2I07MmzVpArLwEvNBwwPqpZYzszqhRzU_DXALl11TchX5_xFE=w48-h48-c-k-nd',
  ':text-green-game-over:': 'https://yt3.ggpht.com/cr36FHhSiMAJUSpO9XzjbOgxhtrdJNTVJUlMJeOOfLOFzKleAKT2SEkZwbqihBqfTXYCIg=w48-h48-c-k-nd',
  ':person-turqouise-waving:': 'https://yt3.ggpht.com/uNSzQ2M106OC1L3VGzrOsGNjopboOv-m1bnZKFGuh0DxcceSpYHhYbuyggcgnYyaF3o-AQ=w48-h48-c-k-nd',
  ':face-green-smiling:': 'https://yt3.ggpht.com/G061SAfXg2bmG1ZXbJsJzQJpN8qEf_W3f5cb5nwzBYIV58IpPf6H90lElDl85iti3HgoL3o=w48-h48-c-k-nd',
  ':face-orange-frowning:': 'https://yt3.ggpht.com/Ar8jaEIxzfiyYmB7ejDOHba2kUMdR37MHn_R39mtxqO5CD4aYGvjDFL22DW_Cka6LKzhGDk=w48-h48-c-k-nd',
  ':eyes-purple-crying:': 'https://yt3.ggpht.com/FrYgdeZPpvXs-6Mp305ZiimWJ0wV5bcVZctaUy80mnIdwe-P8HRGYAm0OyBtVx8EB9_Dxkc=w48-h48-c-k-nd',
  ':face-fuchsia-wide-eyes:': 'https://yt3.ggpht.com/zdcOC1SMmyXJOAddl9DYeEFN9YYcn5mHemJCdRFQMtDuS0V-IyE-5YjNUL1tduX1zs17tQ=w48-h48-c-k-nd',
  ':cat-orange-whistling:': 'https://yt3.ggpht.com/0ocqEmuhrKCK87_J21lBkvjW70wRGC32-Buwk6TP4352CgcNjL6ug8zcsel6JiPbE58xhq5g=w48-h48-c-k-nd',
  ':face-blue-wide-eyes:': 'https://yt3.ggpht.com/2Ht4KImoWDlCddiDQVuzSJwpEb59nZJ576ckfaMh57oqz2pUkkgVTXV8osqUOgFHZdUISJM=w48-h48-c-k-nd',
  ':face-orange-raised-eyebrow:': 'https://yt3.ggpht.com/JbCfmOgYI-mO17LPw8e_ycqbBGESL8AVP6i7ZsBOVLd3PEpgrfEuJ9rEGpP_unDcqgWSCg=w48-h48-c-k-nd',
  ':face-fuchsia-tongue-out:': 'https://yt3.ggpht.com/EURfJZi_heNulV3mfHzXBk8PIs9XmZ9lOOYi5za6wFMCGrps4i2BJX9j-H2gK6LIhW6h7sY=w48-h48-c-k-nd',
  ':face-orange-biting-nails:': 'https://yt3.ggpht.com/HmsXEgqUogkQOnL5LP_FdPit9Z909RJxby-uYcPxBLNhaPyqPTcGwvGaGPk2hzB_cC0hs_pV=w48-h48-c-k-nd',
  ':face-red-heart-shape:': 'https://yt3.ggpht.com/I0Mem9dU_IZ4a9cQPzR0pUJ8bH-882Eg0sDQjBmPcHA6Oq0uXOZcsjPvPbtormx91Ha2eRA=w48-h48-c-k-nd',
  ':face-fuchsia-poop-shape:': 'https://yt3.ggpht.com/_xlyzvSimqMzhdhODyqUBLXIGA6F_d5en2bq-AIfc6fc3M7tw2jucuXRIo5igcW3g9VVe3A=w48-h48-c-k-nd',
  ':face-purple-wide-eyes:': 'https://yt3.ggpht.com/5RDrtjmzRQKuVYE_FKPUHiGh7TNtX5eSNe6XzcSytMsHirXYKunxpyAsVacTFMg0jmUGhQ=w48-h48-c-k-nd',
  ':glasses-purple-yellow-diamond:': 'https://yt3.ggpht.com/EnDBiuksboKsLkxp_CqMWlTcZtlL77QBkbjz_rLedMSDzrHmy_6k44YWFy2rk4I0LG6K2KI=w48-h48-c-k-nd',
  ':face-pink-tears:': 'https://yt3.ggpht.com/RL5QHCNcO_Mc98SxFEblXZt9FNoh3bIgsjm0Kj8kmeQJWMeTu7JX_NpICJ6KKwKT0oVHhAA=w48-h48-c-k-nd',
  ':body-blue-raised-arms:': 'https://yt3.ggpht.com/2Jds3I9UKOfgjid97b_nlDU4X2t5MgjTof8yseCp7M-6ZhOhRkPGSPfYwmE9HjCibsfA1Uzo=w48-h48-c-k-nd',
  ':hand-orange-covering-eyes:': 'https://yt3.ggpht.com/y8ppa6GcJoRUdw7GwmjDmTAnSkeIkUptZMVQuFmFaTlF_CVIL7YP7hH7hd0TJbd8p9w67IM=w48-h48-c-k-nd',
  ':trophy-yellow-smiling:': 'https://yt3.ggpht.com/7tf3A_D48gBg9g2N0Rm6HWs2aqzshHU4CuVubTXVxh1BP7YDBRC6pLBoC-ibvr-zCl_Lgg=w48-h48-c-k-nd',
  ':eyes-pink-heart-shape:': 'https://yt3.ggpht.com/5vzlCQfQQdzsG7nlQzD8eNjtyLlnATwFwGvrMpC8dgLcosNhWLXu8NN9qIS3HZjJYd872dM=w48-h48-c-k-nd',
  ':face-turquoise-covering-eyes:': 'https://yt3.ggpht.com/H2HNPRO8f4SjMmPNh5fl10okSETW7dLTZtuE4jh9D6pSmaUiLfoZJ2oiY-qWU3Owfm1IsXg=w48-h48-c-k-nd',
  ':hand-green-crystal-ball:': 'https://yt3.ggpht.com/qZfJrWDEmR03FIak7PMNRNpMjNsCnOzD9PqK8mOpAp4Kacn_uXRNJNb99tE_1uyEbvgJReF2=w48-h48-c-k-nd',
  ':face-turquoise-drinking-coffee:': 'https://yt3.ggpht.com/myqoI1MgFUXQr5fuWTC9mz0BCfgf3F8GSDp06o1G7w6pTz48lwARjdG8vj0vMxADvbwA1dA=w48-h48-c-k-nd',
  ':body-green-covering-eyes:': 'https://yt3.ggpht.com/UR8ydcU3gz360bzDsprB6d1klFSQyVzgn-Fkgu13dIKPj3iS8OtG1bhBUXPdj9pMwtM00ro=w48-h48-c-k-nd',
  ':goat-turquoise-white-horns:': 'https://yt3.ggpht.com/jMnX4lu5GnjBRgiPtX5FwFmEyKTlWFrr5voz-Auko35oP0t3-zhPxR3PQMYa-7KhDeDtrv4=w48-h48-c-k-nd',
  ':hand-purple-blue-peace:': 'https://yt3.ggpht.com/-sC8wj6pThd7FNdslEoJlG4nB9SIbrJG3CRGh7-bNV0RVfcrJuwiWHoUZ6UmcVs7sQjxTg4=w48-h48-c-k-nd',
  ':face-blue-question-mark:': 'https://yt3.ggpht.com/Wx4PMqTwG3f4gtR7J9Go1s8uozzByGWLSXHzrh3166ixaYRinkH_F05lslfsRUsKRvHXrDk=w48-h48-c-k-nd',
  ':face-blue-covering-eyes:': 'https://yt3.ggpht.com/kj3IgbbR6u-mifDkBNWVcdOXC-ut-tiFbDpBMGVeW79c2c54n5vI-HNYCOC6XZ9Bzgupc10=w48-h48-c-k-nd',
  ':face-purple-smiling-fangs:': 'https://yt3.ggpht.com/k1vqi6xoHakGUfa0XuZYWHOv035807ARP-ZLwFmA-_NxENJMxsisb-kUgkSr96fj5baBOZE=w48-h48-c-k-nd',
  ':face-purple-sweating:': 'https://yt3.ggpht.com/tRnrCQtEKlTM9YLPo0vaxq9mDvlT0mhDld2KI7e_nDRbhta3ULKSoPVHZ1-bNlzQRANmH90=w48-h48-c-k-nd',
  ':face-purple-smiling-tears:': 'https://yt3.ggpht.com/MJV1k3J5s0hcUfuo78Y6MKi-apDY5NVDjO9Q7hL8fU4i0cIBgU-cU4rq4sHessJuvuGpDOjJ=w48-h48-c-k-nd',
  ':face-blue-star-eyes:': 'https://yt3.ggpht.com/m_ANavMhp6cQ1HzX0HCTgp_er_yO2UA28JPbi-0HElQgnQ4_q5RUhgwueTpH-st8L3MyTA=w48-h48-c-k-nd',
  ':face-blue-heart-eyes:': 'https://yt3.ggpht.com/M9tzKd64_r3hvgpTSgca7K3eBlGuyiqdzzhYPp7ullFAHMgeFoNLA0uQ1dGxj3fXgfcHW4w=w48-h48-c-k-nd',
  ':face-blue-three-eyes:': 'https://yt3.ggpht.com/nSQHitVplLe5uZC404dyAwv1f58S3PN-U_799fvFzq-6b3bv-MwENO-Zs1qQI4oEXCbOJg=w48-h48-c-k-nd',
  ':face-blue-droopy-eyes:': 'https://yt3.ggpht.com/hGPqMUCiXGt6zuX4dHy0HRZtQ-vZmOY8FM7NOHrJTta3UEJksBKjOcoE6ZUAW9sz7gIF_nk=w48-h48-c-k-nd',
  ':planet-orange-purple-ring:': 'https://yt3.ggpht.com/xkaLigm3P4_1g4X1JOtkymcC7snuJu_C5YwIFAyQlAXK093X0IUjaSTinMTLKeRZ6280jXg=w48-h48-c-k-nd',
  ':face-turquoise-speaker-shape:': 'https://yt3.ggpht.com/WTFFqm70DuMxSC6ezQ5Zs45GaWD85Xwrd9Sullxt54vErPUKb_o0NJQ4kna5m7rvjbRMgr3A=w48-h48-c-k-nd',
  ':octopus-red-waving:': 'https://yt3.ggpht.com/L9Wo5tLT_lRQX36iZO_fJqLJR4U74J77tJ6Dg-QmPmSC_zhVQ-NodMRc9T0ozwvRXRaT43o=w48-h48-c-k-nd',
  ':pillow-turquoise-hot-chocolate:': 'https://yt3.ggpht.com/cAR4cehRxbn6dPbxKIb-7ShDdWnMxbaBqy2CXzBW4aRL3IqXs3rxG0UdS7IU71OEU7LSd20q=w48-h48-c-k-nd',
  ':hourglass-purple-sand-orange:': 'https://yt3.ggpht.com/MFDLjasPt5cuSM_tK5Fnjaz_k08lKHdX_Mf7JkI6awaHriC3rGL7J_wHxyG6PPhJ8CJ6vsQ=w48-h48-c-k-nd',
  ':fish-orange-wide-eyes:': 'https://yt3.ggpht.com/iQLKgKs7qL3091VHgVgpaezc62uPewy50G_DoI0dMtVGmQEX5pflZrUxWfYGmRfzfUOOgJs=w48-h48-c-k-nd',
  ':popcorn-yellow-striped-smile:': 'https://yt3.ggpht.com/TW_GktV5uVYviPDtkCRCKRDrGlUc3sJ5OHO81uqdMaaHrIQ5-sXXwJfDI3FKPyv4xtGpOlg=w48-h48-c-k-nd',
  ':penguin-blue-waving-tear:': 'https://yt3.ggpht.com/p2u7dcfZau4_bMOMtN7Ma8mjHX_43jOjDwITf4U9adT44I-y-PT7ddwPKkfbW6Wx02BTpNoC=w48-h48-c-k-nd',
  ':clock-turquoise-looking-up:': 'https://yt3.ggpht.com/tDnDkDZykkJTrsWEJPlRF30rmbek2wcDcAIymruOvSLTsUFIZHoAiYTRe9OtO-80lDfFGvo=w48-h48-c-k-nd',
  ':face-red-smiling-live:': 'https://yt3.ggpht.com/14Pb--7rVcqnHvM7UlrYnV9Rm4J-uojX1B1kiXYvv1my-eyu77pIoPR5sH28-eNIFyLaQHs=w48-h48-c-k-nd',
  ':hands-yellow-heart-red:': 'https://yt3.ggpht.com/qWSu2zrgOKLKgt_E-XUP9e30aydT5aF3TnNjvfBL55cTu1clP8Eoh5exN3NDPEVPYmasmoA=w48-h48-c-k-nd',
  ':volcano-green-lava-orange:': 'https://yt3.ggpht.com/_IWOdMxapt6IBY5Cb6LFVkA3J77dGQ7P2fuvYYv1-ahigpVfBvkubOuGLSCyFJ7jvis-X8I=w48-h48-c-k-nd',
  ':person-turquoise-waving-speech:': 'https://yt3.ggpht.com/gafhCE49PH_9q-PuigZaDdU6zOKD6grfwEh1MM7fYVs7smAS_yhYCBipq8gEiW73E0apKTzi=w48-h48-c-k-nd',
  ':face-orange-tv-shape:': 'https://yt3.ggpht.com/EVK0ik6dL5mngojX9I9Juw4iFh053emP0wcUjZH0whC_LabPq-DZxN4Jg-tpMcEVfJ0QpcJ4=w48-h48-c-k-nd',
  ':face-blue-spam-shape:': 'https://yt3.ggpht.com/hpwvR5UgJtf0bGkUf8Rn-jTlD6DYZ8FPOFY7rhZZL-JHj_7OPDr7XUOesilRPxlf-aW42Zg=w48-h48-c-k-nd',
  ':face-fuchsia-flower-shape:': 'https://yt3.ggpht.com/o9kq4LQ0fE_x8yxj29ZeLFZiUFpHpL_k2OivHbjZbttzgQytU49Y8-VRhkOP18jgH1dQNSVz=w48-h48-c-k-nd',
  ':person-blue-holding-pencil:': 'https://yt3.ggpht.com/TKgph5IHIHL-A3fgkrGzmiNXzxJkibB4QWRcf_kcjIofhwcUK_pWGUFC4xPXoimmne3h8eQ=w48-h48-c-k-nd',
  ':body-turquoise-yoga-pose:': 'https://yt3.ggpht.com/GW3otW7CmWpuayb7Ddo0ux5c-OvmPZ2K3vaytJi8bHFjcn-ulT8vcHMNcqVqMp1j2lit2Vw=w48-h48-c-k-nd',
  ':location-yellow-teal-bars:': 'https://yt3.ggpht.com/YgeWJsRspSlAp3BIS5HMmwtpWtMi8DqLg9fH7DwUZaf5kG4yABfE1mObAvjCh0xKX_HoIR23=w48-h48-c-k-nd',
  ':person-turquoise-writing-headphones:': 'https://yt3.ggpht.com/DC4KrwzNkVxLZa2_KbKyjZTUyB9oIvH5JuEWAshsMv9Ctz4lEUVK0yX5PaMsTK3gGS-r9w=w48-h48-c-k-nd',
  ':person-turquoise-wizard-wand:': 'https://yt3.ggpht.com/OiZeNvmELg2PQKbT5UCS0xbmsGbqRBSbaRVSsKnRS9gvJPw7AzPp-3ysVffHFbSMqlWKeQ=w48-h48-c-k-nd',
  ':person-blue-eating-spaghetti:': 'https://yt3.ggpht.com/AXZ8POmCHoxXuBaRxX6-xlT5M-nJZmO1AeUNo0t4o7xxT2Da2oGy347sHpMM8shtUs7Xxh0=w48-h48-c-k-nd',
  ':face-turquoise-music-note:': 'https://yt3.ggpht.com/-K6oRITFKVU8V4FedrqXGkV_vTqUufVCQpBpyLK6w3chF4AS1kzT0JVfJxhtlfIAw5jrNco=w48-h48-c-k-nd',
  ':person-pink-swaying-hair:': 'https://yt3.ggpht.com/L8cwo8hEoVhB1k1TopQaeR7oPTn7Ypn5IOae5NACgQT0E9PNYkmuENzVqS7dk2bYRthNAkQ=w48-h48-c-k-nd',
  ':person-blue-speaking-microphone:': 'https://yt3.ggpht.com/FMaw3drKKGyc6dk3DvtHbkJ1Ki2uD0FLqSIiFDyuChc1lWcA9leahX3mCFMBIWviN2o8eyc=w48-h48-c-k-nd',
  ':rocket-red-countdown-liftoff:': 'https://yt3.ggpht.com/lQZFYAeWe5-SJ_fz6dCAFYz1MjBnEek8DvioGxhlj395UFTSSHqYAmfhJN2i0rz3fDD5DQ=w48-h48-c-k-nd',
  ':face-purple-rain-drops:': 'https://yt3.ggpht.com/woHW5Jl2RD0qxijnl_4vx4ZhP0Zp65D4Ve1DM_HrwJW-Kh6bQZoRjesGnEwjde8F4LynrQ=w48-h48-c-k-nd',
  ':face-pink-drinking-tea:': 'https://yt3.ggpht.com/WRLIgKpnClgYOZyAwnqP-Edrdxu6_N19qa8gsB9P_6snZJYIMu5YBJX8dlM81YG6H307KA=w48-h48-c-k-nd',
  ':person-purple-stage-event:': 'https://yt3.ggpht.com/YeVVscOyRcDJAhKo2bMwMz_B6127_7lojqafTZECTR9NSEunYO5zEi7R7RqxBD7LYLxfNnXe=w48-h48-c-k-nd',
  ':face-purple-open-box:': 'https://yt3.ggpht.com/7lJM2sLrozPtNLagPTcN0xlcStWpAuZEmO2f4Ej5kYgSp3woGdq3tWFrTH30S3mD2PyjlQ=w48-h48-c-k-nd',
  ':person-yellow-podium-blue:': 'https://yt3.ggpht.com/N28nFDm82F8kLPAa-jY_OySFsn3Ezs_2Bl5kdxC8Yxau5abkj_XZHYsS3uYKojs8qy8N-9w=w48-h48-c-k-nd',
  ':baseball-white-cap-out:': 'https://yt3.ggpht.com/8DaGaXfaBN0c-ZsZ-1WqPJ6H9TsJOlUUQQEoXvmdROphZE9vdRtN0867Gb2YZcm2x38E9Q=w48-h48-c-k-nd',
  ':whistle-red-blow:': 'https://yt3.ggpht.com/DBu1ZfPJTnX9S1RyKKdBY-X_CEmj7eF6Uzl71j5jVBz5y4k9JcKnoiFtImAbeu4u8M2X8tU=w48-h48-c-k-nd',
  ':person-turquoise-crowd-surf:': 'https://yt3.ggpht.com/Q0wFvHZ5h54xGSTo-JeGst6InRU3yR6NdBRoyowaqGY66LPzdcrV2t-wBN21kBIdb2TeNA=w48-h48-c-k-nd',
  ':finger-red-number-one:': 'https://yt3.ggpht.com/Hbk0wxBzPTBCDvD_y4qdcHL5_uu7SeOnaT2B7gl9GLB4u8Ecm9OaXCGSMMUBFeNGl5Q3fHJ2=w48-h48-c-k-nd',
  ':text-yellow-goal:': 'https://yt3.ggpht.com/tnHp8rHjXecGbGrWNcs7xss_aVReaYE6H-QWRCXYg_aaYszHXnbP_pVADnibUiimspLvgX0L=w48-h48-c-k-nd',
  ':medal-yellow-first-red:': 'https://yt3.ggpht.com/EEHiiIalCBKuWDPtNOjjvmEZ-KRkf5dlgmhe5rbLn8aZQl-pNz_paq5UjxNhCrI019TWOQ=w48-h48-c-k-nd',
  ':person-blue-wheelchair-race:': 'https://yt3.ggpht.com/ZepxPGk5TwzrKAP9LUkzmKmEkbaF5OttNyybwok6mJENw3p0lxDXkD1X2_rAwGcUM0L-D04=w48-h48-c-k-nd',
  ':card-red-penalty:': 'https://yt3.ggpht.com/uRDUMIeAHnNsaIaShtRkQ6hO0vycbNH_BQT7i3PWetFJb09q88RTjxwzToBy9Cez20D7hA=w48-h48-c-k-nd',
  ':stopwatch-blue-hand-timer:': 'https://yt3.ggpht.com/DCvefDAiskRfACgolTlvV1kMfiZVcG50UrmpnRrg3k0udFWG2Uo9zFMaJrJMSJYwcx6fMgk=w48-h48-c-k-nd',
  ':yt:': 'https://yt3.ggpht.com/IkpeJf1g9Lq0WNjvSa4XFq4LVNZ9IP5FKW8yywXb12djo1OGdJtziejNASITyq4L0itkMNw=w48-h48-c-k-nd',
  ':oops:': 'https://yt3.ggpht.com/PFoVIqIiFRS3aFf5-bt_tTC0WrDm_ylhF4BKKwgqAASNb7hVgx_adFP-XVhFiJLXdRK0EQ=w48-h48-c-k-nd',
  ':buffering:': 'https://yt3.ggpht.com/5gfMEfdqO9CiLwhN9Mq7VI6--T2QFp8AXNNy5Fo7btfY6fRKkThWq35SCZ6SPMVCjg-sUA=w48-h48-c-k-nd',
  ':stayhome:': 'https://yt3.ggpht.com/_1FGHypiub51kuTiNBX1a0H3NyFih3TnHX7bHU06j_ajTzT0OQfMLl9RI1SiQoxtgA2Grg=w48-h48-c-k-nd',
  ':dothefive:': 'https://yt3.ggpht.com/-nM0DOd49969h3GNcl705Ti1fIf1ZG_E3JxcOUVV-qPfCW6jY8xZ98caNLHkVSGRTSEb7Y9y=w48-h48-c-k-nd',
  ':elbowbump:': 'https://yt3.ggpht.com/2ou58X5XuhTrxjtIM2wew1f-HKRhN_T5SILQgHE-WD9dySzzJdGwL4R1gpKiJXcbtq6sjQ=w48-h48-c-k-nd',
  ':goodvibes:': 'https://yt3.ggpht.com/2CvFOwgKpL29mW_C51XvaWa7Eixtv-3tD1XvZa1_WemaDDL2AqevKbTZ1rdV0OWcnOZRag=w48-h48-c-k-nd',
  ':thanksdoc:': 'https://yt3.ggpht.com/bUnO_VwXW2hDf-Da8D64KKv6nBJDYUBuo13RrOg141g2da8pi9-KClJYlUDuqIwyPBfvOO8=w48-h48-c-k-nd',
  ':videocall:': 'https://yt3.ggpht.com/k5v_oxUzRWmTOXP0V6WJver6xdS1lyHMPcMTfxn23Md6rmixoR5RZUusFbZi1uZwjF__pv4=w48-h48-c-k-nd',
  ':virtualhug:': 'https://yt3.ggpht.com/U1TjOZlqtS58NGqQhE8VWDptPSrmJNkrbVRp_8jI4f84QqIGflq2Ibu7YmuOg5MmVYnpevc=w48-h48-c-k-nd',
  ':yougotthis:': 'https://yt3.ggpht.com/s3uOe4lUx3iPIt1h901SlMp_sKCTp3oOVj1JV8izBw_vDVLxFqk5dq-3NX-nK_gnUwVEXld3=w48-h48-c-k-nd',
  ':sanitizer:': 'https://yt3.ggpht.com/EJ_8vc4Gl-WxCWBurHwwWROAHrPzxgePodoNfkRY1U_I8L1O2zlqf7-wfUtTeyzq2qHNnocZ=w48-h48-c-k-nd',
  ':takeout:': 'https://yt3.ggpht.com/FizHI5IYMoNql9XeP7TV3E0ffOaNKTUSXbjtJe90e1OUODJfZbWU37VqBbTh-vpyFHlFIS0=w48-h48-c-k-nd',
  ':hydrate:': 'https://yt3.ggpht.com/tpgZgmhX8snKniye36mnrDVfTnlc44EK92EPeZ0m9M2EPizn1vKEGJzNYdp7KQy6iNZlYDc1=w48-h48-c-k-nd',
  ':chillwcat:': 'https://yt3.ggpht.com/y03dFcPc1B7CO20zgQYzhcRPka5Bhs6iG57MaxJdhaLidFvvXBLf_i4_SHG7zJ_2VpBMNs=w48-h48-c-k-nd',
  ':chillwdog:': 'https://yt3.ggpht.com/Ir9mDxzUi0mbqyYdJ3N9Lq7bN5Xdt0Q7fEYFngN3GYAcJT_tccH1as1PKmInnpt2cbWOam4=w48-h48-c-k-nd',
  ':elbowcough:': 'https://yt3.ggpht.com/DTR9bZd1HOqpRJyz9TKiLb0cqe5Hb84Yi_79A6LWlN1tY-5kXqLDXRmtYVKE9rcqzEghmw=w48-h48-c-k-nd',
  ':learning:': 'https://yt3.ggpht.com/ZuBuz8GAQ6IEcQc7CoJL8IEBTYbXEvzhBeqy1AiytmhuAT0VHjpXEjd-A5GfR4zDin1L53Q=w48-h48-c-k-nd',
  ':washhands:': 'https://yt3.ggpht.com/qXUeUW0KpKBc9Z3AqUqr_0B7HbW1unAv4qmt7-LJGUK_gsFBIaHISWJNt4n3yvmAnQNZHE-u=w48-h48-c-k-nd',
  ':socialdist:': 'https://yt3.ggpht.com/igBNi55-TACUi1xQkqMAor-IEXmt8He56K7pDTG5XoTsbM-rVswNzUfC5iwnfrpunWihrg=w48-h48-c-k-nd',
  ':shelterin:': 'https://yt3.ggpht.com/gjC5x98J4BoVSEPfFJaoLtc4tSBGSEdIlfL2FV4iJG9uGNykDP9oJC_QxAuBTJy6dakPxVeC=w48-h48-c-k-nd',
};

function escapeHtmlYT(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseYouTubeEmoji(text) {
  // Replace known YouTube emoji shortcodes with actual images
  return text.replace(/:[a-z0-9-]+:/g, (match) => {
    const url = YOUTUBE_EMOJI_URLS[match];
    if (url) {
      const alt = match.replace(/:/g, '');
      return `<img src="${url}" style="height:1.4em;vertical-align:middle;display:inline-block;" alt="${alt}">`;
    }
    return match; // unknown shortcode, leave as-is
  });
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
const YOUTUBE_RECONNECT_DELAY  = 10 * 1000;       // 10s between reconnect attempts
const YOUTUBE_RECONNECT_TIMEOUT = 8 * 60 * 1000;  // give up after 8min of failed reconnects

let youtubeAccessToken  = config.youtube.accessToken;
let youtubeRefreshToken = config.youtube.refreshToken;

// Returns auth header — OAuth bearer if available, else API key param
function youtubeAuthHeader() {
  if (youtubeAccessToken) return { header: { 'Authorization': `Bearer ${youtubeAccessToken}` }, param: '' };
  if (config.youtube.apiKey) return { header: {}, param: `&key=${config.youtube.apiKey}` };
  return null;
}

async function refreshYoutubeToken() {
  if (!youtubeRefreshToken || !config.youtube.clientId || !config.youtube.clientSecret) return false;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     config.youtube.clientId,
        client_secret: config.youtube.clientSecret,
        refresh_token: youtubeRefreshToken,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      youtubeAccessToken = data.access_token;
      console.log('[YouTube] Token refreshed');
      return true;
    }
    console.error('[YouTube] Token refresh failed:', data.error);
    return false;
  } catch (err) {
    console.error('[YouTube] Token refresh error:', err.message);
    return false;
  }
}

function getYoutubeRedirectUri(host) {
  // Desktop app OAuth credentials use http://localhost — user pastes the redirect URL manually
  return process.env.YOUTUBE_REDIRECT_URL || 'http://localhost:3030/youtube/callback';
}

let youtubeActive          = false;
let youtubePollTimer       = null;
let youtubeReconnectTimer  = null; // tracks how long we've been trying to reconnect
let youtubeLiveChatId      = null;
let youtubeCachedVideoId   = null; // cached after first search — reused on reconnect
let youtubeNextToken       = null;
const youtubeSeenIds       = new Set();

function youtubeReset(reason) {
  console.log(`[YouTube] Reset: ${reason} — waiting for Streamer.bot to re-trigger`);
  broadcastStatus('youtube', 'disconnected', '');
  youtubeActive        = false;
  youtubeLiveChatId    = null;
  youtubeCachedVideoId = null; // clear cache so next start does a fresh search
  youtubeNextToken     = null;
  if (youtubePollTimer)      { clearTimeout(youtubePollTimer);      youtubePollTimer      = null; }
  if (youtubeReconnectTimer) { clearTimeout(youtubeReconnectTimer); youtubeReconnectTimer = null; }
}

function youtubeStartReconnectTimeout() {
  // Start the 15-min countdown only when we lose connection (not on initial connect)
  if (youtubeReconnectTimer) return; // already counting down
  console.log('[YouTube] Lost connection — will keep retrying for 8 minutes...');
  youtubeReconnectTimer = setTimeout(() => {
    console.log('[YouTube] 8-minute reconnect timeout reached — giving up. Re-trigger via Streamer.bot.');
    broadcastStatus('youtube', 'disconnected', 'Timed out — waiting for stream trigger');
    youtubeReset('15-minute reconnect timeout');
  }, YOUTUBE_RECONNECT_TIMEOUT);
}

function youtubeClearReconnectTimeout() {
  // Cancel the countdown once we successfully reconnect
  if (youtubeReconnectTimer) {
    clearTimeout(youtubeReconnectTimer);
    youtubeReconnectTimer = null;
    console.log('[YouTube] Reconnected successfully');
    broadcastStatus('youtube', 'connected', '');
  }
}

async function youtubeGetLiveChatId() {
  const auth = youtubeAuthHeader();
  if (!auth) { console.error('[YouTube] No API key or OAuth token configured'); return null; }

  // Use explicit video ID, or cached one from a previous search this session
  const videoId = config.youtube.videoId || youtubeCachedVideoId;
  if (videoId) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}${auth.param}`;
    const res  = await fetch(url, { headers: auth.header });
    const data = await res.json();
    if (data.error?.code === 401) { await refreshYoutubeToken(); return youtubeGetLiveChatId(); }
    return data.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
  }

  // No video ID — search for active stream (costs 100 quota units, only done once per session)
  console.log('[YouTube] Searching for active live stream (1 quota search)...');
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${config.youtube.channelId}&eventType=live&type=video${auth.param}`;
  const res  = await fetch(url, { headers: auth.header });
  const data = await res.json();
  if (data.error) { console.error('[YouTube] Search API error:', data.error.message); return null; }
  const foundId = data.items?.[0]?.id?.videoId;
  if (!foundId) return null;
  youtubeCachedVideoId = foundId; // cache it — won't search again this session
  console.log('[YouTube] Found live stream:', foundId, '(cached for this session)');
  const vRes  = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${foundId}${auth.param}`, { headers: auth.header });
  const vData = await vRes.json();
  return vData.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
}

async function youtubePoll() {
  youtubePollTimer = null;
  if (!youtubeActive) return;
  try {
    if (!youtubeLiveChatId) {
      youtubeLiveChatId = await youtubeGetLiveChatId();
      if (!youtubeLiveChatId) {
        console.log('[YouTube] No active live stream found, retrying in 30s...');
        youtubeStartReconnectTimeout(); // start 15min countdown
        youtubePollTimer = setTimeout(youtubePoll, 30000);
        return;
      }
      youtubeClearReconnectTimeout(); // connected — cancel any countdown
      console.log('[YouTube] Connected to live chat:', youtubeLiveChatId);
      broadcastStatus('youtube', 'connected', '');
    }

    const auth = youtubeAuthHeader();
    if (!auth) { console.error('[YouTube] No auth available'); youtubePollTimer = setTimeout(youtubePoll, 60000); return; }
    let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${youtubeLiveChatId}&part=snippet,authorDetails,id${auth.param}`;
    if (youtubeNextToken) url += `&pageToken=${youtubeNextToken}`;

    const res  = await fetch(url, { headers: auth.header });
    const data = await res.json();

    if (data.error) {
      const code = data.error.code;
      const msg  = data.error.message || '';
      console.error('[YouTube] API Error:', msg);

      if (code === 401) {
        console.log('[YouTube] Token expired, refreshing...');
        const refreshed = await refreshYoutubeToken();
        if (refreshed) { youtubePollTimer = setTimeout(youtubePoll, 1000); return; }
        console.error('[YouTube] Could not refresh token — visit /youtube/auth to re-authorize');
        youtubeReset('auth failed');
        return;
      }
      if (msg.includes('quota')) {
        console.log('[YouTube] Quota exceeded — resetting. Re-trigger when ready.');
        youtubeReset('quota exceeded');
        return;
      }
      if (code === 403 || code === 404) {
        console.log('[YouTube] Chat unavailable, attempting reconnect in 10s...');
        youtubeLiveChatId = null; // clear chat ID but keep cachedVideoId
        youtubeNextToken  = null;
        youtubeStartReconnectTimeout(); // start/continue 15min countdown
        youtubePollTimer  = setTimeout(youtubePoll, YOUTUBE_RECONNECT_DELAY);
        return;
      }
      youtubeStartReconnectTimeout();
      youtubePollTimer = setTimeout(youtubePoll, YOUTUBE_RECONNECT_DELAY);
      return;
    }

    youtubeNextToken = data.nextPageToken;
    for (const item of (data.items || [])) {
      if (youtubeSeenIds.has(item.id)) continue;
      youtubeSeenIds.add(item.id);
      if (youtubeSeenIds.size > 500) { const first = youtubeSeenIds.values().next().value; youtubeSeenIds.delete(first); }
      const author = item.authorDetails;
      // Use structured messageText runs to get actual emoji image URLs
      const runs = item.snippet?.textMessageDetails?.messageText?.runs
                || item.snippet?.superChatDetails?.userComment?.runs
                || null;
      let text = '';
      if (runs) {
        text = runs.map(run => {
          if (run.text) return escapeHtmlYT(run.text);
          if (run.emoji) {
            console.log('[YouTube] emoji object:', JSON.stringify(run.emoji).substring(0, 500));
            // Prefer highest-res thumbnail
            const img = run.emoji.image?.thumbnails?.slice(-1)[0]?.url
                     || run.emoji.image?.thumbnails?.[0]?.url;
            const label = run.emoji.shortcuts?.[0] || run.emoji.emojiId || '';
            const altText = label.replace(/:/g, '');
            if (img) {
              return `<img src="${img}" style="height:1.4em;vertical-align:middle;display:inline-block;" alt="${altText}">`;
            }
            if (label) return parseYouTubeEmoji(label);
            return '';
          }
          return '';
        }).join('');
      } else {
        console.log('[YouTube] no runs, snippet:', JSON.stringify(item.snippet).substring(0, 400));
        // No runs = API key mode, fall back to shortcode parsing
        text = parseYouTubeEmoji(escapeHtmlYT(item.snippet?.displayMessage || ''));
      }
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
    if (youtubeActive) {
      youtubeStartReconnectTimeout();
      youtubePollTimer = setTimeout(youtubePoll, YOUTUBE_RECONNECT_DELAY);
    }
  }
}

function connectYoutube(manual = false) {
  if (!config.youtube.enabled) return console.log('[YouTube] Disabled - missing env vars');
  if (youtubeActive) {
    console.log('[YouTube] Already active — resetting first');
    youtubeReset('re-triggered');
  }
  const authMode = youtubeAccessToken ? 'OAuth ✓' : (config.youtube.apiKey ? 'API key (no emoji images)' : 'NO AUTH');
  console.log(`[YouTube] ${manual ? 'Manual trigger' : 'Auto-start'} — connecting... [auth: ${authMode}]`);
  youtubeActive = true;
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

// ─── YouTube OAuth routes ────────────────────────────────────────────────────
app.get('/youtube/auth', (req, res) => {
  if (!config.youtube.clientId) return res.send('<h2>❌ YOUTUBE_CLIENT_ID not set in env</h2>');
  const redirectUri = getYoutubeRedirectUri(req.headers.host);
  const params = new URLSearchParams({
    client_id:     config.youtube.clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/youtube.readonly',
    access_type:   'offline',
    prompt:        'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code received');
  await exchangeYoutubeCode(code, getYoutubeRedirectUri(req.headers.host), res);
});

app.get('/youtube/manual', (req, res) => {
  const redirectUri = getYoutubeRedirectUri(req.headers.host);
  const authUrl = new URLSearchParams({
    client_id:     config.youtube.clientId || 'YOUR_CLIENT_ID',
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/youtube.readonly',
    access_type:   'offline',
    prompt:        'consent',
  });
  res.send(`
    <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;background:#111;color:#eee;}
    a{color:#FF0000;} pre{background:#1a1a1a;padding:12px;border-radius:6px;overflow-x:auto;}
    input{width:100%;padding:8px;margin:8px 0;background:#222;color:#eee;border:1px solid #444;border-radius:4px;}
    button{padding:10px 20px;background:#FF0000;color:white;border:none;border-radius:4px;cursor:pointer;}</style>
    <h2>🔴 YouTube OAuth Setup</h2>
    <ol>
      <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a>, create an <strong>OAuth 2.0 Client ID</strong> (type: <strong>Desktop app</strong>)</li>
      <li>Set <code>YOUTUBE_CLIENT_ID</code>, <code>YOUTUBE_CLIENT_SECRET</code>, and <code>YOUTUBE_REDIRECT_URL=http://localhost:3030/youtube/callback</code> in Dockge and restart</li>
      <li>On your PC, <a href="/youtube/auth">click here to start the Google auth flow</a></li>
      <li>Google will redirect your browser to <code>http://localhost:3030/youtube/callback?code=...</code> — that page won't load, copy the full URL from your address bar and paste below</li>
    </ol>
    <input type="text" id="url" placeholder="${redirectUri}?code=4/0ABC..." />
    <button onclick="submitUrl()">Submit</button>
    <div id="result"></div>
    <script>
    async function submitUrl() {
      const url = document.getElementById('url').value.trim();
      const code = new URL(url).searchParams.get('code');
      if (!code) { document.getElementById('result').innerHTML = '❌ No code found in URL'; return; }
      const res = await fetch('/youtube/exchange?code=' + encodeURIComponent(code));
      const text = await res.text();
      document.getElementById('result').innerHTML = text;
    }
    </script>
  `);
});

app.get('/youtube/exchange', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code');
  await exchangeYoutubeCode(code, getYoutubeRedirectUri(req.headers.host), res);
});

async function exchangeYoutubeCode(code, redirectUri, res) {
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     config.youtube.clientId,
        client_secret: config.youtube.clientSecret,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  redirectUri,
      }),
    });
    const data = await tokenRes.json();
    if (data.access_token) {
      youtubeAccessToken  = data.access_token;
      youtubeRefreshToken = data.refresh_token || youtubeRefreshToken;
      res.send(`
        <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;background:#111;color:#eee;}
        pre{background:#1a1a1a;padding:12px;border-radius:6px;overflow-x:auto;}</style>
        <h2>✅ YouTube Authorized!</h2>
        <p>Add these to your docker-compose.yml and restart:</p>
        <pre>
YOUTUBE_ACCESS_TOKEN=${data.access_token}
YOUTUBE_REFRESH_TOKEN=${data.refresh_token || '(not returned — keep existing)'}
        </pre>
        <p>You can now remove <code>YOUTUBE_API_KEY</code> if you wish — OAuth gives better emoji support.</p>
      `);
    } else {
      res.send('<h2>❌ Authorization failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
  } catch (err) {
    res.send('Error: ' + err.message);
  }
}

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
  console.log(`   YouTube auth:    http://localhost:${PORT}/youtube/manual`);
  console.log(`   Joystick auth:   http://localhost:${PORT}/joystick/auth\n`);

  connectTwitch();
  if (!process.env.YOUTUBE_STREAMERBOT_TRIGGER) connectYoutube(); // skip auto-start if Streamer.bot trigger mode enabled
  connectKick();
  connectJoystick();
});
