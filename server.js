/* DvT Cloud Bridge — deploy to Render.com free tier for 24/7 round collection */
const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');

const GAME_HOST = '13.200.156.117';
const GAME_PORT = 9999;
const WORKER_URL = 'https://dvt-watcher.sahib3636.workers.dev';
const ADMIN_KEY = 'dvt-refresh-9f27';

// Load handshake frames
let frames = [];
try {
  const framesPath = path.join(__dirname, 'frames.json');
  if (fs.existsSync(framesPath)) {
    const data = JSON.parse(fs.readFileSync(framesPath, 'utf8'));
    frames = (data.frames || []).map(hex => Buffer.from(hex, 'hex'));
  }
} catch(e) { console.error('Failed to load frames:', e.message); }

// Rank table
const RANK = {0x34:2,0x5f:3,0x30:4,0x1e:5,0xfe:6,0x35:7,0x2f:8,0x0e:9,0xdb:10,0x6f:11,0xc4:12,0x5c:13,0xdc:14};
const RNAME = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};

let lastRounds = [];
let connected = false;
let reconnectTimer = null;
let reconnectDelay = 10000; // Start with 10s
const MAX_RECONNECT_DELAY = 300000; // Max 5 minutes
let lastRoundTime = 0;
let lastHeartbeat = 0;
let connectionStartTime = 0;
let totalRoundsCollected = 0;

function xorDecode(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x70;
  return out;
}

function parseRounds(payload) {
  if (payload.length < 44) return [];
  const pairs = payload.slice(4, 44);
  const rounds = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const dr = RANK[pairs[i]], tr = RANK[pairs[i+1]];
    if (dr && tr) {
      const winner = dr === tr ? '=' : dr > tr ? 'D' : 'T';
      rounds.push({ winner, dragon: RNAME[dr], tiger: RNAME[tr], ts: Date.now() });
    }
  }
  return rounds;
}

function pushToWorker(rounds) {
  if (!rounds.length) return;
  const body = JSON.stringify({ rounds });
  const url = new URL(WORKER_URL + '/ingest');
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(options, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('[Push]', res.statusCode, data.slice(0, 80));
      // Reset reconnect delay on successful push
      reconnectDelay = 10000;
    });
  });
  req.on('error', e => {
    console.error('[Push Error]', e.message);
    // Don't reset reconnect delay on push error
  });
  req.write(body);
  req.end();
}

function connect() {
  if (connected) return;
  console.log('[Bridge] Connecting to game server...');
  connectionStartTime = Date.now();
  
  const sock = net.createConnection(GAME_PORT, GAME_HOST, () => {
    connected = true;
    console.log('[Bridge] Connected! Sending handshake...');
    for (let i = 0; i < Math.min(5, frames.length); i++) {
      sock.write(frames[i]);
    }
    // Reset reconnect delay on successful connection
    reconnectDelay = 10000;
  });
  
  // FIX 1: Increase timeout to 5 minutes (was 2 minutes)
  sock.setTimeout(300000);
  
  let buffer = Buffer.alloc(0);
  let lastDataTime = Date.now();
  
  sock.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    lastDataTime = Date.now();
    lastHeartbeat = Date.now();
    
    while (buffer.length >= 4) {
      const frameLen = buffer[2] | (buffer[3] << 8);
      if (frameLen < 4 || frameLen > 65535 || buffer.length < frameLen) break;
      const frame = buffer.slice(0, frameLen);
      buffer = buffer.slice(frameLen);
      
      try {
        const decoded = xorDecode(frame.slice(4));
        if (decoded.length >= 4) {
          const main = decoded[0] | (decoded[1] << 8);
          const sub = decoded[2] | (decoded[3] << 8);
          if (main === 0x3c && sub === 0x09 && decoded.length >= 44) {
            const rounds = parseRounds(decoded);
            if (rounds.length) {
              // Deduplicate
              const newRounds = rounds.filter(r => {
                const key = r.ts + '|' + r.winner;
                if (lastRounds.includes(key)) return false;
                lastRounds.push(key);
                return true;
              });
              if (lastRounds.length > 500) lastRounds = lastRounds.slice(-500);
              if (newRounds.length) {
                console.log('[Bridge] Got', newRounds.length, 'new rounds');
                lastRoundTime = Date.now();
                totalRoundsCollected += newRounds.length;
                pushToWorker(newRounds);
              }
            }
          }
        }
      } catch(e) {}
    }
  });
  
  // FIX 2: Better timeout handling
  sock.on('timeout', () => {
    const silence = Date.now() - lastDataTime;
    console.log('[Bridge] Timeout after', Math.round(silence/1000), 'seconds of silence');
    sock.destroy();
  });
  
  sock.on('error', e => {
    console.error('[Bridge Error]', e.message);
    connected = false;
  });
  
  sock.on('close', () => {
    connected = false;
    const uptime = Math.round((Date.now() - connectionStartTime) / 1000);
    console.log('[Bridge] Disconnected after', uptime, 'seconds. Rounds collected:', totalRoundsCollected);
    
    // FIX 3: Exponential backoff
    clearTimeout(reconnectTimer);
    console.log('[Bridge] Reconnecting in', Math.round(reconnectDelay/1000), 'seconds...');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    
    // Increase delay for next attempt (exponential backoff)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });
  
  // FIX 4: Heartbeat every 15 seconds (was 10s)
  const hb = setInterval(() => {
    if (!connected) { clearInterval(hb); return; }
    try {
      // Send heartbeat frame
      sock.write(frames[4] || Buffer.alloc(12));
      lastHeartbeat = Date.now();
    } catch(e) { clearInterval(hb); }
  }, 15000);
  
  // FIX 5: Connection health monitor
  const healthCheck = setInterval(() => {
    if (!connected) { clearInterval(healthCheck); return; }
    
    const silence = Date.now() - lastDataTime;
    const uptime = Date.now() - connectionStartTime;
    
    // Log status every 5 minutes
    if (uptime % 300000 < 1000) {
      console.log('[Bridge] Status: uptime=', Math.round(uptime/60), 'min, silence=', Math.round(silence/1000), 's, rounds=', totalRoundsCollected);
    }
    
    // If no data for 4 minutes, force reconnect
    if (silence > 240000) {
      console.log('[Bridge] No data for 4 minutes, forcing reconnect...');
      sock.destroy();
    }
  }, 60000); // Check every minute
}

// FIX 6: Periodic handshake refresh (every 30 minutes)
setInterval(() => {
  if (connected) {
    console.log('[Bridge] Refreshing handshake...');
    // Re-send handshake frames
    for (let i = 0; i < Math.min(3, frames.length); i++) {
      try {
        // We need access to the socket, so we'll store it
        if (global.bridgeSocket) {
          global.bridgeSocket.write(frames[i]);
        }
      } catch(e) {}
    }
  }
}, 1800000); // 30 minutes

// Start
connect();

// Keep-alive HTTP endpoint for Render.com
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const status = {
    status: connected ? 'connected' : 'disconnected',
    rounds: totalRoundsCollected,
    lastRound: lastRoundTime ? new Date(lastRoundTime).toISOString() : null,
    uptime: connectionStartTime ? Math.round((Date.now() - connectionStartTime) / 1000) : 0,
    reconnectDelay: Math.round(reconnectDelay / 1000)
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
}).listen(PORT, '0.0.0.0', () => console.log('[Bridge] Health on port', PORT));
