/* DvT Predictor — simple edition: log results → get next-round odds */
(function () {
  'use strict';
  const E = window.DVTE;
  const $ = (s) => document.querySelector(s);
  const RANKS = (E && E.RANK_NAMES) || ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c];
    });
  }
  function cleanRank(x) {
    if (x == null || x === '') return null;
    const u = String(x).trim().toUpperCase();
    return RANKS.indexOf(u) >= 0 ? u : null;
  }

  /* ---------- storage ---------- */
  const PERSIST = (() => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch (e) { return false; } })();
  let rounds = [];
  (function () {
    if (!PERSIST) return;
    try {
      // PHASE 3: New storage key — old data had 500 fake rounds, start fresh
      var stored = localStorage.getItem('dvt.rounds.v2');
      if (!stored) {
        // Migrate: only keep rounds with src='live' (real data)
        var old = JSON.parse(localStorage.getItem('dvt.rounds') || '[]');
        var liveOnly = (old || []).filter(function(r) { return r && r.src === 'live' && 'DTX'.includes(r.o) && (+r.ts > 1600000000); });
        if (liveOnly.length > 0) {
          localStorage.setItem('dvt.rounds.v2', JSON.stringify(liveOnly));
          stored = JSON.stringify(liveOnly);
        } else {
          localStorage.setItem('dvt.rounds.v2', '[]');
          stored = '[]';
        }
        // Clean up old key
        try { localStorage.removeItem('dvt.rounds'); } catch(e) {}
      }
      rounds = (JSON.parse(stored) || [])
        .filter(r => r && 'DTX'.includes(r.o) && (+r.ts > 1600000000))
        .map(r => ({ ...r, ts: +r.ts > 1e12 ? +r.ts / 1000 : +r.ts }));
    } catch (e) { rounds = []; }
  })();
  const save = () => { if (PERSIST) { try { localStorage.setItem('dvt.rounds.v2', JSON.stringify(rounds)); } catch (e) { } } };
  let playWin = [];
  let playHits = [];
  let playMark = [];
  try { localStorage.removeItem('dvt.play7'); } catch (e) { }

  /* ========== FLAGSHIP: Auto-fill playWin from live rounds ========== */
  let _autoDesk = true;
  function autoFillDesk() {
    if (!_autoDesk) return;
    const live = rounds.filter(function(r) { return r.src === 'live'; });
    if (live.length < 7) return;
    const last7live = live.slice(-7);
    const incoming = last7live.map(function(r) { return r.o; });
    const cur = last7().map(function(o) { return o; });
    if (JSON.stringify(cur) === JSON.stringify(incoming)) return;
    playWin = incoming;
    playHits = incoming.map(function() { return null; });
    playMark = incoming.map(function() { return 0; });
    // Backfill hit/miss scores for historical rounds
    try {
      for (var i = 2; i < playWin.length; i++) {
        var prevWin = playWin.slice(0, i);
        var prevHist = prevWin.map(function(o) { return { o: o }; });
        if (prevHist.length >= 3) {
          try {
            var C = engineCall(prevHist);
            if (C && (C.pick === 'D' || C.pick === 'T')) {
              playHits[i] = (C.pick === playWin[i]);
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
    try { paintPlay7(); } catch(e) {}
  }

  /* ========== FLAGSHIP: Card Counting (8-deck shoe) ========== */
  const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
  const CardCount = {
    dealt: {},
    totalDealt: function() { let c=0; for(const k in this.dealt) c+=this.dealt[k]; return c; },
    remainingTotal: function() { return 416 - this.totalDealt(); },
    remainingOfRank: function(rank) {
      let d=0; for(const k in this.dealt) { if(parseInt(k)===rank) d+=this.dealt[k]; }
      return 32 - d;
    },
    registerCard: function(rank, suit) { const k=rank+'_'+suit; this.dealt[k]=(this.dealt[k]||0)+1; },
    registerRound: function(dr, ds, tr, ts2) {
      if(dr>0&&ds>=0) this.registerCard(dr,ds);
      if(tr>0&&ts2>=0) this.registerCard(tr,ts2);
    },
    penetration: function() { return Math.round((this.totalDealt()/416)*100); },
    highRem: function() { let c=0; for(let r=10;r<=14;r++) c+=this.remainingOfRank(r); return c; },
    lowRem: function() { let c=0; for(let r=2;r<=6;r++) c+=this.remainingOfRank(r); return c; },
    neutralRem: function() { let c=0; for(let r=7;r<=9;r++) c+=this.remainingOfRank(r); return c; },
    trueCount: function() {
      if(this.totalDealt()<10) return 0;
      let hD=0,lD=0;
      for(const k in this.dealt) { const r=parseInt(k); if(r>=10) hD+=this.dealt[k]; if(r<=6) lD+=this.dealt[k]; }
      const rc=hD-lD;
      const decks=this.remainingTotal()/52;
      return decks<0.5?0:Math.round((rc/decks)*10)/10;
    },
    shoeBias: function() { const tc=this.trueCount(); return Math.abs(tc)<1?'Neutral':tc>0?'High-heavy':'Low-heavy'; },
    reset: function() { this.dealt={}; },
    rebuildFromRounds: function() {
      this.dealt={};
      for(const r of rounds) {
        if(r.d && r.d!=='' && RANK_VAL[r.d] && r.t && r.t!=='' && RANK_VAL[r.t]) {
          const dv=RANK_VAL[r.d], tv=RANK_VAL[r.t];
          if(dv>=2&&dv<=14) this.registerCard(dv, 0);
          if(tv>=2&&tv<=14) this.registerCard(tv, 0);
        }
      }
    }
  };
  // Rebuild card count from existing rounds on startup
  CardCount.rebuildFromRounds();

  /* ========== FLAGSHIP: Bet Timing ========== */
  const BetTimer = {
    lastRoundTime: 0,
    avgInterval: 25000,
    intervals: [],
    registerRound: function() {
      const now = Date.now();
      if (this.lastRoundTime > 0) {
        const dt = now - this.lastRoundTime;
        if (dt > 5000 && dt < 120000) {
          this.intervals.push(dt);
          if (this.intervals.length > 20) this.intervals.shift();
          this.avgInterval = this.intervals.reduce(function(a,b){return a+b;},0) / this.intervals.length;
        }
      }
      this.lastRoundTime = now;
    },
    timeUntilNext: function() {
      if (!this.lastRoundTime) return null;
      return Math.max(0, this.avgInterval - (Date.now() - this.lastRoundTime));
    },
    bettingWindow: function() {
      const rem = this.timeUntilNext();
      if (rem===null) return 'WAITING';
      if (rem<8000) return 'BET NOW!';
      if (rem<15000) return 'SOON';
      return 'WAITING';
    }
  };

  // Initialize BetTimer from existing rounds
  (function() {
    var liveRounds = rounds.filter(function(r) { return r.src === 'live'; });
    if (liveRounds.length >= 2) {
      var last = liveRounds[liveRounds.length - 1];
      var prev = liveRounds[liveRounds.length - 2];
      if (last.ts && prev.ts) {
        BetTimer.lastRoundTime = last.ts * 1000;
        var dt = (last.ts - prev.ts) * 1000;
        if (dt > 5000 && dt < 120000) {
          BetTimer.intervals.push(dt);
          BetTimer.avgInterval = dt;
        }
      }
    }
  })();

  /* ========== FLAGSHIP: Sound Alerts ========== */
  const SoundAlerts = {
    ctx: null,
    on: true,
    init: function() { try { this.ctx=new(window.AudioContext||window.webkitAudioContext)(); } catch(e){} },
    beep: function(freq, dur, vol) {
      if(!this.on||!this.ctx)return;
      try {
        const o=this.ctx.createOscillator(),g=this.ctx.createGain();
        o.connect(g);g.connect(this.ctx.destination);
        o.frequency.value=freq||800;o.type='sine';g.gain.value=vol||0.3;
        g.gain.exponentialRampToValueAtTime(0.01,this.ctx.currentTime+(dur||0.15));
        o.start();o.stop(this.ctx.currentTime+(dur||0.15));
      } catch(e){}
    },
    roundBeep: function() { this.beep(600,0.1,0.2); },
    strongBeep: function() { this.beep(800,0.15,0.4); setTimeout(function(){SoundAlerts.beep(1000,0.2,0.4);},150); },
    betWindowBeep: function() { this.beep(1000,0.3,0.5); }
  };
  SoundAlerts.init();

  /* ========== FLAGSHIP: Session Recording ========== */
  const Session = {
    start: Date.now(),
    rounds: [],
    predictions: [],
    recordRound: function(r) { this.rounds.push({ts:Date.now(),o:r.o,d:r.d,t:r.t}); },
    recordPrediction: function(p) { this.predictions.push({ts:Date.now(),pick:p.pick,conf:p.conf}); },
    accuracy: function() {
      const scored=this.predictions.filter(function(p){return p.hit!==undefined;});
      if(!scored.length) return 0;
      return Math.round(scored.filter(function(p){return p.hit;}).length/scored.length*100);
    },
    summary: function() {
      return {
        dur: Math.round((Date.now()-this.start)/60000)+'min',
        rounds: this.rounds.length,
        preds: this.predictions.length,
        acc: this.accuracy()+'%'
      };
    }
  };

  /* ========== PHASE 2: Confidence Gauge ========== */
  function confidenceGauge(conf) {
    const R = 40, CX = 50, CY = 50;
    const arc = function(frac) {
      var a = Math.PI * (1 - frac);
      return (CX + R * Math.cos(a)).toFixed(2) + ' ' + (CY - R * Math.sin(a)).toFixed(2);
    };
    var frac = Math.max(0, Math.min(1, conf / 100));
    var a = Math.PI * (1 - frac);
    var color = conf >= 62 ? '#6dbc61' : conf >= 45 ? '#e3af50' : '#e06060';
    return '<svg width="100" height="58" viewBox="0 0 100 58">' +
      '<path d="M ' + arc(0) + ' A ' + R + ' ' + R + ' 0 0 1 ' + arc(1) + '" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M ' + arc(0) + ' A ' + R + ' ' + R + ' 0 0 1 ' + arc(Math.max(frac, .03)) + '" fill="none" stroke="' + color + '" stroke-width="8" stroke-linecap="round"/>' +
      '<line x1="' + CX + '" y1="' + CY + '" x2="' + (CX + (R - 7) * Math.cos(a)).toFixed(1) + '" y2="' + (CY - (R - 7) * Math.sin(a)).toFixed(1) + '" stroke="#f0f3f9" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="' + CX + '" cy="' + CY + '" r="3" fill="#f0f3f9"/>' +
      '<text x="' + CX + '" y="' + (CY - 12) + '" text-anchor="middle" font-size="18" font-weight="800" fill="#f0f3f9">' + conf + '</text>' +
      '</svg>';
  }

  /* ========== PHASE 2: Hot/Cold Streak Indicator ========== */
  function getStreakInfo() {
    var dec = rounds.filter(function(r) { return r.o !== 'X'; }).map(function(r) { return r.o; });
    if (!dec.length) return { side: null, len: 0, hot: false };
    var side = dec[dec.length - 1];
    var len = 0;
    for (var i = dec.length - 1; i >= 0; i--) {
      if (dec[i] === side) len++; else break;
    }
    return { side: side, len: len, hot: len >= 3 };
  }

  /* ========== PHASE 2: Recent D/T Ratio Bar ========== */
  function getRecentRatio(n) {
    n = n || 20;
    var slice = rounds.slice(-n);
    var d = 0, t = 0, x = 0;
    slice.forEach(function(r) { if (r.o === 'D') d++; else if (r.o === 'T') t++; else x++; });
    return { d: d, t: t, x: x, n: slice.length, dPct: slice.length ? Math.round(d/slice.length*100) : 0, tPct: slice.length ? Math.round(t/slice.length*100) : 0 };
  }

  /* ========== PHASE 2: Sound Toggle ========== */
  function toggleSound() {
    SoundAlerts.on = !SoundAlerts.on;
    var btn = document.getElementById('soundToggle') || document.getElementById('soundToggleBtn');
    if (btn) btn.textContent = SoundAlerts.on ? 'ON' : 'OFF';
    toast(SoundAlerts.on ? 'Sound ON' : 'Sound OFF');
  }

  /* ========== PHASE 3: Multi-Table ========== */
  var currentTable = 'auto';
  function selectTable(btn) {
    document.querySelectorAll('.tbl-btn').forEach(function(b) { b.classList.remove('on'); });
    btn.classList.add('on');
    currentTable = btn.dataset.tbl;
    toast('Table: ' + currentTable.toUpperCase());
    // Tag future rounds with table info
    if (PERSIST) { try { localStorage.setItem('dvt.table', currentTable); } catch(e) {} }
  }
  // Export to window so HTML onclick handlers work
  window.selectTable = selectTable;
  // Restore table selection
  (function() {
    if (!PERSIST) return;
    try {
      var saved = localStorage.getItem('dvt.table');
      if (saved) {
        currentTable = saved;
        var btn = document.querySelector('.tbl-btn[data-tbl="' + saved + '"]');
        if (btn) {
          document.querySelectorAll('.tbl-btn').forEach(function(b) { b.classList.remove('on'); });
          btn.classList.add('on');
        }
      }
    } catch(e) {}
  })();
  function savePlay() { /* session-only desk — a refresh wipes the 7 */ }
  function last7() { return playWin.slice(-7); }
  function last7Filtered() {
    if (!currentTable || currentTable === 'auto') return last7();
    // Filter rounds by table tag - show all for auto, filter for specific
    const tblRounds = rounds.filter(function(r) { return r.tbl === currentTable; }).slice(-7);
    if (tblRounds.length >= 3) return tblRounds.map(function(r) { return r.o; });
    return last7(); // Fallback to all rounds if not enough for this table
  }
  function deskHist() { return last7().map(function (o) { return { o: o }; }); }
  function paintPlay7() {
    const el = $('#play7'), need = $('#need7');
    if (!el) return;
    const n = playWin.length;
    const show = last7();
    const hits = playHits.slice(-7);
    el.innerHTML = Array.from({ length: 7 }, (_, i) => {
      const o = show[i];
      if (!o) return '<div class="p7' + (i === n ? ' next' : '') + '">' + (i + 1) + '</div>';
      const h = hits[i];
      let dot = '';
      if (h === true) dot = '<i class="p7dot hit"></i>';
      else if (h === false) dot = '<i class="p7dot miss"></i>';
      else if (o === 'X') dot = '<i class="p7dot tie"></i>';
      return '<div class="p7 on ' + o + '">' + (o === 'X' ? '=' : o) + dot + '</div>';
    }).join('');
    let nD = 0, nT = 0, nX = 0;
    for (let i = 0; i < show.length; i++) {
      if (show[i] === 'D') nD++; else if (show[i] === 'T') nT++; else if (show[i] === 'X') nX++;
    }
    if (need) {
      if (n < 7) { need.textContent = 'NEED ' + (7 - n) + ' MORE'; need.className = 'need7'; }
      else { need.textContent = ''; need.className = 'need7 ready'; }
    }
    const seed = $('#qSeed');
    if (seed) seed.style.display = (n === 0 && rounds.length >= 7) ? '' : 'none';
  }


  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(html) {
    const t = $('#toast');
    if (!t) return;
    t.innerHTML = html; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1700);
  }

  /* ---------- tabs ---------- */
  let tab = 'predict';
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.t;
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === 's-' + tab));
    render();
  }));

  /* ---------- shared bits ---------- */
  const EMPTY = `<div class="empty">
    <svg viewBox="0 0 80 80" fill="none" aria-hidden="true">
      <rect x="8" y="14" width="34" height="52" rx="7" fill="#e8963f" opacity=".85" transform="rotate(-8 25 40)"/>
      <rect x="38" y="14" width="34" height="52" rx="7" fill="#3b6fc4" opacity=".85" transform="rotate(8 55 40)"/>
      <text x="25" y="47" text-anchor="middle" font-size="20" font-weight="900" fill="#fff" font-family="Arial" transform="rotate(-8 25 40)">D</text>
      <text x="55" y="47" text-anchor="middle" font-size="20" font-weight="900" fill="#fff" font-family="Arial" transform="rotate(8 55 40)">T</text>
    </svg>
    <div class="t">No rounds yet</div>
    <div class="s">Watch the game, then tap who won each round.<br>The prediction sharpens with every entry.</div></div>`;

  function beadHTML(n, src) {
    const show = (src || rounds).slice(-n);
    return show.map(r => `<div class="bead ${r.o}">${r.o === 'X' ? '=' : r.o}</div>`).join('');
  }

  let verdictCache = { n: -1, val: null };
  function getVerdict() {
    if (verdictCache.n !== rounds.length) verdictCache = { n: rounds.length, val: E.verdict(rounds) };
    return verdictCache.val;
  }

  function render() {
    const rp = $('#rounds-pill');
    if (rp) rp.textContent = rounds.length + (rounds.length === 1 ? ' round' : ' rounds');
    const v = getVerdict();
    const dot = $('#hdot');
    if (dot) {
      dot.className = 'vdot ' + (v.light === 'green' ? 'g' : v.light === 'red' ? 'r' : '');
      dot.title = v.note || 'collecting data';
    }
    ({ predict: renderPredict, live: renderLive, history: renderHistory, more: renderMore }[tab])();
  }

  /* ================= PREDICT ================= */
  function dragonSVG() {
    return `<img src="dragon-coin.png" alt="Dragon" class="coin-art" width="110" height="110">`;
  }
  function tigerSVG() {
    return `<img src="tiger-coin.png" alt="Tiger" class="coin-art" width="110" height="110">`;
  }
  function ensureCoins() {
    if ($('#coinD') && !$('#coinD img')) {
      $('#coinD').innerHTML = dragonSVG() + '<div class="cp" id="cpD">46.3%</div><div class="cw">DRAGON</div><div class="sig">PICK</div>';
    }
    if ($('#coinT') && !$('#coinT img')) {
      $('#coinT').innerHTML = tigerSVG() + '<div class="cp" id="cpT">46.3%</div><div class="cw">TIGER</div><div class="sig">PICK</div>';
    }
  }

  /* EXACT replica of dt-tool's rule engine (scored competitor) */
  function dtCloneSeq(seq) {
    if (seq.length < 3) return null;
    const nD = seq.split('').filter(c => c === 'D').length;
    const l3 = seq.slice(-3), l2 = seq.slice(-2);
    if (seq.length >= 7 && (seq === 'DTDTDTD' || seq === 'TDTDTDT')) return { pick: seq.endsWith('D') ? 'T' : 'D', pat: 'Ping-Pong' };
    if (l3 === 'DDD') return { pick: 'D', pat: 'Streak' };
    if (l3 === 'TTT') return { pick: 'T', pat: 'Streak' };
    if (l2 === 'DD') return { pick: 'T', pat: 'Pair Break' };
    if (l2 === 'TT') return { pick: 'D', pat: 'Pair Break' };
    return { pick: nD >= (seq.length / 2) ? 'D' : 'T', pat: 'Shoe Bias' };
  }
  function dtClone(hist) {
    return dtCloneSeq(hist.filter(r => r.o !== 'X').map(r => r.o).slice(-7).join(''));
  }
  function deskCall() {
    const strip = last7();
    const decidedN = strip.filter(function (o) { return o !== 'X'; }).length;
    const hist = deskHist();
    const dc = dtClone(hist);
    let pick = null, src = null, agree = false, eng = null;
    let C = null;
    // Try engine on desk first, then fall back to all rounds
    if (strip.length >= 7) {
      try { C = engineCall(hist); } catch (e) { C = null; }
    }
    if (!C && rounds.length >= 7) {
      try { C = engineCall(rounds); } catch (e) { C = null; }
    }
    if (dc) {
      pick = dc.pick; src = 'clone'; eng = C;
      agree = !!(C && C.pick === pick);
    } else if (C && (C.pick === 'D' || C.pick === 'T')) {
      pick = C.pick; src = 'vote'; eng = C;
    }
    return { pick: pick, src: src, agree: agree, decidedN: decidedN, ready: strip.length >= 3, dc: dc, eng: eng };
  }

  /* ===== BRAIN MEMORY — persists forever in localStorage, grows every round ===== */
  const MEM_KEY = 'dvt.brainmem';
  function emptyMem() {
    return {
      v: 2, trained: 0, hits: 0, atts: 0, lossRun: 0, lastPick: null,
      grams2: {}, grams3: {}, grams4: {},
      recov: { '0': { D: 0, T: 0, X: 0, n: 0 }, '1': { D: 0, T: 0, X: 0, n: 0 }, '2': { D: 0, T: 0, X: 0, n: 0 }, '3': { D: 0, T: 0, X: 0, n: 0 } },
      methods: { clone: { h: 0, a: 0 }, gram: { h: 0, a: 0 }, gram4: { h: 0, a: 0 } },
      /* PHASE 3: Pattern decay — older patterns get less weight */
      decayFactor: 0.98,
      /* PHASE 3: Side balance tracking */
      sideBalance: { D: 0, T: 0, X: 0, n: 0 }
    };
  }
  let MEM = emptyMem();
  (function () {
    if (!PERSIST) return;
    try {
      const j = JSON.parse(localStorage.getItem(MEM_KEY) || 'null');
      if (j && j.v === 1) {
        MEM = emptyMem();
        for (const k in j) MEM[k] = j[k];
        MEM.recov = Object.assign(emptyMem().recov, j.recov || {});
        MEM.grams2 = j.grams2 || {};
        MEM.grams3 = j.grams3 || {};
      }
    } catch (e) { }
  })();
  function saveMem() {
    if (!PERSIST) return;
    try { localStorage.setItem(MEM_KEY, JSON.stringify(MEM)); } catch (e) { }
    clearTimeout(saveMem._t);
    saveMem._t = setTimeout(pushBrainCloud, 2000);
  }
  const BRAIN_CLOUD = 'https://dvt-watcher.sahib3636.workers.dev/brain';
  const BRAIN_KEY = 'dvt-refresh-9f27';
  async function pushBrainCloud() {
    try {
      await fetch(BRAIN_CLOUD, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Key': BRAIN_KEY }, body: JSON.stringify(MEM) });
    } catch (e) { }
  }
  async function pullBrainCloud() {
    try {
      const j = await (await fetch(BRAIN_CLOUD, { cache: 'no-store' })).json();
      if (j && j.v >= 1 && (j.trained || 0) >= (MEM.trained || 0) && !j.empty) {
        const next = emptyMem();
        for (const k in j) next[k] = j[k];
        next.recov = Object.assign(emptyMem().recov, j.recov || {});
        next.grams2 = j.grams2 || {};
        next.grams3 = j.grams3 || {};
        next.grams4 = j.grams4 || {};
        next.sideBalance = j.sideBalance || { D: 0, T: 0, X: 0, n: 0 };
        MEM = next;
        if (PERSIST) try { localStorage.setItem(MEM_KEY, JSON.stringify(MEM)); } catch (e) { }
      }
    } catch (e) { }
  }
  function bumpRow(map, key, o) {
    if (!key || !o) return;
    const row = map[key] || (map[key] = { D: 0, T: 0, X: 0, n: 0 });
    if (row[o] == null) row[o] = 0;
    row[o]++; row.n++;
  }
  function bestRow(row, minN) {
    minN = minN || 8;
    if (!row || row.n < minN) return null;
    if ((row.D || 0) === (row.T || 0)) return null;
    return (row.D || 0) > (row.T || 0) ? 'D' : 'T';
  }
  function gramPick(hist) {
    hist = hist || rounds;
    const dec = hist.filter(r => r.o !== 'X').map(r => r.o);
    /* PHASE 3: 4-grams first (most specific), then 3-gram, then 2-gram */
    if (dec.length >= 4) {
      const key4 = dec.slice(-4).join('');
      const row4 = MEM.grams4 ? MEM.grams4[key4] : null;
      if (row4) {
        const p = bestRow(row4, 6);
        if (p) return { pick: p, src: '4-gram', n: row4.n };
      }
    }
    if (dec.length >= 3) {
      const p = bestRow(MEM.grams3[dec.slice(-3).join('')], 8);
      if (p) return { pick: p, src: '3-gram', n: MEM.grams3[dec.slice(-3).join('')].n };
    }
    if (dec.length >= 2) {
      const p = bestRow(MEM.grams2[dec.slice(-2).join('')], 12);
      if (p) return { pick: p, src: '2-gram', n: MEM.grams2[dec.slice(-2).join('')].n };
    }
    return null;
  }
  function recovPick() {
    const k = String(Math.min(MEM.lossRun, 3));
    const p = bestRow(MEM.recov[k], 6);
    if (!p) return null;
    return { pick: p, src: 'after-' + MEM.lossRun + '-loss', n: MEM.recov[k].n };
  }

  /* Incremental train: call AFTER a new outcome is already in `rounds`. */
  function brainObserve(o) {
    const dec = rounds.filter(r => r.o !== 'X').map(r => r.o);
    if (dec.length >= 3) bumpRow(MEM.grams2, dec.slice(-3, -1).join(''), o);
    if (dec.length >= 4) bumpRow(MEM.grams3, dec.slice(-4, -1).join(''), o);
    /* PHASE 3: 4-gram training */
    if (!MEM.grams4) MEM.grams4 = {};
    if (dec.length >= 5) bumpRow(MEM.grams4, dec.slice(-5, -1).join(''), o);
    /* PHASE 3: Side balance tracking */
    if (!MEM.sideBalance) MEM.sideBalance = { D: 0, T: 0, X: 0, n: 0 };
    if (o && MEM.sideBalance[o] !== undefined) { MEM.sideBalance[o]++; MEM.sideBalance.n++; }
    if (o !== 'X' && MEM.lastPick && (MEM.lastPick === 'D' || MEM.lastPick === 'T')) {
      const hit = MEM.lastPick === o;
      MEM.atts++;
      if (hit) MEM.hits++;
      bumpRow(MEM.recov, String(Math.min(MEM.lossRun, 3)), o);
      MEM.lossRun = hit ? 0 : (MEM.lossRun + 1);
      const dc = dtClone(rounds.slice(0, -1));
      if (dc) { MEM.methods.clone.a++; if (dc.pick === o) MEM.methods.clone.h++; ML.record('clone', dc.pick === o); }
      const gp = gramPick(rounds.slice(0, -1));
      if (gp) { MEM.methods.gram.a++; if (gp.pick === o) MEM.methods.gram.h++; ML.record(gp.src === '4-gram' ? 'gram4' : 'gram', gp.pick === o); }
      try {
        const ec = engineCall(rounds.slice(0, -1));
        if (ec && ec.pick) ML.record('engine', ec.pick === o);
      } catch(e) {}
      
      // LEVEL 2: Train Markov chain
      try { ML.trainMarkov(rounds.slice(0, -1)); } catch(e) {}
      
      // LEVEL 2: Train loss recovery patterns
      try { ML.trainLossPattern(MEM.lossRun, o); } catch(e) {}
      
      // LEVEL 2: Train temporal patterns
      try { ML.trainTemporal(o); } catch(e) {}
      
      // LEVEL 2: Calibrate confidence
      try {
        var lastBrain = computeBrain(rounds.slice(0, -1));
        if (lastBrain) ML.calibrateConf(lastBrain.conf, hit);
      } catch(e) {}
      
      // LEVEL 3: Record ensemble prediction
      if (ML.lastEnsemble) {
        ML.record('ensemble', ML.lastEnsemble.pick === o);
        ML.lastEnsemble = null;
      }
    }
    MEM.trained = rounds.length;
    saveMem();
  }

  function brainCatchup() {
    if (MEM.trained >= rounds.length) return;
    const start = MEM.trained;
    for (let i = Math.max(1, start); i < rounds.length; i++) {
      const o = rounds[i].o;
      const prefix = rounds.slice(0, i + 1);
      const dec = prefix.filter(r => r.o !== 'X').map(r => r.o);
      if (dec.length >= 3) bumpRow(MEM.grams2, dec.slice(-3, -1).join(''), o);
      if (dec.length >= 4) bumpRow(MEM.grams3, dec.slice(-4, -1).join(''), o);
      /* PHASE 3: 4-gram catchup */
      if (!MEM.grams4) MEM.grams4 = {};
      if (dec.length >= 5) bumpRow(MEM.grams4, dec.slice(-5, -1).join(''), o);
    }
    MEM.trained = rounds.length;
    saveMem();
  }
  brainCatchup();
  pullBrainCloud().then(function () { brainCatchup(); }).catch(function () { });

  // MACHINE LEARNING LEVEL 3: Adaptive brain with pattern learning
  var ML = {
    // Track method performance over sliding windows
    windowSize: 50,
    methodHistory: { clone: [], gram: [], gram4: [], engine: [], markov: [], ensemble: [] },
    // Adaptive weights (start equal, adjust based on performance)
    weights: { clone: 1.0, gram: 1.0, gram4: 1.2, engine: 1.0, markov: 1.5, ensemble: 1.0 },
    // Learning rate
    lr: 0.05,
    
    // LEVEL 2: Markov chain transition probabilities
    markov2: {}, // P(next | last 2)
    markov3: {}, // P(next | last 3)
    
    // LEVEL 2: Confidence calibration
    confBins: {}, // Track actual accuracy at each confidence level
    
    // LEVEL 2: Loss recovery patterns
    lossPatterns: { after1: {D:0,T:0,n:0}, after2: {D:0,T:0,n:0}, after3: {D:0,T:0,n:0}, after4: {D:0,T:0,n:0} },
    
    // LEVEL 2: Temporal patterns (hour of day)
    hourPatterns: {}, // P(D) by hour
    
    // LEVEL 3: Ensemble prediction cache
    lastEnsemble: null,

    // Record a prediction result for a method
    record: function(method, hit) {
      if (!this.methodHistory[method]) this.methodHistory[method] = [];
      this.methodHistory[method].push(hit ? 1 : 0);
      if (this.methodHistory[method].length > this.windowSize * 3) {
        this.methodHistory[method] = this.methodHistory[method].slice(-this.windowSize * 2);
      }
    },

    // Get accuracy for a method over recent window
    accuracy: function(method) {
      var h = this.methodHistory[method] || [];
      if (h.length < 10) return null;
      var recent = h.slice(-this.windowSize);
      var sum = 0;
      for (var i = 0; i < recent.length; i++) sum += recent[i];
      return sum / recent.length;
    },

    // LEVEL 2: Train Markov chain
    trainMarkov: function(hist) {
      var dec = hist.filter(function(r) { return r.o !== 'X'; }).map(function(r) { return r.o; });
      if (dec.length < 3) return;
      
      // Train 2-gram Markov
      var key2 = dec[dec.length - 2] + dec[dec.length - 1];
      var next = dec[dec.length]; // This is the current outcome
      if (next) {
        if (!this.markov2[key2]) this.markov2[key2] = {D:0, T:0, n:0};
        this.markov2[key2][next]++;
        this.markov2[key2].n++;
      }
      
      // Train 3-gram Markov
      if (dec.length >= 4) {
        var key3 = dec[dec.length - 3] + dec[dec.length - 2] + dec[dec.length - 1];
        if (!this.markov3[key3]) this.markov3[key3] = {D:0, T:0, n:0};
        this.markov3[key3][next]++;
        this.markov3[key3].n++;
      }
    },

    // LEVEL 2: Get Markov prediction
    markovPredict: function(hist) {
      var dec = hist.filter(function(r) { return r.o !== 'X'; }).map(function(r) { return r.o; });
      if (dec.length < 2) return null;
      
      // Try 3-gram first (more specific)
      if (dec.length >= 3) {
        var key3 = dec.slice(-3).join('');
        var row3 = this.markov3[key3];
        if (row3 && row3.n >= 5 && row3.D !== row3.T) {
          return { pick: row3.D > row3.T ? 'D' : 'T', src: 'markov3', n: row3.n };
        }
      }
      
      // Fall back to 2-gram
      var key2 = dec.slice(-2).join('');
      var row2 = this.markov2[key2];
      if (row2 && row2.n >= 8 && row2.D !== row2.T) {
        return { pick: row2.D > row2.T ? 'D' : 'T', src: 'markov2', n: row2.n };
      }
      
      return null;
    },

    // LEVEL 2: Train loss recovery patterns
    trainLossPattern: function(lossRun, outcome) {
      if (lossRun >= 1 && lossRun <= 4 && outcome !== 'X') {
        var key = 'after' + Math.min(lossRun, 4);
        this.lossPatterns[key][outcome]++;
        this.lossPatterns[key].n++;
      }
    },

    // LEVEL 2: Get loss recovery prediction
    lossRecoveryPredict: function(lossRun) {
      if (lossRun < 1 || lossRun > 4) return null;
      var key = 'after' + Math.min(lossRun, 4);
      var row = this.lossPatterns[key];
      if (row && row.n >= 5 && row.D !== row.T) {
        return { pick: row.D > row.T ? 'D' : 'T', src: 'loss-recovery', n: row.n };
      }
      return null;
    },

    // LEVEL 2: Train temporal patterns
    trainTemporal: function(outcome) {
      var hour = new Date().getHours();
      if (!this.hourPatterns[hour]) this.hourPatterns[hour] = {D:0, T:0, n:0};
      if (outcome !== 'X') {
        this.hourPatterns[hour][outcome]++;
        this.hourPatterns[hour].n++;
      }
    },

    // LEVEL 2: Get temporal prediction
    temporalPredict: function() {
      var hour = new Date().getHours();
      var row = this.hourPatterns[hour];
      if (row && row.n >= 10 && row.D !== row.T) {
        return { pick: row.D > row.T ? 'D' : 'T', src: 'temporal', n: row.n };
      }
      return null;
    },

    // LEVEL 2: Calibrate confidence
    calibrateConf: function(rawConf, actualHit) {
      var bin = Math.round(rawConf / 5) * 5; // Round to nearest 5
      if (!this.confBins[bin]) this.confBins[bin] = {hits:0, total:0};
      this.confBins[bin].total++;
      if (actualHit) this.confBins[bin].hits++;
    },

    // LEVEL 2: Get calibrated confidence
    getCalibratedConf: function(rawConf) {
      var bin = Math.round(rawConf / 5) * 5;
      var row = this.confBins[bin];
      if (row && row.total >= 10) {
        return (row.hits / row.total) * 100;
      }
      return rawConf; // Return raw if not enough data
    },

    // Adjust weights based on performance (gradient ascent on accuracy)
    adapt: function() {
      var methods = ['clone', 'gram', 'gram4', 'engine', 'markov'];
      var totalAcc = 0;
      var accs = {};
      for (var i = 0; i < methods.length; i++) {
        var m = methods[i];
        var acc = this.accuracy(m);
        if (acc !== null) {
          accs[m] = acc;
          totalAcc += acc;
        }
      }
      if (totalAcc === 0) return;
      // Normalize and adjust weights
      for (var j = 0; j < methods.length; j++) {
        var m2 = methods[j];
        if (accs[m2] !== undefined) {
          var target = accs[m2] / totalAcc;
          var current = this.weights[m2] / (this.weights.clone + this.weights.gram + this.weights.gram4 + this.weights.engine + this.weights.markov);
          this.weights[m2] += this.lr * (target - current);
          this.weights[m2] = Math.max(0.3, Math.min(3.0, this.weights[m2]));
        }
      }
    },

    // LEVEL 3: Ensemble prediction combining all methods
    predict: function(hist) {
      var votes = { D: 0, T: 0 };
      var reasons = [];
      
      // DT Clone
      var dc = dtClone(hist);
      if (dc && dc.pick) {
        votes[dc.pick] += this.weights.clone;
        reasons.push('clone:' + dc.pick);
      }
      
      // 3-gram and 4-gram
      var gp = gramPick(hist);
      if (gp && gp.pick) {
        var w = gp.src === '4-gram' ? this.weights.gram4 : this.weights.gram;
        votes[gp.pick] += w * (gp.n >= 10 ? 1.5 : 1.0);
        reasons.push(gp.src + ':' + gp.pick);
      }
      
      // Engine
      try {
        var C = engineCall(hist);
        if (C && C.pick) {
          votes[C.pick] += this.weights.engine;
          reasons.push('engine:' + C.pick);
        }
      } catch(e) {}
      
      // LEVEL 2: Markov chain
      var mp = this.markovPredict(hist);
      if (mp && mp.pick) {
        votes[mp.pick] += this.weights.markov * (mp.n >= 10 ? 1.3 : 1.0);
        reasons.push('markov:' + mp.pick);
      }
      
      // LEVEL 2: Loss recovery
      var rp = recovPick();
      if (rp && rp.pick && MEM.lossRun >= 3) {
        votes[rp.pick] += 0.5;
        reasons.push('recovery:' + rp.pick);
      }
      
      // LEVEL 2: Temporal
      var tp = this.temporalPredict();
      if (tp && tp.pick) {
        votes[tp.pick] += 0.3; // Lower weight for temporal
        reasons.push('temporal:' + tp.pick);
      }
      
      // Determine winner
      var pick;
      if (votes.D > votes.T) pick = 'D';
      else if (votes.T > votes.D) pick = 'T';
      else pick = dc ? dc.pick : 'D';
      
      // Store ensemble prediction for tracking
      this.lastEnsemble = { pick: pick, votes: votes, reasons: reasons };
      
      return pick;
    },

    // Save/load weights and learned patterns
    save: function() {
      if (PERSIST) {
        try {
          localStorage.setItem('dvt.ml', JSON.stringify({
            w: this.weights,
            h: this.methodHistory,
            m2: this.markov2,
            m3: this.markov3,
            lp: this.lossPatterns,
            hp: this.hourPatterns,
            cb: this.confBins
          }));
        } catch(e) {}
      }
    },
    load: function() {
      if (!PERSIST) return;
      try {
        var d = JSON.parse(localStorage.getItem('dvt.ml') || 'null');
        if (d && d.w) {
          this.weights = d.w;
          this.methodHistory = d.h || this.methodHistory;
          this.markov2 = d.m2 || {};
          this.markov3 = d.m3 || {};
          this.lossPatterns = d.lp || this.lossPatterns;
          this.hourPatterns = d.hp || {};
          this.confBins = d.cb || {};
        }
      } catch(e) {}
    }
  };

  // Load saved ML state
  ML.load();

  // Continuous learning loop
  setInterval(function() {
    try {
      // Rebuild card count
      CardCount.rebuildFromRounds();
      // Recalculate side balance
      var allDec = rounds.filter(function(r) { return r.o !== 'X'; });
      if (allDec.length > 0) {
        var dCount = allDec.filter(function(r) { return r.o === 'D'; }).length;
        var tCount = allDec.filter(function(r) { return r.o === 'T'; }).length;
        MEM.sideBalance = { D: dCount, T: tCount, X: rounds.length - dCount - tCount, n: rounds.length };
      }
      // Decay old patterns
      if (MEM.decayFactor && MEM.trained > 100) {
        Object.keys(MEM.grams2||{}).forEach(function(k) {
          if (MEM.grams2[k].n > 50) {
            MEM.grams2[k].D = Math.round(MEM.grams2[k].D * MEM.decayFactor);
            MEM.grams2[k].T = Math.round(MEM.grams2[k].T * MEM.decayFactor);
            MEM.grams2[k].n = MEM.grams2[k].D + MEM.grams2[k].T + (MEM.grams2[k].X||0);
          }
        });
      }
      // ML: Adapt weights based on recent performance
      ML.adapt();
      ML.save();
      saveMem();
    } catch(e) {}
  }, 30000);

  /* ===== HIT / MISS TAPE — last 20 engine calls ===== */
  const TAPE_KEY = 'dvt.tape';
  let tape = { cells: [], pending: null, trained: 0 };
  (function () {
    if (!PERSIST) return;
    try {
      const j = JSON.parse(localStorage.getItem(TAPE_KEY) || 'null');
      if (j && Array.isArray(j.cells)) {
        tape.cells = j.cells.slice(-40);
        tape.pending = j.pending || null;
        tape.trained = j.trained || 0;
      }
    } catch (e) { }
  })();
  function saveTape() {
    if (!PERSIST) return;
    try { localStorage.setItem(TAPE_KEY, JSON.stringify({ cells: tape.cells.slice(-40), pending: tape.pending, trained: tape.trained })); } catch (e) { }
  }
  function tapeSetPending() {
    if (rounds.length < 7) { tape.pending = null; MEM.lastPick = null; saveTape(); return; }
    const C = engineCall(rounds);
    const pick = (C && (C.pick === 'D' || C.pick === 'T')) ? C.pick : null;
    tape.pending = pick ? { pick: pick } : null;
    MEM.lastPick = pick;
    saveTape();
  }
  function tapeScore(o) {
    let hit;
    if (tape.pending && (tape.pending.pick === 'D' || tape.pending.pick === 'T')) {
      hit = o === 'X' ? null : tape.pending.pick === o;
      tape.cells.push({ pick: tape.pending.pick, o: o, hit: hit });
      if (tape.cells.length > 40) tape.cells = tape.cells.slice(-40);
    }
    const last = rounds[rounds.length - 1];
    if (last && last.o === o && last.hit === undefined) last.hit = hit === undefined ? null : hit;
    tape.trained = rounds.length;
    tapeSetPending();
  }
  function tapeRebuild() {
    tape.cells = [];
    tape.pending = null;
    const start = Math.max(7, rounds.length - 40);
    for (let i = start; i < rounds.length; i++) {
      const C = engineCall(rounds.slice(0, i));
      if (!C || (C.pick !== 'D' && C.pick !== 'T')) continue;
      const o = rounds[i].o;
      const hit = o === 'X' ? null : C.pick === o;
      rounds[i].hit = hit;
      tape.cells.push({ pick: C.pick, o: o, hit: hit });
    }
    tape.trained = rounds.length;
    tapeSetPending();
  }
  setTimeout(function () {
    try {
      if (tape.cells.length < 8 && rounds.length >= 8) tapeRebuild();
      else tapeSetPending();
      paintPlay7();
    } catch (e) { }
  }, 0);


  /* P1 probabilities only (no forced pick). */
  function leanQ(hist) {
    const n = hist.length;
    if (!n) return { D: 0.46267, T: 0.46267, X: 0.07466, cD: 0, cT: 0, cX: 0 };
    let cD = 0, cT = 0, cX = 0;
    for (const r of hist) { if (r.o === 'D') cD++; else if (r.o === 'T') cT++; else cX++; }
    const a0 = 300 + n;
    return { D: (0.46267 * 300 + cD) / a0, T: (0.46267 * 300 + cT) / a0, X: (0.07466 * 300 + cX) / a0, cD, cT, cX };
  }

  /* ENGINE call: vote of DT-Clone (2) + recent-20 hot (1) + streak≥3 (1) + P1 lean (1).
     This cannot systematically lose to DT-Clone — clone is in the vote, and ties break to clone. */
  function engineCall(hist) {
    const q = leanQ(hist);
    const dc = dtClone(hist);
    const decided = [];
    for (let i = hist.length - 1; i >= 0 && decided.length < 20; i--) if (hist[i].o !== 'X') decided.push(hist[i].o);
    decided.reverse();
    let recD = 0, recT = 0;
    for (const o of decided) { if (o === 'D') recD++; else recT++; }
    const hot = recD === recT ? null : (recD > recT ? 'D' : 'T');
    let streak = 0, side = decided.length ? decided[decided.length - 1] : null;
    for (let i = decided.length - 1; i >= 0; i--) { if (decided[i] === side) streak++; else break; }
    const streakPick = streak >= 3 ? side : null;
    const votes = { D: 0, T: 0 };
    // DT Clone: structural pattern (weight 2)
    if (dc) votes[dc.pick] += 2;
    // Recent heat: last 20 decided rounds (weight 1)
    if (hot) votes[hot] += 1;
    // Streak detection: only if streak >= 4 (weight 1, reduced from 3)
    if (streakPick && streak >= 4) votes[streakPick] += 1;
    // P1 lean: only if gap is significant (>2%)
    if (q.D - q.T > 0.02) votes.D += 1;
    else if (q.T - q.D > 0.02) votes.T += 1;
    // Brain memory: primary signal (weight 3-5)
    const gp = gramPick(hist);
    if (gp) {
      const w = gp.src === '4-gram' ? (gp.n >= 10 ? 5 : 4) : (gp.n >= 15 ? 4 : 3);
      votes[gp.pick] += w;
    }
    // Recovery: only after 3+ losses (weight 2)
    const rp = recovPick();
    if (rp && MEM.lossRun >= 3) votes[rp.pick] += 2;
    // Side balance: only if extreme imbalance (>12%) and enough data (50+)
    if (MEM.sideBalance && MEM.sideBalance.n >= 50) {
      const balD = MEM.sideBalance.D / MEM.sideBalance.n;
      const balT = MEM.sideBalance.T / MEM.sideBalance.n;
      if (balD - balT > 0.12) votes.T += 1;
      else if (balT - balD > 0.12) votes.D += 1;
    }
    let pick;
    if (votes.D > votes.T) pick = 'D';
    else if (votes.T > votes.D) pick = 'T';
    else {
      try { var mlPick = ML.predict(rounds); if (mlPick) pick = mlPick; else pick = dc ? dc.pick : (hot || side || 'D'); }
      catch(e) { pick = dc ? dc.pick : (hot || side || 'D'); }
    }
    return { pick, q, mode: (dc && pick === dc.pick) ? 'clone-vote' : 'vote', dcPick: dc && dc.pick, votes, streak, side, recD, recT, recN: decided.length, hot, streakPick, cD: q.cD, cT: q.cT, gram: gp, recov: rp };
  }

  function adaptivePick(histRaw, endIdx) {
    const hist = endIdx === undefined ? histRaw : histRaw.slice(0, endIdx);
    return engineCall(hist);
  }

  function resetSig() {
    return { n: 0, head: '', gram: {}, nt: [], engAtt: 0, engHit: 0, trAtt: 0, trHit: 0, dtAtt: 0, dtHit: 0 };
  }
  let sigState = resetSig();
  function computeSignals() {
    const n = rounds.length;
    const head = n ? (String(rounds[0].ts) + (rounds[0].o || '') + (rounds[0].src || '')) : '';
    if (sigState.head !== head || sigState.n > n) sigState = resetSig();
    sigState.head = head;
    if (sigState.n === 0 && n > 0) {
      const warm = Math.min(Math.max(1, n - 2000), n);
      for (let s = Math.max(0, warm - 8); s < warm; s++) if (rounds[s] && rounds[s].o !== 'X') sigState.nt.push(rounds[s].o);
      sigState.n = warm;
    }
    const gram = sigState.gram;
    const nt = sigState.nt;
    for (let i = sigState.n; i < n; i++) {
      const o = rounds[i].o;
      if (i >= 1 && o !== 'X') {
        const s = engineCall(rounds.slice(0, i));
        sigState.engAtt++; if (s.pick === o) sigState.engHit++;
        const key = rounds[i - 3] && (rounds[i - 3].o + rounds[i - 2].o + rounds[i - 1].o);
        if (key && !key.includes('X')) {
          const g = gram[key];
          if (g && (g.D + g.T) >= 4 && g.D !== g.T) {
            const tp = g.D > g.T ? 'D' : 'T';
            sigState.trAtt++; if (tp === o) sigState.trHit++;
          }
        }
        if (nt.length >= 7) {
          const dc = dtCloneSeq(nt.slice(-7).join(''));
          if (dc) { sigState.dtAtt++; if (dc.pick === o) sigState.dtHit++; }
        }
      }
      if (o !== 'X') { nt.push(o); if (nt.length > 8) nt.shift(); }
      if (i >= 3) {
        const key = rounds[i - 3].o + rounds[i - 2].o + rounds[i - 1].o;
        if (!key.includes('X')) {
          const g = gram[key] || (gram[key] = { D: 0, T: 0 });
          if (o === 'D') g.D++; else if (o === 'T') g.T++;
        }
      }
    }
    sigState.n = n;
    const cur = engineCall(rounds);
    const curDC = dtClone(playWin.length ? deskHist() : rounds);
    const dtPat = curDC ? curDC.pat : null;
    let trPick = null;
    if (n >= 4) {
      const key = rounds[n - 3].o + rounds[n - 2].o + rounds[n - 1].o;
      if (!key.includes('X')) {
        const g = gram[key];
        if (g && (g.D + g.T) >= 4 && g.D !== g.T) trPick = g.D > g.T ? 'D' : 'T';
      }
    }
    return {
      ...cur, trPick,
      engAtt: sigState.engAtt, engHit: sigState.engHit,
      trAtt: sigState.trAtt, trHit: sigState.trHit,
      dtAtt: sigState.dtAtt, dtHit: sigState.dtHit,
      dtPat, dcPick: curDC && curDC.pick
    };
  }
  let signalsCache = { n: -1, val: null };
  function getSignals() {
    if (signalsCache.n !== rounds.length) signalsCache = { n: rounds.length, val: computeSignals() };
    return signalsCache.val;
  }

  /* ================= THE BRAIN — SINGLE SOURCE OF TRUTH ================= */
  let brainHistory = [];
  (function () { if (PERSIST) { try { brainHistory = JSON.parse(localStorage.getItem('dvt.brain') || '[]'); } catch (e) {} } })();
  function saveBrain() { if (PERSIST) { try { localStorage.setItem('dvt.brain', JSON.stringify(brainHistory.slice(-500))); } catch (e) {} } }

  // Brain computes prediction AND bet decision — Sim just executes
  function computeBrain(hist, simState) {
    hist = hist || rounds;
    const n = hist.length;
    const C = engineCall(hist);
    const pick = C.pick;
    const name = pick === 'D' ? 'DRAGON' : 'TIGER';
    const reasons = [];
    let conf = 40;

    if (n < 7) {
      return { verdict: 'WAITING', level: 'wait', sub: 'Need 7 live rounds to start predicting', reasons: [{ good: null, text: 'Connect to a Dragon Tiger table and rounds will appear automatically' }], conf: 40, score: 1, pick, stake: 0.01, dtClonePick: C.dcPick, enginePick: pick, dtCloneAcc: null, engineAcc: null, recD: C.recD, recT: C.recT, action: 'WAIT', betWhy: 'Need 7 rounds' };
    }

    const S7 = getSignals();
    const dtCloneAcc = S7 && S7.dtAtt >= 20 ? S7.dtHit / S7.dtAtt : null;
    const engineAcc = S7 && S7.engAtt >= 20 ? S7.engHit / S7.engAtt : null;

    if (C.dcPick) {
      const ag = C.dcPick === pick;
      reasons.push({ good: ag, text: ag ? 'DT Clone agrees: ' + name : 'DT Clone differs — vote still ' + name });
      if (ag) conf += 8;
    }
    if (C.hot) {
      reasons.push({ good: true, text: 'Last 20 decided: ' + C.recD + 'D / ' + C.recT + 'T → hot ' + (C.hot === 'D' ? 'Dragon' : 'Tiger') });
      if (C.hot === pick) conf += 5;
    }
    if (C.streakPick) {
      reasons.push({ good: true, text: 'Run of ' + C.streak + '× ' + C.side });
      if (C.streakPick === pick) conf += 5;
    } else if (C.side) {
      reasons.push({ good: null, text: 'Current run: ' + C.streak + '× ' + C.side });
    }
    const gap = Math.abs(C.q.D - C.q.T) * 100;
    reasons.push({ good: gap >= 1, text: 'Table mix Dragon ' + (C.q.D * 100).toFixed(1) + '% / Tiger ' + (C.q.T * 100).toFixed(1) + '%' });
    if (engineAcc != null) reasons.push({ good: engineAcc >= 0.5, text: 'Engine live score ' + (engineAcc * 100).toFixed(0) + '%' });
    if (C.gram) reasons.push({ good: true, text: 'Memory ' + C.gram.src + ' → ' + (C.gram.pick === 'D' ? 'Dragon' : 'Tiger') + ' (' + C.gram.n + ' seen)' });
    if (C.recov && MEM.lossRun >= 2) reasons.push({ good: true, text: 'Recovery after ' + MEM.lossRun + ' losses → ' + (C.recov.pick === 'D' ? 'Dragon' : 'Tiger') });
    reasons.push({ good: null, text: 'Brain memory · ' + Object.keys(MEM.grams3).length + ' 3-grams · ' + MEM.trained + ' rounds · ' + (MEM.atts ? (100 * MEM.hits / MEM.atts).toFixed(0) + '% remembered hits' : 'warming up') });

    // DATA QUALITY BOOST — more data = more confidence
    if (n >= 20) conf += 3;
    if (n >= 50) conf += 3;
    if (n >= 100) conf += 2;
    if (Object.keys(MEM.grams3).length >= 10) conf += 2;
    if (Object.keys(MEM.grams3).length >= 30) conf += 2;

    // GRAMMAR BOOST — if we have a strong grammar signal
    if (C.gram && C.gram.n >= 10) {
      conf += 3;
      reasons.push({ good: true, text: 'Strong ' + C.gram.src + ' signal (' + C.gram.n + ' seen)' });
    }

    // ML accuracy boost — if learned methods are performing well, boost confidence
    var mlMethods = ['clone', 'gram', 'gram4', 'engine', 'markov'];
    var mlBestAcc = 0, mlBestName = '';
    for (var mi = 0; mi < mlMethods.length; mi++) {
      var mlAcc = ML.accuracy(mlMethods[mi]);
      if (mlAcc !== null && mlAcc > mlBestAcc) { mlBestAcc = mlAcc; mlBestName = mlMethods[mi]; }
    }
    if (mlBestAcc > 0.52) {
      var mlBoost = Math.round((mlBestAcc - 0.50) * 200);
      conf += mlBoost;
      reasons.push({ good: true, text: 'ML ' + mlBestName + ' ' + (mlBestAcc * 100).toFixed(0) + '% (+' + mlBoost + ')' });
    }
    
    // LEVEL 2: Markov chain prediction
    var mp = ML.markovPredict(hist);
    if (mp && mp.pick === pick) {
      conf += 4;
      reasons.push({ good: true, text: 'Markov ' + mp.src + ' → ' + (mp.pick === 'D' ? 'Dragon' : 'Tiger') + ' (' + mp.n + ' seen)' });
    }
    
    // LEVEL 2: Loss recovery pattern
    var lrp = ML.lossRecoveryPredict(MEM.lossRun);
    if (lrp && lrp.pick === pick && MEM.lossRun >= 2) {
      conf += 3;
      reasons.push({ good: true, text: 'Loss recovery pattern → ' + (lrp.pick === 'D' ? 'Dragon' : 'Tiger') });
    }
    
    // LEVEL 2: Temporal pattern
    var tp = ML.temporalPredict();
    if (tp && tp.pick === pick) {
      conf += 2;
      reasons.push({ good: null, text: 'Time-of-day pattern → ' + (tp.pick === 'D' ? 'Dragon' : 'Tiger') });
    }
    
    // LEVEL 2: Confidence calibration (only apply when we have enough data)
    var calibratedConf = ML.getCalibratedConf(conf);
    // Only use calibrated value if we have enough data AND it's not drastically lower
    if (calibratedConf > conf * 0.85) {
      conf = calibratedConf;
    }

    conf = Math.max(28, Math.min(88, Math.round(conf)));
    const agree = C.dcPick && C.dcPick === pick;
    const level = conf >= 62 ? 'bet' : 'call';
    const sub = agree
      ? 'Clone + vote aligned'
      : (C.hot === pick ? 'Following recent table' : 'Vote lead — watch the next 2');

    // ===== BRAIN DECIDES BET ACTION =====
    var action = 'WAIT';
    var betWhy = '';
    var stake = 0;
    var unit = 0;
    
    // Only if sim is running, Brain decides the bet
    if (simState && simState.started && !simState.paused) {
      var bank = Math.max(0, Math.floor(simState.bank || 0));
      var start = Math.max(1, Math.floor(simState.startBank || bank || 1));
      var mode = simState.mode || 'stable';
      var lossRun = Math.max(0, Math.floor(simState.lossRun || 0));
      var winRun = Math.max(0, Math.floor(simState.winRun || 0));
      
      // Brain decides: should we bet?
      if (bank < 10) {
        action = 'WAIT';
        betWhy = 'Bankroll too low';
      } else if (!pick) {
        action = 'WAIT';
        betWhy = 'No pick';
      } else if (conf < 35) {
        // Brain says: confidence too low, don't bet
        action = 'WAIT';
        betWhy = 'Brain: low confidence ' + conf + '%';
      } else if (MEM.atts >= 20 && (MEM.hits / MEM.atts) < 0.42) {
        // Brain says: my accuracy is too low, pause
        action = 'WAIT';
        betWhy = 'Brain: accuracy ' + (100 * MEM.hits / MEM.atts).toFixed(0) + '%';
      } else {
        // Brain says: BET! Now decide how much
        action = 'BET';
        
        // Brain sizes the bet based on confidence and mode
        if (mode === 'risk') {
          // Risk mode: Brain is aggressive
          unit = snapChip(start * 0.05);
          if (bank < start * 0.55) unit = snapChip(bank * 0.04);
          unit = Math.min(unit, snapChip(bank * 0.12));
          
          // Brain presses on high confidence
          var rmult = 1;
          if (conf >= 55 && winRun === 1) rmult = 2;
          else if (conf >= 55 && winRun >= 2) rmult = 3;
          
          stake = snapChip(rmult * unit);
          var rCap = Math.max(unit, snapChip(bank * 0.18));
          stake = Math.min(stake, rCap, bank);
          stake = snapChip(stake);
          
          // Brain pauses after too many losses
          if (lossRun >= 5) {
            action = 'WAIT';
            betWhy = 'Brain: pause after ' + lossRun + ' losses';
          } else {
            betWhy = rmult > 1 ? 'Brain: press x' + rmult + ' ' + conf + '%' : 'Brain: risk ' + conf + '%';
          }
        } else {
          // Stable mode: Brain is conservative
          unit = snapChip(start * 0.035);
          if (bank < start * 0.55) unit = snapChip(bank * 0.03);
          unit = Math.min(unit, snapChip(bank * 0.08));
          
          // Brain presses on high confidence
          var mult = 1;
          if (conf >= 62 && winRun === 1) mult = 2;
          else if (conf >= 62 && winRun >= 2) mult = 3;
          
          stake = snapChip(mult * unit);
          var cap = Math.max(unit, snapChip(bank * 0.12));
          stake = Math.min(stake, cap, bank);
          stake = snapChip(stake);
          
          // Brain pauses after too many losses
          if (lossRun >= 4) {
            action = 'WAIT';
            betWhy = 'Brain: pause after ' + lossRun + ' losses';
          } else {
            betWhy = mult > 1 ? 'Brain: press x' + mult + ' ' + conf + '%' : 'Brain: stable ' + conf + '%';
          }
        }
        
        // Final check: stake must be valid
        if (stake < 10) {
          action = 'WAIT';
          betWhy = 'Brain: below min chip';
        }
      }
    } else if (simState && simState.paused) {
      action = 'WAIT';
      betWhy = 'Paused';
    }

    if (!computeBrain._log) computeBrain._log = [];
    if (!computeBrain._log.length || computeBrain._log[computeBrain._log.length - 1].pick !== pick) {
      computeBrain._log.push({ ts: Date.now(), verdict: 'PLAY ' + name, score: conf, pick });
      computeBrain._log = computeBrain._log.slice(-8);
    }
    return {
      verdict: 'PLAY ' + name, level, sub, reasons, score: conf, pick, conf, stake,
      dtCloneAcc, engineAcc, dtClonePick: C.dcPick, enginePick: pick, consensus: agree ? pick : null,
      choppy: false, altRate: 0, log: computeBrain._log, recD: C.recD, recT: C.recT,
      memN: MEM.trained, lossRun: MEM.lossRun,
      // Brain's bet decision
      action: action, betWhy: betWhy, unit: unit
    };
  }

  /* ---- MONEY SIM: Brain sizes STABLE / RISK bets off the last-7 desk ---- */
  let sim = { bank: 0, startBank: 0, peak: 0, trough: 0, started: false, bets: [], pendingBet: null, mode: 'stable', lossRun: 0, winRun: 0, grindU: 1, waitCount: 0 };
  (function () {
    if (!PERSIST) return;
    try { sim = Object.assign(sim, JSON.parse(localStorage.getItem('dvt.sim') || '{}')); } catch (e) { }
    sim.mode = sim.mode === 'risk' ? 'risk' : 'stable';
    sim.pendingBet = null;
    sim.lossRun = sim.lossRun || 0;
    sim.winRun = sim.winRun || 0;
    sim.grindU = sim.grindU || 1;
    if (sim.started) {
      sim.startBank = sim.startBank || sim.bank;
      sim.peak = Math.max(sim.peak || 0, sim.bank || 0);
      sim.trough = sim.trough == null ? sim.bank : sim.trough;
    }
  })();

  // Cloud sync for sim
  var SIM_CLOUD = BRAIN_CLOUD.replace('/brain', '/sim');
  function pushSimCloud() {
    if (!sim.started || !PERSIST) return;
    try {
      var dump = {};
      for (var k in sim) if (k !== '_plan' && Object.prototype.hasOwnProperty.call(sim, k)) dump[k] = sim[k];
      fetch(SIM_CLOUD, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Key': BRAIN_KEY }, body: JSON.stringify(dump) }).catch(function(){});
    } catch (e) { }
  }
  function pullSimCloud() {
    if (!PERSIST) return Promise.resolve();
    return fetch(SIM_CLOUD, { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(j) {
      if (j && j.started && j.bank > 0 && (j.bets || []).length >= (sim.bets || []).length) {
        sim = Object.assign(sim, j);
        sim.pendingBet = null;
        saveSim();
      }
    }).catch(function(){});
  }
  // Pull sim from cloud on startup
  if (sim.started) pullSimCloud().then(function() { if (sim.started) { simNewBet(); } }).catch(function(){});

  function saveSim() {
    if (!PERSIST) return;
    try {
      var dump = {};
      for (var k in sim) if (k !== '_plan' && Object.prototype.hasOwnProperty.call(sim, k)) dump[k] = sim[k];
      localStorage.setItem('dvt.sim', JSON.stringify(dump));
    } catch (e) { }
  }
  function simSnap() {
    return { bank: sim.bank, lossRun: sim.lossRun || 0, winRun: sim.winRun || 0, grindU: sim.grindU || 1, peak: sim.peak || sim.bank, trough: sim.trough == null ? sim.bank : sim.trough };
  }

  // House edge: game takes 5% cut on wins (Rs 5 per Rs 100 won)
  var HOUSE_CUT = 0.05;
  function simNetWin(gross) {
    return Math.round(gross * (1 - HOUSE_CUT));
  }
  // Valid chip denominations in DvT game
  var CHIPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  function snapChip(amount) {
    if (amount <= 0) return 0;
    // Find the largest chip that fits
    for (var i = CHIPS.length - 1; i >= 0; i--) {
      if (CHIPS[i] <= amount) return CHIPS[i];
    }
    return CHIPS[0]; // minimum 10
  }

  // Sim is now a thin executor — Brain makes all decisions
  function simPlanNow() {
    if (sim.paused) {
      return { action: 'WAIT', side: null, stake: 0, why: 'Paused', unit: 0, mode: sim.mode || 'stable' };
    }
    if (rounds.length < 7) {
      return { action: 'WAIT', side: null, stake: 0, why: 'Need 7 rounds', unit: 0, mode: sim.mode || 'stable' };
    }
    
    // Ask Brain for the decision — pass sim state so Brain can decide
    var B;
    try { 
      B = computeBrain(rounds, sim); 
    } catch(e) { 
      return { action: 'WAIT', side: null, stake: 0, why: 'Brain error', unit: 0, mode: sim.mode }; 
    }
    
    // Sim just executes Brain's decision
    return { 
      action: B.action || 'WAIT', 
      side: B.pick || null, 
      stake: B.stake || 0, 
      why: B.betWhy || B.sub || 'Brain decision', 
      unit: B.unit || 0, 
      mode: sim.mode || 'stable' 
    };
  }

  function simNewBet() {
    if (!sim.started) return;
    const plan = simPlanNow();
    sim._plan = plan;
    if (plan.action === 'BET' && plan.side && plan.stake >= 1 && sim.bank >= plan.stake) {
      sim.pendingBet = { side: plan.side, stake: plan.stake, why: plan.why, wait: false };
    } else {
      sim.pendingBet = { side: plan.side || null, stake: 0, why: plan.why, wait: true };
    }
    saveSim();
  }
  function simSettleDesk(outcome) {
    if (!sim.started) return false;
    const bet = sim.pendingBet;
    if (!bet) return false;
    const prev = simSnap();
    if (bet.wait || !bet.side || !bet.stake) {
      if (sim.bank < 1) return false;
      if ((sim.mode === 'risk' && (sim.lossRun || 0) >= 4) || (sim.lossRun || 0) >= 3) {
        sim.waitCount = (sim.waitCount || 0) + 1;
        var waitNeeded = sim.mode === 'risk' ? 3 : 5;
        if (sim.waitCount >= waitNeeded) { sim.lossRun = 0; sim.waitCount = 0; }
      }
      sim.bets.push({ ts: Date.now(), wait: true, outcome: outcome, pnl: 0, side: bet.side || null, stake: 0, why: bet.why, prev: prev });
    } else {
      let pnl;
      if (outcome === bet.side) pnl = simNetWin(bet.stake); // House takes 5%
      else if (outcome === 'X') pnl = 0; // Tie: bet returned, no loss
      else pnl = -bet.stake;
      sim.bank += pnl;
      if (sim.bank < 0) sim.bank = 0;
      sim.peak = Math.max(sim.peak || sim.bank, sim.bank);
      sim.trough = Math.min(sim.trough == null ? sim.startBank : sim.trough, sim.bank);
      if (outcome === bet.side) {
        if (sim.mode === 'risk' && (sim.winRun || 0) === 2) sim.winRun = 0;
        else sim.winRun = (sim.winRun || 0) + 1;
        sim.lossRun = 0;
        sim.waitCount = 0;
        if (sim.mode === 'stable') {
          if (sim.bank >= sim.startBank) sim.grindU = 1;
          else sim.grindU = Math.min(4, (sim.grindU || 1) + 1);
        }
      } else if (outcome !== 'X') {
        sim.winRun = 0;
        sim.lossRun = (sim.lossRun || 0) + 1;
      }
      sim.bets.push({ ts: Date.now(), wait: false, side: bet.side, stake: bet.stake, outcome: outcome, pnl: pnl, why: bet.why, prev: prev });
    }
    if (sim.bets.length > 200) sim.bets = sim.bets.slice(-200);
    sim.pendingBet = null;
    saveSim();
    pushSimCloud(); // Sync to cloud after every settlement
    return true;
  }
  function simUndoLast() {
    if (!sim.bets.length) return;
    const b = sim.bets.pop();
    if (b && b.prev) {
      sim.bank = b.prev.bank;
      sim.lossRun = b.prev.lossRun;
      sim.winRun = b.prev.winRun;
      sim.grindU = b.prev.grindU;
      sim.peak = b.prev.peak;
      sim.trough = b.prev.trough;
    } else if (b && !b.wait) {
      sim.bank -= b.pnl;
      if (sim.bank < 0) sim.bank = 0;
    }
    sim.pendingBet = null;
    saveSim();
  }

  function renderBrain() {
    const v = $('#brainVerdict'), elS = $('#brainSub'), badge = $('#brainBadge'), confEl = $('#brainConf');
    try {
      const B = computeBrain(rounds, sim);
      if (v) {
        v.textContent = B.verdict;
        v.className = 'brain-verdict ' + (B.pick === 'D' ? 'd' : 't');
      }
      if (elS) elS.textContent = B.sub;
      if (badge) {
        var wasStrong = badge.classList.contains('hot');
        badge.textContent = rounds.length < 7 ? 'LEARNING' : (B.conf >= 62 ? 'STRONG' : 'CALL');
        badge.className = 'brain-badge' + (B.conf >= 62 ? ' hot' : '');
        if (B.conf >= 62 && !wasStrong) { SoundAlerts.strongBeep(); Session.recordPrediction({pick:B.pick,conf:B.conf}); }
      }
      if (confEl) confEl.innerHTML = rounds.length < 7 ? '' :
        '<div style="display:flex;justify-content:space-between;font-size:9.5px;letter-spacing:1.5px;color:var(--dim);font-weight:800;margin-bottom:3px">' +
        '<span>CONFIDENCE</span><span style="color:var(--gold-txt)">' + B.conf + '%</span></div>' +
        '<div style="height:4px;background:rgba(255,255,255,.07);border-radius:4px;overflow:hidden">' +
        '<div style="height:100%;width:' + B.conf + '%;border-radius:4px;background:linear-gradient(90deg,#e3af50,#f5d78e)"></div></div>';
      const rc = { true: 'var(--good)', false: 'var(--bad)', null: 'var(--dim)' };
      const ranked = (B.reasons || []).slice(0, 4);
      let fold = ranked.map(r => '<div class="r"><span class="dot" style="background:' + rc[r.good] + '"></span><span>' + r.text + '</span></div>').join('');
      fold += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;display:flex;justify-content:space-between">' +
        '<span>DT Clone <b style="color:' + (B.dtClonePick === 'D' ? 'var(--d-txt)' : 'var(--t-txt)') + '">' + (B.dtClonePick === 'D' ? 'DRAGON' : B.dtClonePick === 'T' ? 'TIGER' : '—') + '</b></span>' +
        '<span>Engine <b style="color:' + (B.pick === 'D' ? 'var(--d-txt)' : 'var(--t-txt)') + '">' + (B.pick === 'D' ? 'DRAGON' : 'TIGER') + '</b></span></div>' +
        '<div style="margin-top:6px;font-size:11px;color:var(--dim)">Online memory · ' + Object.keys(MEM.grams3).length + ' patterns · ' + MEM.trained + ' rounds learned' + (MEM.lossRun ? ' · recovering x' + MEM.lossRun : '') + '</div>';
      
      // Show Brain's bet decision
      if (sim.started && B.action) {
        var actionColor = B.action === 'BET' ? 'var(--good)' : 'var(--warn)';
        var actionIcon = B.action === 'BET' ? '▶' : '⏸';
        fold += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:' + actionColor + ';font-weight:800">' +
          actionIcon + ' BRAIN: ' + B.betWhy + '</div>';
      }
      
      const br = $('#brainReasons'); if (br) br.innerHTML = fold;
    } catch (e) {
      if (elS) elS.textContent = rounds.length ? (rounds.length + ' online rounds') : 'Waiting for the feed';
    }
  }

  function renderSim() {
    const el = $('#simCard');
    if (!el) return;
    if (!sim.started) {
      if (el.dataset.view === 'setup' && $('#simAmt')) return;
      el.dataset.view = 'setup';
      const mode = sim.mode === 'risk' ? 'risk' : 'stable';
      el.innerHTML = '<div class="sim-title">MONEY SIM</div>' +
        '<div class="sim-modes">' +
        '<button type="button" class="sim-mode' + (mode === 'stable' ? ' on' : '') + '" data-m="stable">STABLE</button>' +
        '<button type="button" class="sim-mode' + (mode === 'risk' ? ' on' : '') + '" data-m="risk">RISK</button>' +
        '</div>' +
        '<div class="sim-amtwrap"><label>BANKROLL Rs</label>' +
        '<input type="number" id="simAmt" value="' + (sim.startBank || 1000) + '" min="100" step="50" inputmode="numeric" autocomplete="off"></div>' +
        '<div class="sim-presets">' +
        '<button type="button" class="ghost sim-p" data-a="500">500</button>' +
        '<button type="button" class="ghost sim-p" data-a="1000">1,000</button>' +
        '<button type="button" class="ghost sim-p" data-a="2000">2,000</button>' +
        '<button type="button" class="ghost sim-p" data-a="5000">5,000</button>' +
        '</div>' +
        '<button class="act" id="simGo" style="width:100%;margin-top:12px">START</button>';
      el.querySelectorAll('.sim-mode').forEach(function (b) {
        b.addEventListener('click', function () {
          el.querySelectorAll('.sim-mode').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          sim.mode = b.dataset.m === 'risk' ? 'risk' : 'stable';
        });
      });
      el.querySelectorAll('.sim-p').forEach(function (b) {
        b.addEventListener('click', function () {
          const inp = $('#simAmt'); if (inp) inp.value = b.dataset.a;
        });
      });
      const go = $('#simGo');
      if (go) go.addEventListener('click', function () {
        const amt = Math.max(100, Math.round(+$('#simAmt').value || 1000));
        const m = ((el.querySelector('.sim-mode.on') || {}).dataset || {}).m === 'risk' ? 'risk' : 'stable';
        sim = { bank: amt, startBank: amt, peak: amt, trough: amt, started: true, bets: [], pendingBet: null, mode: m, lossRun: 0, winRun: 0, grindU: 1, waitCount: 0 };
        saveSim(); simNewBet(); el.dataset.view = 'run'; renderSim();
      });
      return;
    }
    el.dataset.view = 'run';
    if (!Array.isArray(sim.bets)) sim.bets = [];
    const pnl = sim.bank - sim.startBank;
    const pnlPct = sim.startBank ? ((pnl / sim.startBank) * 100).toFixed(1) : '0.0';
    const realBets = sim.bets.filter(function (b) { return !b.wait; });
    const played = realBets.length;
    const won = realBets.filter(function (b) { return b.pnl > 0; }).length;
    const waits = sim.bets.filter(function (b) { return b.wait; }).length;
    if (!sim.pendingBet) simNewBet();
    const cur = sim.pendingBet || { wait: true, why: 'Waiting', side: null, stake: 0 };
    const plan = sim._plan || simPlanNow();
    const last5 = sim.bets.slice(-6).reverse();
    let run = sim.startBank; const series = [run];
    for (const b of sim.bets) { run += (b.pnl || 0); series.push(run); }
    const show = series.slice(-40);
    const mn = Math.min.apply(null, show), mx = Math.max.apply(null, show), sp = (mx - mn) || 1;
    const pts2 = show.map(function (y, i) { return (i / (show.length - 1 || 1) * 100).toFixed(1) + ',' + (30 - (y - mn) / sp * 28).toFixed(1); }).join(' ');
    const sideName = function (s) { return s === 'D' ? 'DRAGON' : s === 'T' ? 'TIGER' : '—'; };
    const sideCol = function (s) { return s === 'D' ? 'var(--d-txt)' : s === 'T' ? 'var(--t-txt)' : 'var(--mut)'; };
    let planHtml;
    if (cur.wait) {
      planHtml = 'WAIT' + (cur.side ? ' · would be <b style="color:' + sideCol(cur.side) + '">' + sideName(cur.side) + '</b>' : '');
    } else {
      planHtml = 'NEXT <b style="color:' + sideCol(cur.side) + '">' + sideName(cur.side) + '</b> · Rs ' + cur.stake;
    }
    const dd = sim.peak ? Math.round(100 * (sim.peak - sim.bank) / sim.peak) : 0;
    el.innerHTML =
      '<div class="sim-title">MONEY SIM · ' + (sim.mode === 'risk' ? 'RISK' : 'STABLE') + '</div>' +
      '<div class="sim-strats" id="simModeRun">' +
      '<button type="button" class="ghost sim-s' + (sim.mode !== 'risk' ? ' on' : '') + '" data-m="stable">STABLE</button>' +
      '<button type="button" class="ghost sim-s' + (sim.mode === 'risk' ? ' on' : '') + '" data-m="risk">RISK</button>' +
      '</div>' +
      '<div class="sim-bank ' + (pnl >= 0 ? 'up' : 'down') + '">Rs ' + Math.round(sim.bank).toLocaleString() +
      ' <span class="sim-pnl">' + (pnl >= 0 ? '+' : '') + Math.round(pnl).toLocaleString() + ' (' + pnlPct + '%)</span></div>' +
      '<div class="sim-row"><span>' + played + ' bets · ' + won + ' won' + (played ? ' · ' + (100 * won / played).toFixed(0) + '%' : '') + (waits ? ' · ' + waits + ' wait' : '') + '</span>' +
      '<span>peak Rs ' + Math.round(sim.peak || sim.bank).toLocaleString() + '</span></div>' +
      (dd > 0 ? '<div class="sim-dd"><span>Drawdown ' + dd + '%</span><span>low Rs ' + Math.round(sim.trough == null ? sim.bank : sim.trough).toLocaleString() + '</span></div>' : '') +
      '<div class="sim-plan ' + (cur.wait ? 'wait' : 'active') + '">' + planHtml + '</div>' +
      '<svg viewBox="0 0 100 30" preserveAspectRatio="none" style="width:100%;height:36px;margin-top:6px"><polyline points="' + pts2 + '" fill="none" stroke="' + (pnl >= 0 ? 'var(--good)' : 'var(--bad)') + '" stroke-width="0.9"/></svg>' +
      (last5.length ? '<div class="sim-last">' + last5.map(function (b) {
        if (b.wait) return '<span class="sim-chip wait">W</span>';
        const ok = b.pnl > 0;
        return '<span class="sim-chip ' + (ok ? 'ok' : 'bad') + '">' + (b.side === 'D' ? 'D' : 'T') + (ok ? ' +' : ' ') + Math.round(b.pnl) + '</span>';
      }).join('') + '</div>' : '') +
      (sim.bank < 1 ? '<div class="sim-busted">BANKROLL EMPTY</div><button class="act" id="simRebuy" style="width:100%;margin-top:8px">REBUY Rs ' + Math.round(sim.startBank || 1000).toLocaleString() + '</button>' : '') +
      '<div class="sim-hint" style="margin-top:8px;font-size:10px;color:var(--dim);text-align:center;line-height:1.4">' +
      'House edge: 5% cut on wins · Tie = bet returned · Break-even requires ~51% accuracy' +
      (played > 0 ? '<br>Expected P&L: Rs ' + Math.round(played * -0.065 * (sim.startBank * 0.035)) + ' (based on ' + played + ' bets)' : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button class="ghost" id="simPause" style="flex:1;font-size:11px">' + (sim.paused ? 'RESUME' : 'PAUSE') + '</button>' +
      '<button class="ghost" id="simReset" style="flex:1;font-size:11px">Reset</button>' +
      '</div>';
    el.querySelectorAll('#simModeRun .sim-s').forEach(function (b) {
      b.addEventListener('click', function () {
        sim.mode = b.dataset.m === 'risk' ? 'risk' : 'stable';
        simNewBet();
        renderSim();
      });
    });
    const pauseBtn = $('#simPause');
    if (pauseBtn) pauseBtn.addEventListener('click', function () {
      sim.paused = !sim.paused;
      saveSim();
      renderSim();
      toast(sim.paused ? 'Sim paused' : 'Sim resumed');
    });
    const rst = $('#simReset');
    if (rst) rst.addEventListener('click', function () {
      if (!confirm('Reset money sim? Bankroll goes back to setup.')) return;
      sim = { bank: 0, startBank: 0, peak: 0, trough: 0, started: false, bets: [], pendingBet: null, mode: sim.mode || 'stable', lossRun: 0, winRun: 0, grindU: 1, waitCount: 0 };
      saveSim();
      el.dataset.view = '';
      renderSim();
    });
    const rb = $('#simRebuy');
    if (rb) rb.addEventListener('click', function () {
      const amt = Math.max(100, Math.round(sim.startBank || 1000));
      sim = { bank: amt, startBank: amt, peak: amt, trough: amt, started: true, bets: [], pendingBet: null, mode: sim.mode || 'stable', lossRun: 0, winRun: 0, grindU: 1, waitCount: 0 };
      saveSim(); simNewBet(); renderSim();
    });
  }

  // score our previous call when a new round arrives
  function scoreBrainCall(outcome) {
    const last = brainHistory[brainHistory.length - 1];
    if (last && last.hit === null && last.pick) {
      last.hit = (last.pick === outcome);
      saveBrain();
    }
  }

  function renderPredict() {
    const q = leanQ(rounds);
    const call = deskCall();
    const dc = call.dc;
    
    // Main prediction from Brain (single source of truth)
    let pick = null, conf = 0;
    try {
      const B = computeBrain(rounds);
      pick = B.pick;
      conf = B.conf || 0;
    } catch(e) {
      pick = call.pick;
    }
    
    $('#basis').textContent = '';

    if (!pick) {
      $('#vpick').textContent = '—';
      $('#vpick').style.color = 'var(--mut)';
      $('#vpct').textContent = '';
      const tag = $('#vtag'); if (tag) tag.style.display = 'none';
    } else {
      $('#vpick').textContent = pick === 'D' ? 'DRAGON' : 'TIGER';
      $('#vpick').style.color = pick === 'D' ? '#f2a94e' : '#5d96e8';
      $('#vpct').textContent = conf >= 62 ? 'STRONG · ' + conf + '%' : conf >= 42 ? 'CALL · ' + conf + '%' : '';
      const tag = $('#vtag'); if (tag) {
        if (conf >= 62) { tag.textContent = 'STRONG'; tag.style.display = ''; tag.className = 'vtag hot'; }
        else { tag.style.display = 'none'; }
      }
    }

    // DT Clone — original from deskCall (last 7 desk rounds, unchanged)
    const dcLine = $('#dtCloneLine');
    if (dcLine) {
      if (!dc) dcLine.innerHTML = 'DT Clone · warming up';
      else {
        const name = dc.pick === 'D' ? 'DRAGON' : 'TIGER';
        const agrees = dc.pick === pick;
        dcLine.innerHTML = 'DT Clone · <b class="' + (dc.pick === 'D' ? 'd' : 't') + '">' + name + '</b>' + (agrees ? ' ✓' : '');
      }
    }

    ensureCoins();
    const coinD = $('#coinD'), coinT = $('#coinT');
    if (coinD) coinD.className = 'coin who-d' + (pick === 'D' ? ' fav' : '');
    if (coinT) coinT.className = 'coin who-t' + (pick === 'T' ? ' fav' : '');
    const cpD = $('#cpD'), cpT = $('#cpT');
    if (cpD) cpD.textContent = (q.D * 100).toFixed(1) + '%';
    if (cpT) cpT.textContent = (q.T * 100).toFixed(1) + '%';
    const tieFill = $('#tieFill'), tiePct = $('#tiePct');
    if (tieFill) tieFill.style.width = Math.max(3, q.X / 0.6 * 100).toFixed(1) + '%';
    if (tiePct) tiePct.textContent = (q.X * 100).toFixed(1) + '%';

    // last-7 slots (online roadmap — not the desk)
    const road7 = rounds.slice(-7);
    $('#slots').innerHTML = Array.from({ length: 7 }, (_, i) => {
      const r = road7[i];
      return r ? `<div class="slot ${r.o}">${r.o === 'X' ? '=' : r.o}</div>` : `<div class="slot hint">·</div>`;
    }).join('');

    // live scoreboard — shown only once the sample can't lie (≥20 scored calls)
    try {
      const S = getSignals();
      const pctS = (h, a) => a ? `${(100 * h / a).toFixed(0)}%` : '—';
      const ciS = (h, a) => {
        if (!a || !E.wilsonCI) return '';
        const w = E.wilsonCI(h, a);
        return ` ±${((w[1] - w[0]) / 2 * 100).toFixed(0)}`;
      };
      const scoreChips = $('#scoreChips');
      if (scoreChips) {
        if (S.engAtt < 20) {
          scoreChips.innerHTML = `<span class="schip">live scores unlock at 20 scored rounds (${S.engAtt}/20)</span>`;
        } else {
          scoreChips.innerHTML = `
        <span class="schip">ENGINE <b>${S.engHit}/${S.engAtt}</b> · ${pctS(S.engHit, S.engAtt)}${ciS(S.engHit, S.engAtt)}</span>
        ${S.dtAtt >= 20 ? `<span class="schip">DT-CLONE <b>${S.dtHit}/${S.dtAtt}</b> · ${pctS(S.dtHit, S.dtAtt)}${ciS(S.dtHit, S.dtAtt)}</span>` : ''}
        ${S.trAtt >= 20 ? `<span class="schip">TREND <b>${S.trHit}/${S.trAtt}</b> · ${pctS(S.trHit, S.trAtt)}${ciS(S.trHit, S.trAtt)}</span>` : ''}`;
        }
      }
    } catch (e) { }
    try { renderBrain(); } catch (e) { }
    try { renderSim(); } catch (e) { }
    try { renderLiveStrip(); } catch (e) { }
    paintPlay7();
    /* FLAGSHIP: render card count, bet timer, session info */
    try { renderFlagship(); } catch (e) { }
  }

  /* ---------- video import: screen-recording → sampled frame OCR → merged rounds ---------- */
  let vidBusy = false;
  function vidMsg(text, cls) { const m = $('#vidMsg'); if (!m) return; m.textContent = text; m.className = 'msg ' + (cls || ''); }
  function seekTo(v, t) {
    return new Promise(res => {
      let done = false;
      const on = () => { if (done) return; done = true; v.removeEventListener('seeked', on); res(); };
      v.addEventListener('seeked', on);
      try { v.currentTime = Math.max(0, Math.min(t, (v.duration || 1) - 0.1)); } catch (e) { on(); }
      setTimeout(on, 3000);
    });
  }
  function frameSeq(cv) {
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      g = g < 110 ? g * 0.4 : Math.min(255, g * 1.5);
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }
  async function vidImport(file) {
    if (vidBusy) { vidMsg('Already processing a video…', 'err'); return; }
    if (!file) return;
    vidBusy = true;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    let worker = null;
    $('#prog').style.display = 'block'; $('#prog div').style.width = '0%';
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('cannot read this video')); });
      const dur = v.duration;
      if (!isFinite(dur) || dur < 10) throw new Error('video too short or unreadable');
      const interval = Math.max(5, Math.min(12, dur / 240));
      const times = [];
      for (let t = 5; t < dur && times.length < 400; t += interval) times.push(t);
      vidMsg(`Video ${(dur / 60).toFixed(0)} min · sampling ${times.length} frames — keep this tab open…`, 'ok');
      if (!window.Tesseract) { await loadScript(TESS_CDN); if (!window.Tesseract) throw new Error('OCR engine unavailable (offline?)'); }
      worker = await Tesseract.createWorker('eng', 1, {});
      await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'DTXAadxO0=' });
      const cv = document.createElement('canvas');
      const frames = [];
      for (let i = 0; i < times.length; i++) {
        await seekTo(v, times[i]);
        const scale = Math.min(1, 900 / (v.videoWidth || 900));
        cv.width = Math.round((v.videoWidth || 900) * scale);
        cv.height = Math.round((v.videoHeight || 1600) * scale);
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
        const { data } = await worker.recognize(frameSeq(cv));
        const seq = [];
        for (const ch of (data.text || '').replace(/\s+/g, '')) { const m = mapGlyph(ch); if (m) seq.push(m); }
        if (seq.length >= 3) frames.push(seq.join(''));
        $('#prog div').style.width = Math.round(100 * (i + 1) / times.length) + '%';
        if (i % 5 === 0) vidMsg(`Scanning frames… ${i + 1}/${times.length} (found ${frames.length} so far)`, 'ok');
      }
      if (!frames.length) throw new Error('No D/T letters found in any frame — make sure the roadmap row is visible');
      let merged = frames[0];
      for (let f = 1; f < frames.length; f++) {
        const s = frames[f];
        if (s.length <= merged.length && merged.endsWith(s)) continue;
        let k = Math.min(merged.length, s.length);
        while (k > 0 && !merged.endsWith(s.slice(0, k))) k--;
        if (k >= Math.min(3, s.length)) merged += s.slice(k);
      }
      const existing = rounds.filter(r => r.o !== 'X').map(r => r.o).slice(-40).join('');
      let overlap = 0;
      const maxO = Math.min(existing.length, merged.length, 30);
      for (let k = maxO; k > 0; k--) if (merged.startsWith(existing.slice(-k))) { overlap = k; break; }
      if (overlap) merged = merged.slice(overlap);
      if (!merged.length) { vidMsg('All rounds in this video are already logged — nothing new to add.', 'ok'); return; }
      ocrSeq = merged.split('');
      $('#chips').style.display = 'flex';
      $('#appendOcr').style.display = 'block';
      bindChips();
      vidMsg(`Recovered ${merged.length} new round${merged.length === 1 ? '' : 's'} from video${overlap ? ` (${overlap} already-known trimmed)` : ''} — review the chips, then append.`, 'ok');
      const chipsEl = $('#chips'); if (chipsEl) chipsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      vidMsg('Video import failed: ' + err.message, 'err');
    } finally {
      if (worker) { try { await worker.terminate(); } catch (e) { } }
      vidBusy = false;
      $('#prog').style.display = 'none'; $('#prog div').style.width = '0%';
      URL.revokeObjectURL(url);
    }
  }
  const vidPick = $('#vidPick'), vidFile = $('#vidFile');
  if (vidPick) vidPick.addEventListener('click', () => $('#vidFile').click());
  if (vidFile) vidFile.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; vidImport(f); });

  /* ================= LAST-7 DESK (prediction only — never written to rounds) ================= */
  const MERGE_SEC = 8;
  function findNearLive(o, ts, d, t) {
    let best = null, bestDt = 1e9;
    const slice = rounds.slice(-8);
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      if (!r || r.src !== 'live' || r.o !== o) continue;
      if (d && t && r.d && r.t && (r.d !== d || r.t !== t)) continue;
      const dt = Math.abs((r.ts || 0) - ts);
      if (dt < bestDt) { bestDt = dt; best = r; }
    }
    return (best && bestDt < MERGE_SEC) ? best : null;
  }
  function logRound(o) {
    if (o !== 'D' && o !== 'T' && o !== 'X') return;
    const ready = last7().length >= 7;
    let hit = null;
    if (ready && o !== 'X') {
      try {
        const call = deskCall();
        if (call.pick === 'D' || call.pick === 'T') hit = call.pick === o;
      } catch (e) { }
    }
    let marked = 0;
    if (sim.started && ready) {
      try { if (simSettleDesk(o)) { marked = 1; simNewBet(); } } catch (e) { }
    }
    playWin.push(o);
    playHits.push(hit);
    playMark.push(marked);
    if (playWin.length > 300) {
      playWin = playWin.slice(-120);
      playHits = playHits.slice(-120);
      playMark = playMark.slice(-120);
    }
    if (sim.started) { try { simNewBet(); } catch (e) { } }
    savePlay();
    try {
      if (navigator.vibrate) {
        if (hit === false) navigator.vibrate([18, 40, 18]);
        else navigator.vibrate(10);
      }
    } catch (e) { }
    paintPlay7();
    try { render(); } catch (e) { }
  }
  function undo() {
    if (!playWin.length) { toast('Nothing to undo'); return; }
    const marked = playMark.pop();
    playWin.pop();
    playHits.pop();
    if (marked && sim.started) { try { simUndoLast(); simNewBet(); } catch (e) { } }
    else if (sim.started) { try { simNewBet(); } catch (e) { } }
    savePlay();
    paintPlay7();
    render();
  }
  function clearDesk() {
    playWin = [];
    playHits = [];
    playMark = [];
    if (sim.started) { sim.pendingBet = null; try { simNewBet(); } catch (e) { } }
    savePlay();
    paintPlay7();
    render();
  }
  function seedDesk() {
    if (playWin.length) { toast('Clear the 7 first'); return; }
    const live = rounds.filter(function (r) { return r.src === 'live'; });
    const use = (live.length >= 7 ? live : rounds).slice(-7);
    if (use.length < 7) { toast('Need 7 online rounds first'); return; }
    playWin = use.map(function (r) { return r.o; });
    playHits = use.map(function () { return null; });
    playMark = use.map(function () { return 0; });
    if (sim.started) { sim.pendingBet = null; try { simNewBet(); } catch (e) { } }
    savePlay();
    paintPlay7();
    render();
    toast('Last 7 online → desk (session only)');
  }
  const qD = $('#qD'), qT = $('#qT'), qX = $('#qX');
  if (qD) qD.addEventListener('click', () => logRound('D'));
  if (qT) qT.addEventListener('click', () => logRound('T'));
  if (qX) qX.addEventListener('click', () => logRound('X'));
  const qU = $('#qUndo');
  if (qU) qU.addEventListener('click', undo);
  const qC = $('#qClear');
  if (qC) qC.addEventListener('click', clearDesk);
  const qS = $('#qSeed');
  if (qS) qS.addEventListener('click', seedDesk);
  // Keyboard shortcuts still work for manual entry
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (tab !== 'predict') return;
    if (k === 'd') logRound('D');
    else if (k === 't') logRound('T');
    else if (k === 'x' || e.key === '=') logRound('X');
    else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); }
  });

  /* ================= LIVE FEED ================= */
  const WORKER_URL = 'https://dvt-watcher.sahib3636.workers.dev';
  const ADMIN_KEY = 'dvt-refresh-9f27';
  window.liveState = window.liveState || { url: '', lastTs: 0, synced: 0, ok: null, health: null, lastCheck: 0, feedNewest: 0, lastSyncTs: 0, busy: false, ws: null, wsOk: false };
  let liveState = window.liveState;
  (function () {
    if (PERSIST) {
      try {
        liveState.url = localStorage.getItem('dvt.liveurl') || '';
        if (!liveState.url) { liveState.url = WORKER_URL; localStorage.setItem('dvt.liveurl', WORKER_URL); }
      } catch (e) { liveState.url = WORKER_URL; }
    } else if (!liveState.url) liveState.url = WORKER_URL;
    var el = $('#liveUrl'); if (el) el.value = liveState.url;
    var el2 = $('#liveUrl2'); if (el2) el2.value = liveState.url;
  })();

  function liveKey(r) { return (r.ts || 0) + '|' + r.o + '|' + (r.d || '') + '|' + (r.t || ''); }

  function ingestFeedList(list) {
    if (!Array.isArray(list) || !list.length) { paintSlots(); return 0; }
    const seen = new Set(rounds.map(liveKey));
    const added = [];
    let mergedN = 0;
    const sorted = [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const r of sorted) {
      if (!r || !r.winner) continue;
      const o = r.winner === '=' ? 'X' : r.winner;
      if (!'DTX'.includes(o)) continue;
      const ts = +r.ts;
      if (!(ts > 1600000000) || ts > 4000000000) continue;
      const rec = { ts, o, src: 'live', tbl: currentTable || 'auto', d: cleanRank(r.dragon), t: cleanRank(r.tiger) };
      const k = liveKey(rec);
      if (seen.has(k)) continue;
      if (findNearLive(o, ts, rec.d, rec.t)) continue;
      seen.add(k);
      rounds.push(rec);
      added.push(rec);
      try { brainObserve(o); } catch (e) { }
      try { tapeScore(o); } catch (e) { }
      /* FLAGSHIP: register card count, bet timer, session record */
      try {
        if (rec.d && rec.t && RANK_VAL[rec.d] && RANK_VAL[rec.t]) {
          CardCount.registerRound(RANK_VAL[rec.d], 0, RANK_VAL[rec.t], 0);
        }
        BetTimer.registerRound();
        Session.recordRound(rec);
        SoundAlerts.roundBeep();
      } catch (e) { }
    }
    rounds.sort((a, b) => a.ts - b.ts);
    if (rounds.length > 3000) rounds = rounds.slice(-3000);
    paintSlots();
    paintDtClone();
    if (!added.length && !mergedN) return 0;
    save();
    if (!added.length) { try { paintPlay7(); } catch (e) { } return mergedN; }
    liveState.synced += added.length;
    /* FLAGSHIP: auto-fill the 7 desk from live rounds */
    try { autoFillDesk(); } catch (e) { }
    // Settle money sim: settle pending bet with each new round, then make next bet
    if (sim.started && added.length) {
      for (var ai = 0; ai < added.length; ai++) {
        try {
          simSettleDesk(added[ai].o);
          simNewBet();
        } catch(e) {}
      }
    }
    const newest = added[added.length - 1];
    if (newest.o !== 'X') try { scoreBrainCall(newest.o); } catch (e) { }
    if ((liveState._lastPopupTs || 0) < newest.ts) {
      liveState._lastPopupTs = newest.ts;
      try { revealPopup(newest); } catch (e) { }
    }
    try { render(); } catch (e) { paintSlots(); paintDtClone(); }
    return added.length;
  }
  window.ingestFeedList = ingestFeedList;

  function applyFeedPayload(payload, ok) {
    if (!ok) {
      liveState.ok = false;
      liveState.lastCheck = Date.now();
      renderLiveStrip();
      if (tab === 'live') renderLive();
      return;
    }
    const list = Array.isArray(payload) ? payload : (payload && payload.rounds) || [];
    if (payload && payload.health) liveState.health = payload.health;
    if (payload && payload.lastHarvest) liveState.lastHarvest = payload.lastHarvest;
    if (!Array.isArray(list)) return;
    if (list.length) {
      let mx = 0; for (const r of list) { const ts = +r.ts || 0; if (ts > mx) mx = ts; }
      liveState.feedNewest = mx;
    }
    liveState.ok = true;
    liveState.lastCheck = Date.now();
    liveState.lastSyncTs = Date.now();
    ingestFeedList(list);
    renderLiveStrip();
    if (tab === 'live') renderLive();
  }

  let inFlight = null;
  async function livePoll() {
    if (inFlight) return inFlight;
    const url = (liveState.url || WORKER_URL).replace(/\/+$/, '');
    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const kill = setTimeout(function () { try { if (ac) ac.abort(); } catch (e) { } }, 6000);
    inFlight = (async function () {
      try {
        const res = await fetch(url + '/feed.json?t=' + Date.now(), { cache: 'no-store', signal: ac ? ac.signal : undefined });
        if (!res.ok) throw new Error('http ' + res.status);
        applyFeedPayload(await res.json(), true);
      } catch (e) {
        applyFeedPayload(null, false);
      } finally {
        clearTimeout(kill);
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function startFeedWorker() {
    const url = (liveState.url || WORKER_URL).replace(/\/+$/, '');
    try {
      const w = new Worker('poll-worker.js?v=56');
      w.onmessage = function (e) {
        if (!e.data) return;
        applyFeedPayload(e.data.payload, !!e.data.ok);
      };
      w.postMessage({ url: url });
      liveState.feedWorker = w;
    } catch (e) {
      (function loop() {
        livePoll().finally(function () { setTimeout(loop, 2000); });
      })();
    }
  }

  function lastLiveRound() {
    for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i].src === 'live') return rounds[i];
    return null;
  }
  function newestRound() {
    return rounds.length ? rounds[rounds.length - 1] : null;
  }
  function livePeriod() {
    const lr = rounds.filter(r => r.src === 'live');
    if (lr.length >= 2) {
      const p = lr[lr.length - 1].ts - lr[lr.length - 2].ts;
      if (p >= 20 && p <= 45) return p;
    }
    return 30;
  }
  function fmtAge(sec) {
    if (sec == null) return '—';
    if (sec < 90) return Math.round(sec) + 's ago';
    if (sec < 3600) return Math.round(sec / 60) + 'm ago';
    return (sec / 3600).toFixed(1) + 'h ago';
  }
  let slotSig = '';
  function paintSlots() {
    const el = $('#slots'); if (!el) return;
    const last7 = rounds.slice(-7);
    const sig = last7.map(r => r.o + (r.d || '') + (r.t || '')).join('');
    if (sig === slotSig) return;
    slotSig = sig;
    el.innerHTML = Array.from({ length: 7 }, (_, i) => {
      const r = last7[i];
      return r ? '<div class="slot ' + r.o + '">' + (r.o === 'X' ? '=' : r.o) + '</div>' : '<div class="slot hint">·</div>';
    }).join('');
  }
  function paintDtClone() {
    const dcLine = $('#dtCloneLine'); if (!dcLine) return;
    const call = deskCall();
    let html;
    if (!call.dc) html = call.decidedN < 3 ? ('DT Clone · need ' + (3 - call.decidedN) + ' decided') : 'DT Clone · warming up';
    else html = 'DT Clone · <b class="' + (call.dc.pick === 'D' ? 'd' : 't') + '">' + (call.dc.pick === 'D' ? 'DRAGON' : 'TIGER') + '</b>';
    if (dcLine.dataset.sig !== html) { dcLine.dataset.sig = html; dcLine.innerHTML = html; }
  }
  function renderLiveStrip() {
    const last = lastLiveRound() || newestRound();
    const now = Date.now() / 1000;
    const age = last && last.ts > 1e9 && last.ts < now + 60 ? now - last.ts : null;
    const cards = last && last.d && last.t ? (esc(last.d) + ' vs ' + esc(last.t)) : '';
    const w = last ? (last.o === 'X' ? 'Tie' : last.o === 'D' ? 'Dragon' : 'Tiger') : '';
    let html, color;
    if (liveState.ok === false) {
      html = '<b style="color:#fca5a5">FEED UNREACHABLE</b>';
      color = 'var(--bad)';
    } else if (!last) {
      html = 'Brain · ' + rounds.length + ' rounds learning';
      color = 'var(--warn)';
    } else if (age != null && age > 45) {
      html = '<b style="color:var(--warn)">LAST ' + fmtAge(age) + '</b> · ' + w + (cards ? ' · ' + cards : '');
      color = 'var(--warn)';
    } else {
      html = '<b>LIVE</b> · ' + w + (cards ? ' · ' + cards : '') + (age != null ? ' · ' + fmtAge(age) : '');
      color = 'var(--good)';
    }
    // Update BOTH Live tab and Predict tab strips
    var targets = [['liveText', 'liveDot'], ['predictText', 'predictDot']];
    for (var i = 0; i < targets.length; i++) {
      var txt = document.getElementById(targets[i][0]);
      var dot = document.getElementById(targets[i][1]);
      if (txt && txt.dataset.sig !== html) { txt.dataset.sig = html; txt.innerHTML = html; }
      if (dot) { dot.style.background = color; dot.style.boxShadow = '0 0 8px ' + color; }
    }
  }

  const RING_C = 87.96;
  const RING_P = 30;
  function tickRing() {
    const now = Date.now() / 1000;
    const last = lastLiveRound() || newestRound();
    let origin = Math.floor(now / RING_P) * RING_P;
    if (last && last.ts > 1600000000 && last.ts < 4000000000) {
      const age = now - last.ts;
      if (age >= 0 && age < 180) origin = last.ts;
    }
    let pos = now - origin;
    pos = ((pos % RING_P) + RING_P) % RING_P;
    const left = Math.max(1, Math.ceil(RING_P - pos));
    const offset = (RING_C * (pos / RING_P)).toFixed(2);
    let color, cls, label;
    if (pos < RING_P * 0.62) { color = '#5ef0b4'; cls = 'ph bet'; label = String(left); }
    else if (pos < RING_P - 3) { color = '#fbbf24'; cls = 'ph soon'; label = String(left); }
    else { color = '#f87171'; cls = 'ph now'; label = 'GO'; }
    // Update BOTH Live tab and Predict tab rings
    var rings = [['ringBar', 'ringPh'], ['predictRingBar', 'predictRingPh']];
    for (var i = 0; i < rings.length; i++) {
      var bar = document.getElementById(rings[i][0]);
      var ph = document.getElementById(rings[i][1]);
      if (!bar || !ph) continue;
      bar.style.strokeDashoffset = offset;
      bar.style.stroke = color;
      if (ph.textContent !== label) ph.textContent = label;
      ph.className = cls;
    }
  }
  (function ringTick() {
    try { tickRing(); } catch (e) { }
    setTimeout(ringTick, 250);
  })();
  setInterval(renderLiveStrip, 1000);

  function revealPopup(r) {
    // Show on ALL tabs (not just predict)
    // Add glitter to winning coin
    var winnerCoin = r.o === 'D' ? document.getElementById('coinD') : r.o === 'T' ? document.getElementById('coinT') : null;
    if (!winnerCoin) return;
    // Remove old glitter and animation classes
    var old = winnerCoin.querySelector('.coin-glitter');
    if (old) old.remove();
    document.querySelectorAll('.coin.winner, .coin.tie-win').forEach(function(c) { c.classList.remove('winner', 'tie-win'); });
    
    // Create glitter overlay that covers the entire coin
    var glitter = document.createElement('div');
    glitter.className = 'coin-glitter';
    glitter.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;overflow:hidden';
    var g = '';
    var particleCount = r.o === 'X' ? 15 : 25; // Fewer particles for Tie
    var particleColor = r.o === 'X' ? '#35d99a' : '#f6c453'; // Green for Tie, Gold for D/T
    for (var i = 0; i < particleCount; i++) {
      var x = Math.random() * 100;
      var y = Math.random() * 100;
      var size = 4 + Math.random() * 8;
      var delay = (Math.random() * 1.2).toFixed(2);
      g += '<span style="position:absolute;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + particleColor + ';opacity:0;left:' + x + '%;top:' + y + '%;animation:glitterPop 2s ' + delay + 's ease-out forwards;box-shadow:0 0 10px ' + particleColor + '"></span>';
    }
    glitter.innerHTML = g;
    // Ensure coin has position relative
    var computed = window.getComputedStyle(winnerCoin);
    if (computed.position === 'static') winnerCoin.style.position = 'relative';
    winnerCoin.appendChild(glitter);
    
    // Add winner or tie animation class
    if (r.o === 'X') {
      winnerCoin.classList.add('tie-win');
    } else {
      winnerCoin.classList.add('winner');
    }
    
    // Glow effect on the coin image
    var coinImg = winnerCoin.querySelector('img, svg');
    if (coinImg) {
      var glowColor = r.o === 'X' ? 'rgba(53,217,154,.9)' : (r.o === 'D' ? 'rgba(242,169,78,.9)' : 'rgba(93,150,232,.9)');
      coinImg.style.filter = 'drop-shadow(0 0 25px ' + glowColor + ')';
    }
    
    // Vibration feedback
    try { if (navigator.vibrate) navigator.vibrate(r.o === 'X' ? [40, 60, 40] : 50); } catch (e) { }
    
    // Sound feedback
    if (r.o === 'X') {
      SoundAlerts.beep(600, 0.2, 0.3); // Tie sound
    } else {
      SoundAlerts.strongBeep(); // Win sound
    }
    
    clearTimeout(revealPopup._t);
    revealPopup._t = setTimeout(function() {
      if (coinImg) coinImg.style.filter = '';
      winnerCoin.classList.remove('winner', 'tie-win');
      if (glitter.parentNode) glitter.remove();
    }, 3000); // Extended to 3 seconds
  }

  const liveSave = $('#liveSave');
  if (liveSave) liveSave.addEventListener('click', () => {
    liveState.url = $('#liveUrl').value.trim();
    if (PERSIST) { try { localStorage.setItem('dvt.liveurl', liveState.url); } catch (e) { } }
    liveState.lastTs = 0; liveState.ok = null;
    livePoll();
    toast('Live feed URL saved');
  });
  // Also bind the More tab save button
  const liveSave2 = $('#liveSave2');
  if (liveSave2) liveSave2.addEventListener('click', () => {
    var url2 = $('#liveUrl2');
    if (url2) liveState.url = url2.value.trim();
    if (PERSIST) { try { localStorage.setItem('dvt.liveurl', liveState.url); } catch (e) { } }
    liveState.lastTs = 0; liveState.ok = null;
    livePoll();
    toast('Live feed URL saved');
  });

  function extractFramesFromPcap(buf) {
    const dv = new DataView(buf);
    const mBE = dv.getUint32(0, false), mLE = dv.getUint32(0, true);
    let le = false;
    if (mBE === 0xa1b2c3d4 || mBE === 0xa1b23c4d) le = false;
    else if (mLE === 0xa1b2c3d4 || mLE === 0xa1b23c4d) le = true;
    else throw new Error('not a pcap file');
    let off = 24; const streams = {};
    while (off + 16 <= buf.byteLength) {
      const incl = dv.getUint32(off + 8, le);
      const ps = off + 16;
      if (incl <= 0 || ps + incl > buf.byteLength) break;
      if ((dv.getUint8(ps) >> 4) === 4) {
        const ihl = (dv.getUint8(ps) & 0xf) * 4;
        if (dv.getUint8(ps + 9) === 6) {
          const sport = dv.getUint16(ps + ihl, false), dport = dv.getUint16(ps + ihl + 2, false);
          const doff = (dv.getUint8(ps + ihl + 12) >> 4) * 4;
          const plen = incl - ihl - doff;
          if (dport === 9999 && plen > 0) (streams[sport] = streams[sport] || []).push(new Uint8Array(buf, ps + ihl + doff, plen));
        }
      }
      off = ps + incl;
    }
    const ports = Object.keys(streams);
    if (!ports.length) throw new Error('no DvT game traffic in capture (record while inside the room)');
    const chunks = streams[ports[0]];
    let total = 0; chunks.forEach(c => total += c.length);
    const sb = new Uint8Array(total); let p = 0;
    for (const c of chunks) { sb.set(c, p); p += c.length; }
    const frames = []; let i = 0;
    while (i + 4 <= sb.length && frames.length < 10) {
      const ln = sb[i + 2] | (sb[i + 3] << 8);
      if (ln < 4 || i + ln > sb.length) break;
      let h = ''; for (let k = i; k < i + ln; k++) h += sb[k].toString(16).padStart(2, '0');
      frames.push(h);
      i += ln;
    }
    if (frames.length < 3) throw new Error('handshake not found in capture');
    return frames;
  }
  const refreshMsg = (t, cls) => { const m = $('#refreshMsg'); if (!m) return; m.textContent = t; m.className = 'msg ' + (cls || ''); };
  const refreshPick = $('#refreshPick');
  if (refreshPick) refreshPick.addEventListener('click', () => $('#refreshFile').click());

  const autoReconnect = $('#autoReconnect');
  if (autoReconnect) autoReconnect.addEventListener('click', async () => {
    refreshMsg('Cloud recorder is logging in with a fresh session…', 'ok');
    try {
      const res = await fetch((liveState.url || WORKER_URL).replace(/\/+$/, '') + '/auto', { method: 'POST' });
      const j = await res.json();
      if (j.sessionRefreshed) {
        refreshMsg('★ RECORDER RECONNECTED — rounds flowing. Close this panel and watch PREDICT.', 'ok');
        liveState.ok = null; liveState.lastTs = 0;
        setTimeout(livePoll, 3000); setTimeout(livePoll, 30000); setTimeout(livePoll, 70000);
        toast('24/7 recorder reconnected');
      } else if (j.step === 'login') {
        refreshMsg('Casino login failed: ' + (j.error || j.code) + ' — make sure the GAME APP IS CLOSED (it holds the session), then try again.', 'err');
      } else {
        refreshMsg('Login OK, socket step failed: ' + JSON.stringify(j.results || j.error || '').slice(0, 120), 'err');
      }
    } catch (e) {
      refreshMsg('Error: ' + e.message, 'err');
    }
  });

  const refreshFile = $('#refreshFile');
  if (refreshFile) refreshFile.addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    refreshMsg('Parsing capture…', 'ok');
    try {
      const buf = await f.arrayBuffer();
      const frames = extractFramesFromPcap(buf);
      refreshMsg(`Extracted ${frames.length} handshake frames — uploading to 24/7 recorder…`, 'ok');
      const base = (liveState.url || WORKER_URL).replace(/\/+$/, '');
      const res = await fetch(base + '/frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Key': ADMIN_KEY },
        body: JSON.stringify({ frames })
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || ('http ' + res.status));
      refreshMsg('Session refreshed — the cloud recorder is reconnecting now. Rounds resume within ~1 minute.', 'ok');
      /* FLAGSHIP: also tell native layer to reconnect with new frames */
      try {
        if (window.Android && window.Android.connectWithFrames) {
          window.Android.connectWithFrames(JSON.stringify(frames));
        }
      } catch (e) { }
      liveState.lastTs = 0; liveState.ok = null;
      setTimeout(livePoll, 3000);
      toast('24/7 session refreshed');
    } catch (err) {
      refreshMsg('Refresh failed: ' + err.message, 'err');
    }
  });
  startFeedWorker();
  setTimeout(livePoll, 200);

  // 24/7 CLOUD COLLECTION: Pull ALL stored rounds from cloud on startup
  async function pullAllCloudRounds() {
    try {
      const url = (liveState.url || WORKER_URL).replace(/\/+$/, '');
      const res = await fetch(url + '/rounds?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.rounds) && data.rounds.length) {
        const before = rounds.length;
        ingestFeedList(data.rounds);
        const after = rounds.length;
        if (after > before) {
          toast('Cloud sync: ' + after + ' rounds loaded');
        }
      }
    } catch(e) {  }
  }
  // Pull all rounds after initial feed load
  setTimeout(pullAllCloudRounds, 3000);

  /* ---- WebSocket real-time connection to bridge ---- */
  function connectBridgeWS() {
    const url = (liveState.url || WORKER_URL).replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    if (liveState.ws) { try { liveState.ws.close(); } catch(e){} }
    try {
      const ws = new WebSocket(url);
      liveState.ws = ws;
      ws.onopen = () => { liveState.wsOk = true;  };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'round' && msg.winner) {
            const o = msg.winner === '=' ? 'X' : msg.winner;
            if ('DTX'.includes(o)) {
              ingestFeedList([{ ts: msg.ts, winner: msg.winner, dragon: msg.dragon, tiger: msg.tiger }]);
            }
          } else if (msg.type === 'history' && msg.rounds) {
            ingestFeedList(msg.rounds);
          }
        } catch(err) {}
      };
      ws.onclose = () => { liveState.wsOk = false; setTimeout(connectBridgeWS, 5000); };
      ws.onerror = () => { liveState.wsOk = false; };
    } catch(e) { liveState.wsOk = false; }
  }
  // Auto-connect WS if URL looks like a bridge (not the Worker)
  setTimeout(() => {
    const u = (liveState.url || '');
    if (u && !u.includes('workers.dev')) connectBridgeWS();
  }, 1000);
  function kick() {
    if (liveState.feedWorker) {
      try { liveState.feedWorker.postMessage({ kick: 1 }); } catch (e) { }
      return;
    }
    inFlight = null;
    livePoll();
  }
  window.addEventListener('focus', function() { kick(); try { if (navigator.wakeLock) navigator.wakeLock.request('screen'); } catch(e) {} });
  window.addEventListener('pageshow', kick);
  window.addEventListener('online', kick);
  // 24/7 recording: wake lock with retry
  (function requestWakeLock() {
    try {
      if (navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(function(lock) {
          
          // Re-request when released (e.g. tab hidden)
          lock.addEventListener('release', function() {
            
            setTimeout(requestWakeLock, 3000);
          });
        }).catch(function(e) {  });
      }
    } catch(e) {}
  })();

  // Keep-alive ping every 10s to prevent Android from killing the WebView
  setInterval(function() {
    try { livePoll(); } catch(e) {}
  }, 10000);

  // Reconnect aggressively when app comes back to foreground
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      kick();
      // Reconnect WebSocket if it was closed while in background
      if (liveState.ws && liveState.ws.readyState !== 1) {
        try { connectBridgeWS(); } catch(e) {}
      }
      // Also re-request wake lock
      try { if (navigator.wakeLock) navigator.wakeLock.request('screen'); } catch(e) {}
    }
  });

  function renderLive() {
    const pill = $('#liveStatusPill');
    const txt = $('#liveStatusTxt');
    if (!pill || !txt) return;
    const lastR = (rounds.filter(r => r.src === 'live').slice(-1)[0]) || null;
    const ageR = lastR ? (Date.now() / 1000 - lastR.ts) : null;
    if (liveState.ok === false) { txt.textContent = 'FEED OFFLINE'; pill.style.borderColor = 'rgba(248,113,113,.4)'; pill.style.color = 'var(--bad)'; }
    else if (ageR != null && ageR <= 90) { txt.textContent = 'LIVE'; pill.style.borderColor = 'rgba(52,211,153,.4)'; pill.style.color = 'var(--good)'; }
    else if (liveState.ok === true) { txt.textContent = 'STALE'; pill.style.borderColor = 'rgba(227,175,80,.4)'; pill.style.color = 'var(--warn)'; }
    else { txt.textContent = 'CHECKING'; pill.style.borderColor = ''; pill.style.color = 'var(--warn)'; }
    const liveRounds = rounds.filter(r => r.src === 'live');
    const last = liveRounds[liveRounds.length - 1] || newestRound();
    const age = last ? (Date.now() / 1000 - last.ts) : null;
    const period = livePeriod();
    const nextIn = (last && age != null && age <= period + 8) ? Math.max(0, period - age) : null;
    const body = $('#liveBody');
    if (!liveRounds.length) {
      body.innerHTML = `<div class="note" style="margin:8px 0 0">No live rounds in the feed yet.<br><br>
        Polling <b>${esc(liveState.url || WORKER_URL)}</b> every 1s.<br>
        Meanwhile tap <b>D / T / =</b> on PREDICT — those log instantly.${liveState.ok === false ? '<br><br><span style="color:var(--bad)">Feed not reachable right now.</span>' : ''}</div>`;
      return;
    }
    const show = liveRounds.slice(-12).reverse();
    const stale = age != null && age > 90;
    const harvAge = liveState.lastHarvest ? (Date.now() - liveState.lastHarvest) / 1000 : null;
    let recLine;
    if (!stale) recLine = 'live — auto-syncing';
    else if (harvAge != null && harvAge < 180 && age > 180) recLine = 'ran ' + Math.round(harvAge / 60) + 'm ago — connected, no new table packets';
    else if (harvAge != null) recLine = 'last try ' + Math.round(harvAge / 60) + 'm ago · last result ' + Math.round(age / 60) + 'm ago';
    else recLine = 'stalled — ' + Math.round(age / 60) + ' min since last round';
    body.innerHTML = `
      <div class="kv"><span class="k">Recorder</span><span class="${stale ? 'bad' : 'ok'}">${recLine}</span></div>
      <div class="kv"><span class="k">Rounds recorded</span><span>${liveRounds.length}</span></div>
      <div class="kv"><span class="k">Last round</span><span>${stale ? Math.round(age / 60) + ' min ago' : Math.round(age) + 's ago · next in ~' + Math.round(nextIn) + 's'}</span></div>
      <div class="chipsel" style="margin-top:12px;display:flex">
        ${show.map(r => `<div style="text-align:center;flex:1;min-width:64px">
          <div class="bead ${r.o}" style="margin:0 auto">${r.o === 'X' ? '=' : r.o}</div>
          <div style="font-size:10px;color:var(--mut);margin-top:3px">${r.d && r.t ? esc(r.d) + ' vs ' + esc(r.t) : ''}</div>
        </div>`).join('')}
      </div>`;
  }

  /* ---------- external predictor tester ---------- */
  let ext = { records: [], selPick: null };
  (function () { if (PERSIST) { try { ext = { ...ext, ...(JSON.parse(localStorage.getItem('dvt.ext') || '{}')) }; } catch (e) { } } })();
  const saveExt = () => { if (PERSIST) { try { localStorage.setItem('dvt.ext', JSON.stringify(ext)); } catch (e) { } } };
  function renderExt() {
    document.querySelectorAll('.ext-pick').forEach(b => {
      b.style.borderColor = ext.selPick === b.dataset.p ? 'var(--gold)' : '';
      b.style.color = ext.selPick === b.dataset.p ? 'var(--gold)' : '';
    });
    const n = ext.records.length;
    const hit = ext.records.filter(r => r.pick === r.actual).length;
    if (!n) { $('#extScore').innerHTML = `<div class="note" style="margin:0">No calls tested yet.</div>`; return; }
    const seq = ext.records.map(r => ({ o: r.actual }));
    let eAtt = 0, eHit = 0;
    for (let i = 1; i < n; i++) {
      if (seq[i].o === 'X') continue;
      const s = adaptivePick(seq.slice(0, i));
      eAtt++; if (s.pick === seq[i].o) eHit++;
    }
    let gapHtml = '';
    if (eAtt >= 10 && n >= 10) {
      const p1 = hit / n, p2 = eHit / eAtt;
      const pbar = (hit + eHit) / (n + eAtt);
      const se = Math.sqrt(pbar * (1 - pbar) * (1 / n + 1 / eAtt));
      const z = se > 0 ? (p1 - p2) / se : 0;
      const pv = 2 * E.normSF(Math.abs(z));
      const sig = pv < 0.05;
      gapHtml = `<div class="kv"><span class="k">Gap verdict (z-test)</span>
        <span class="${sig ? 'wrn' : ''}" style="font-weight:800">${sig ? 'REAL difference (p=' + pv.toFixed(3) + ')' : 'within luck\'s range (p=' + pv.toFixed(2) + ')'}</span></div>
        ${sig ? `<div class="note" style="color:var(--warn)">A real gap means the game itself has structure. Log those same rounds — Game Check will confirm it.</div>`
          : `<div class="note">Both scores are statistically the same so far. Keep testing — 30+ calls each settles it.</div>`}`;
    }
    $('#extScore').innerHTML = `
      <div class="kv"><span class="k">Their app</span><span style="font-weight:800">${hit}/${n} · ${(100 * hit / n).toFixed(1)}%</span></div>
      <div class="kv"><span class="k">Our engine (same rounds)</span><span style="font-weight:800">${eHit}/${eAtt} · ${eAtt ? (100 * eHit / eAtt).toFixed(1) : '—'}%</span></div>
      ${gapHtml}
      ${n < 30 ? `<div class="note">Keep going — ${30 - n} more for a trustworthy verdict.</div>` : ''}`;
  }
  document.querySelectorAll('.ext-pick').forEach(b => b.addEventListener('click', () => {
    ext.selPick = ext.selPick === b.dataset.p ? null : b.dataset.p;
    renderExt();
  }));
  document.querySelectorAll('.ext-res').forEach(b => b.addEventListener('click', () => {
    const m = $('#extMsg');
    if (!ext.selPick) { m.className = 'msg err'; m.textContent = 'First tap what the other app predicted.'; return; }
    ext.records.push({ pick: ext.selPick, actual: b.dataset.r });
    ext.selPick = null;
    saveExt(); renderExt();
    m.className = 'msg'; m.textContent = '';
    const hit = ext.records[ext.records.length - 1].pick === b.dataset.r;
    toast(hit ? 'Their call was RIGHT' : 'Their call was WRONG');
  }));

  /* ================= HISTORY ================= */
  function renderHistory() {
    // Brain Learning section
    const learnEl = document.getElementById('brainLearnBody');
    if (learnEl) {
      const acc = MEM.atts ? (100 * MEM.hits / MEM.atts).toFixed(1) : '0.0';
      const accColor = parseFloat(acc) >= 52 ? 'var(--good)' : parseFloat(acc) >= 48 ? 'var(--warn)' : 'var(--bad)';
      const cloneAcc = MEM.methods && MEM.methods.clone.a ? (100 * MEM.methods.clone.h / MEM.methods.clone.a).toFixed(1) : '0.0';
      const gramAcc = MEM.methods && MEM.methods.gram.a ? (100 * MEM.methods.gram.h / MEM.methods.gram.a).toFixed(1) : '0.0';
      const gram4Acc = MEM.methods && MEM.methods.gram4 && MEM.methods.gram4.a ? (100 * MEM.methods.gram4.h / MEM.methods.gram4.a).toFixed(1) : '0.0';
      learnEl.innerHTML =
        '<div class="kv"><span class="k">Total rounds learned</span><span style="font-weight:800">' + MEM.trained + '</span></div>' +
        '<div class="kv"><span class="k">Memory accuracy</span><span style="font-weight:800;color:' + accColor + '">' + acc + '% (' + MEM.hits + '/' + MEM.atts + ')</span></div>' +
        '<div class="kv"><span class="k">DT Clone method</span><span>' + cloneAcc + '% (' + (MEM.methods.clone.h||0) + '/' + (MEM.methods.clone.a||0) + ')</span></div>' +
        '<div class="kv"><span class="k">3-gram method</span><span>' + gramAcc + '% (' + (MEM.methods.gram.h||0) + '/' + (MEM.methods.gram.a||0) + ')</span></div>' +
        '<div class="kv"><span class="k">4-gram method</span><span>' + gram4Acc + '% (' + ((MEM.methods.gram4||{}).h||0) + '/' + ((MEM.methods.gram4||{}).a||0) + ')</span></div>' +
        '<div class="kv"><span class="k">Current loss streak</span><span>' + MEM.lossRun + '</span></div>' +
        '<div class="kv"><span class="k">Cloud sync</span><span style="color:var(--good)">Active · ' + MEM.trained + ' rounds</span></div>';
    }

    // Strategy Analysis
    const stratEl = document.getElementById('strategyBody');
    if (stratEl) {
      const sideD = MEM.sideBalance ? MEM.sideBalance.D || 0 : 0;
      const sideT = MEM.sideBalance ? MEM.sideBalance.T || 0 : 0;
      const sideN = MEM.sideBalance ? MEM.sideBalance.n || 0 : 0;
      const dPct = sideN ? (100*sideD/sideN).toFixed(1) : '0.0';
      const tPct = sideN ? (100*sideT/sideN).toFixed(1) : '0.0';
      const imbalance = sideN > 20 ? Math.abs(parseFloat(dPct) - parseFloat(tPct)) : 0;
      const bestGram = Object.entries(MEM.grams3||{}).sort((a,b) => (b[1].n||0) - (a[1].n||0)).slice(0,5);
      stratEl.innerHTML =
        '<div class="kv"><span class="k">Side balance</span><span>D ' + dPct + '% · T ' + tPct + '% (' + sideN + ' rounds)</span></div>' +
        '<div class="kv"><span class="k">Imbalance</span><span style="color:' + (imbalance > 8 ? 'var(--warn)' : 'var(--good)') + '">' + imbalance.toFixed(1) + '% ' + (imbalance > 8 ? '(leaning)' : '(balanced)') + '</span></div>' +
        '<div class="kv"><span class="k">Recovery strategy</span><span>After ' + MEM.lossRun + ' losses → ' + (MEM.lossRun >= 3 ? 'sit out' : 'continue') + '</span></div>' +
        '<div style="margin-top:10px;font-size:11px;font-weight:800;color:var(--dim);letter-spacing:1px">TOP PATTERNS</div>' +
        bestGram.map(function(g) {
          var row = g[1];
          var pick = (row.D||0) > (row.T||0) ? 'D' : 'T';
          var conf = row.n ? Math.round(100 * Math.max(row.D||0, row.T||0) / row.n) : 0;
          return '<div class="kv"><span class="k">' + g[0] + '</span><span>' + pick + ' ' + conf + '% (' + row.n + ' seen)</span></div>';
        }).join('');
    }

    // Pattern Explorer
    const patEl = document.getElementById('patternBody');
    if (patEl) {
      var top4 = Object.entries(MEM.grams4||{}).sort((a,b) => (b[1].n||0) - (a[1].n||0)).slice(0,8);
      patEl.innerHTML =
        '<div style="font-size:11px;font-weight:800;color:var(--dim);letter-spacing:1px;margin-bottom:6px">4-GRAM PATTERNS (most seen)</div>' +
        (top4.length ? top4.map(function(g) {
          var row = g[1];
          var pick = (row.D||0) > (row.T||0) ? 'D' : (row.T||0) > (row.D||0) ? 'T' : '-';
          var conf = row.n ? Math.round(100 * Math.max(row.D||0, row.T||0) / row.n) : 0;
          var bar = row.n ? Math.min(100, row.n * 2) : 0;
          return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0">' +
            '<span style="font-family:monospace;font-size:12px;width:50px;color:var(--txt)">' + g[0] + '</span>' +
            '<div style="flex:1;height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden"><div style="width:' + bar + '%;height:100%;background:var(--gold);border-radius:2px"></div></div>' +
            '<span style="font-size:11px;width:30px;color:' + (pick === 'D' ? 'var(--d-txt)' : pick === 'T' ? 'var(--t-txt)' : 'var(--dim)') + ';font-weight:800">' + pick + '</span>' +
            '<span style="font-size:10px;width:35px;color:var(--dim)">' + conf + '%</span>' +
            '<span style="font-size:10px;width:30px;color:var(--mut)">' + row.n + '</span></div>';
        }).join('') : '<div class="note">No patterns yet. Need more rounds.</div>');
    }
  }

  function parseSeq(str) {
    const out = [];
    for (const ch of (str || '').toUpperCase()) {
      if (ch === 'D') out.push('D');
      else if (ch === 'T') out.push('T');
      else if (ch === 'X' || ch === '=') out.push('X');
    }
    return out;
  }
  let parsed = [];
  const histQ = $('#histQ');
  if (histQ) histQ.addEventListener('input', () => { if (tab === 'history') renderHistory(); });
  const pasteBox = $('#pasteBox');
  if (pasteBox) pasteBox.addEventListener('input', () => {
    parsed = parseSeq($('#pasteBox').value);
    const m = $('#pasteMsg');
    $('#pasteAdd').disabled = parsed.length === 0;
    if (parsed.length) { m.className = 'msg ok'; m.textContent = `Found ${parsed.length} rounds (${parsed.filter(x => x === 'D').length}D · ${parsed.filter(x => x === 'T').length}T · ${parsed.filter(x => x === 'X').length} tie)`; }
    else { m.className = 'msg'; m.textContent = ''; }
  });
  const pasteAdd = $('#pasteAdd');
  if (pasteAdd) pasteAdd.addEventListener('click', () => {
    if (!parsed.length) return;
    const base = Math.floor(Date.now() / 1000);
    parsed.forEach((o, i) => rounds.push({ ts: base + i, o, src: 'paste' }));
    try { tapeRebuild(); } catch (e) { }
    save(); render();
    toast(`Added ${parsed.length} rounds · total ${rounds.length}`);
    $('#pasteBox').value = ''; parsed = []; $('#pasteAdd').disabled = true; $('#pasteMsg').className = 'msg';
  });

  /* ---------- OCR ---------- */
  const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  let ocrSeq = [], ocrBusy = false, pendingImg = null;
  const ocrMsg = (t, cls) => { const m = $('#ocrMsg'); if (!m) return; m.textContent = t; m.className = 'msg ' + (cls || ''); };
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('load failed'));
      document.head.appendChild(s);
    });
  }
  function prepCanvas(img) {
    const scale = Math.min(3, Math.max(1.5, 1400 / img.width));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const d = ctx.getImageData(0, 0, cv.width, cv.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      g = g < 110 ? g * 0.4 : Math.min(255, g * 1.5);
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }
  const mapGlyph = (ch) => 'DdOo0'.includes(ch) ? 'D' : 'TtAa'.includes(ch) ? 'T' : 'Xx='.includes(ch) ? 'X' : null;
  async function runOcr() {
    if (ocrBusy || !pendingImg) return;
    ocrBusy = true; $('#runOcr').disabled = true; $('#prog').style.display = 'block';
    try {
      if (!window.Tesseract) { await loadScript(TESS_CDN); if (!window.Tesseract) throw new Error('OCR engine unavailable (offline?)'); }
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: m => { if (m.status === 'recognizing text') $('#prog div').style.width = Math.round(m.progress * 100) + '%'; }
      });
      await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'DTXAadxO0=' });
      const { data } = await worker.recognize(prepCanvas(pendingImg));
      await worker.terminate();
      const seq = [];
      for (const ch of (data.text || '').replace(/\s+/g, '')) { const m = mapGlyph(ch); if (m) seq.push(m); }
      if (!seq.length) { ocrMsg(`No D/T letters found. Try a tight, bright crop of the roadmap row.`, 'err'); }
      else {
        ocrSeq = seq;
        $('#chips').style.display = 'flex';
        $('#appendOcr').style.display = 'block';
        bindChips();
        ocrMsg(`Found ${seq.length} rounds — tap a chip to fix it (D → T → Tie → off).`, 'ok');
      }
    } catch (err) {
      ocrMsg('OCR failed: ' + err.message + ' — engine downloads once; needs internet the first time.', 'err');
    } finally {
      ocrBusy = false; $('#runOcr').disabled = false; $('#prog').style.display = 'none'; $('#prog div').style.width = '0%';
    }
  }
  function bindChips() {
    $('#chips').innerHTML = ocrSeq.map((o, j) => `<div class="chip2 ${o}" data-i="${j}" role="button" tabindex="0" aria-label="${o}">${o === 'X' ? '=' : o}</div>`).join('');
    $('#appendOcr').disabled = ocrSeq.length === 0;
    const act = (ch) => () => {
      const i = +ch.dataset.i, cyc = { D: 'T', T: 'X', X: null };
      const nx = cyc[ocrSeq[i]];
      if (nx) ocrSeq[i] = nx; else ocrSeq.splice(i, 1);
      bindChips();
    };
    document.querySelectorAll('#chips .chip2').forEach(ch => {
      ch.addEventListener('click', act(ch));
      ch.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); act(ch)(); } });
    });
  }
  const runOcrBtn = $('#runOcr');
  if (runOcrBtn) runOcrBtn.addEventListener('click', runOcr);
  const appendOcr = $('#appendOcr');
  if (appendOcr) appendOcr.addEventListener('click', () => {
    if (!ocrSeq.length) return;
    const base = Math.floor(Date.now() / 1000), added = ocrSeq.length;
    ocrSeq.forEach((o, i) => rounds.push({ ts: base + i, o, src: 'ocr' }));
    try { tapeRebuild(); } catch (e) { }
    save(); render();
    ocrSeq = []; $('#chips').style.display = 'none'; $('#chips').innerHTML = '';
    $('#appendOcr').style.display = 'none';
    clearImg();
    toast(`Added ${added} rounds · total ${rounds.length}`);
  });
  let imgURL = null;
  function clearImg() {
    if (imgURL) { URL.revokeObjectURL(imgURL); imgURL = null; }
    pendingImg = null;
    const img = $('#ocrImg'); if (img) { img.style.display = 'none'; img.removeAttribute('src'); }
    const b = $('#runOcr'); if (b) b.style.display = 'none';
  }
  function takeFile(f) {
    if (!f || !f.type.startsWith('image/')) { ocrMsg('That is not an image.', 'err'); return; }
    clearImg();
    imgURL = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { pendingImg = img; const el = $('#ocrImg'); el.src = imgURL; el.style.display = 'block'; $('#runOcr').style.display = 'block'; ocrMsg('Loaded — tap Run OCR.', 'ok'); };
    img.onerror = () => { ocrMsg('Could not read that image.', 'err'); clearImg(); };
    img.src = imgURL;
  }
  const drop = $('#drop');
  if (drop) {
    drop.addEventListener('click', () => $('#file').click());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
    drop.addEventListener('drop', e => takeFile(e.dataTransfer.files[0]));
  }
  const fileEl = $('#file');
  if (fileEl) fileEl.addEventListener('change', e => takeFile(e.target.files[0]));
  window.addEventListener('paste', e => {
    if (tab !== 'history') return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) if (it.type.startsWith('image/')) { takeFile(it.getAsFile()); break; }
  });

  /* ================= MORE ================= */
  function gaugeSVG(score, color) {
    const R = 50, CX = 58, CY = 58;
    const arc = (frac) => {
      const a = Math.PI * (1 - frac);
      return `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY - R * Math.sin(a)).toFixed(2)}`;
    };
    const frac = Math.max(0, Math.min(1, score / 100));
    const a = Math.PI * (1 - frac);
    return `<div class="gauge"><svg width="116" height="70" viewBox="0 0 116 70" aria-hidden="true">
      <path d="M ${arc(0)} A ${R} ${R} 0 0 1 ${arc(1)}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10" stroke-linecap="round"/>
      <path d="M ${arc(0)} A ${R} ${R} 0 0 1 ${arc(Math.max(frac, .02))}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"/>
      <line x1="${CX}" y1="${CY}" x2="${(CX + (R - 9) * Math.cos(a)).toFixed(1)}" y2="${(CY - (R - 9) * Math.sin(a)).toFixed(1)}" stroke="#f0f3f9" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${CX}" cy="${CY}" r="4" fill="#f0f3f9"/>
      <text x="${CX}" y="${CY - 16}" text-anchor="middle" font-size="20" font-weight="800" fill="#f0f3f9">${score}</text>
    </svg></div>`;
  }
  function renderMore() {
    const n = rounds.length;
    const v = getVerdict();
    const colors = { green: 'var(--good)', red: 'var(--bad)', amber: 'var(--warn)' };
    let vb;
    if (n === 0) vb = EMPTY;
    else {
      const led = `<span class="led" style="background:${colors[v.light]};color:${colors[v.light]}"></span>`;
      const label = v.light === 'green' ? 'LOOKS FAIR' : v.light === 'red' ? 'DEVIATION FOUND' : 'COLLECTING DATA';
      vb = `<div class="vbig">${led}<span style="color:${colors[v.light]}">${label}</span></div>`;
      if (v.score !== null) vb += gaugeSVG(v.score, colors[v.score > 70 ? 'green' : v.score > 40 ? 'amber' : 'red']) +
        `<div style="text-align:center;font-size:11px;color:var(--dim);margin-bottom:6px">trust score / 100</div>`;
      else vb += `<div class="meter"><div style="width:${Math.min(100, n / 3)}%;background:var(--warn)"></div></div>
        <div style="font-size:11.5px;color:var(--dim);text-align:center">${n}/300 rounds toward a full check</div>`;
    }
    vb += `<div class="note">${v.note || (n ? '' : 'Log rounds to activate the checks.')}</div>`;

    const cardRounds = rounds.filter(r => r.d && r.t);
    if (cardRounds.length) {
      const ru = E.rankUniformity(rounds);
      vb += `<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
        <div class="kv"><span class="k">Deck Check · ${ru.pairs || cardRounds.length} card rounds (${ru.n || cardRounds.length * 2} cards)</span>
        <span>${ru.ready ? `<span class="${ru.p < 0.01 ? 'bad' : 'ok'}">χ²=${ru.stat.toFixed(1)} · p=${ru.p.toFixed(4)} ${ru.p < 0.01 ? '· RANKS NOT UNIFORM' : '· ranks uniform'}</span>` : `collecting — ${ru.need} more cards`}</span></div>
        ${ru.ready ? `<div class="kv"><span class="k">Avg rank Dragon / Tiger</span><span>${ru.dragonAvg.toFixed(2)} / ${ru.tigerAvg.toFixed(2)} <span style="color:var(--dim)">(fair ≈ 8.0)</span></span></div>
        <div class="note">Deck Check reads the actual dealt cards and tests whether all 13 ranks appear equally.</div>` : ''}</div>`;
    }

    if (n >= 20) {
      const chi = E.chiSquareGOF(rounds), rt = E.runsTest(rounds), gates = E.P2gates(rounds), sp = E.sprt(rounds);
      const row = (name, ok, plain) => `<div class="kv"><span class="k">${name}</span><span class="${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FLAGGED'} · <span style="font-weight:400;color:var(--dim)">${plain}</span></span></div>`;
      const chiOK = chi.p >= 0.01, rtOK = !rt || rt.p >= 0.01, gOK = !gates.some(g => g.fired), spOK = !sp.status.startsWith('biased');
      vb += `
        <div style="margin-top:12px">
        ${row('Right win rates?', chiOK, `Dragon ${chi.counts.D ? (100 * chi.counts.D / n).toFixed(1) : 0}% vs 46.3% expected`)}
        ${row('Results independent?', rtOK, rt ? `runs test p=${rt.p.toFixed(3)}` : 'need more data')}
        ${row('Exploitable pattern?', gOK, gOK ? 'none found' : 'pattern gate fired')}
        ${row('Tilt detector (SPRT)', spOK, sp.status === 'fair' ? 'fair within ±2%' : sp.status === 'continue' ? 'testing…' : sp.status === 'need-data' ? 'warming up' : 'BIASED')}
        </div>`;
      $('#advStats').innerHTML = `
        <div class="kv"><span class="k">Chi-square</span><span>χ²=${chi.stat.toFixed(2)} · df=2 · p=${chi.p.toFixed(4)}</span></div>
        ${rt ? `<div class="kv"><span class="k">Runs test</span><span>z=${rt.z.toFixed(2)} · p=${rt.p.toFixed(4)}</span></div>` : ''}
        ${gates.map(g => g.note
        ? `<div class="kv"><span class="k">Pattern gate d${g.k}</span><span>${g.note}</span></div>`
        : `<div class="kv"><span class="k">Pattern gate d${g.k}</span><span>G=${g.G.toFixed(1)} · p=${g.p.toExponential(2)}</span></div>`).join('')}
        <div class="kv"><span class="k">SPRT</span><span>${sp.n} decided · Dragon ${(100 * (sp.pHat || 0)).toFixed(2)}% · ${sp.status}</span></div>
        <div class="kv"><span class="k">Expected Dragon rate</span><span>46.27% (8 decks)</span></div>
        <div class="kv"><span class="k">House edge</span><span>3.73% per bet · Tie 32.8%</span></div>`;
    } else {
      const adv = $('#advStats'); if (adv) adv.innerHTML = `<div class="note">Unlocks at 20 rounds.</div>`;
    }
    $('#verdictBody').innerHTML = vb;

    const dig = $('#digestBody');
    if (dig) {
      const day = new Date(); day.setHours(0, 0, 0, 0);
      const t0 = day.getTime() / 1000;
      const today = rounds.filter(r => r.ts >= t0);
      const c = { D: 0, T: 0, X: 0 };
      today.forEach(r => { if (c[r.o] != null) c[r.o]++; });
      const tn = today.length;
      const decided = tape.cells.filter(function (x) { return x.hit !== null; }).slice(-20);
      const th = decided.filter(function (x) { return x.hit; }).length;
      dig.innerHTML = tn
        ? ('<div class="kv"><span class="k">Rounds today</span><span>' + tn + '</span></div>' +
           '<div class="kv"><span class="k">D / T / Tie</span><span>' + c.D + ' · ' + c.T + ' · ' + c.X + '</span></div>' +
           '<div class="kv"><span class="k">Brain patterns</span><span>' + Object.keys(MEM.grams3).length + ' · ' + MEM.trained + ' learned</span></div>' +
           (decided.length ? '<div class="kv"><span class="k">Tape last ' + decided.length + '</span><span>' + th + '/' + decided.length + ' · ' + Math.round(100 * th / decided.length) + '%</span></div>' : '') +
           (sim.started ? '<div class="kv"><span class="k">Sim P&L</span><span>Rs ' + Math.round(sim.bank - sim.startBank) + '</span></div>' : ''))
        : '<div class="note" style="margin:0">No rounds logged since midnight.</div>';
    }

    // Brain Data section
    const brainEl = document.getElementById('brainDataBody');
    if (brainEl) {
      const acc = MEM.atts ? (100 * MEM.hits / MEM.atts).toFixed(1) : '0.0';
      const gram2n = Object.keys(MEM.grams2 || {}).length;
      const gram3n = Object.keys(MEM.grams3 || {}).length;
      const gram4n = Object.keys(MEM.grams4 || {}).length;
      const sideD = MEM.sideBalance ? MEM.sideBalance.D || 0 : 0;
      const sideT = MEM.sideBalance ? MEM.sideBalance.T || 0 : 0;
      const sideN = MEM.sideBalance ? MEM.sideBalance.n || 0 : 0;
      const cloneAcc = MEM.methods && MEM.methods.clone.a ? (100 * MEM.methods.clone.h / MEM.methods.clone.a).toFixed(1) : '0.0';
      const gramAcc = MEM.methods && MEM.methods.gram.a ? (100 * MEM.methods.gram.h / MEM.methods.gram.a).toFixed(1) : '0.0';
      brainEl.innerHTML =
        '<div class="kv"><span class="k">Rounds learned</span><span>' + MEM.trained + '</span></div>' +
        '<div class="kv"><span class="k">Memory accuracy</span><span style="font-weight:800;color:' + (parseFloat(acc) >= 52 ? 'var(--good)' : parseFloat(acc) >= 48 ? 'var(--warn)' : 'var(--bad)') + '">' + acc + '% (' + MEM.hits + '/' + MEM.atts + ')</span></div>' +
        '<div class="kv"><span class="k">DT Clone accuracy</span><span>' + cloneAcc + '% (' + (MEM.methods.clone.h || 0) + '/' + (MEM.methods.clone.a || 0) + ')</span></div>' +
        '<div class="kv"><span class="k">Gram accuracy</span><span>' + gramAcc + '% (' + (MEM.methods.gram.h || 0) + '/' + (MEM.methods.gram.a || 0) + ')</span></div>' +
        '<div class="kv"><span class="k">Patterns stored</span><span>' + gram2n + ' bigrams · ' + gram3n + ' trigrams · ' + gram4n + ' quadgrams</span></div>' +
        '<div class="kv"><span class="k">Side balance</span><span>D ' + (sideN ? (100*sideD/sideN).toFixed(1) : '0') + '% · T ' + (sideN ? (100*sideT/sideN).toFixed(1) : '0') + '% (' + sideN + ' rounds)</span></div>' +
        '<div class="kv"><span class="k">Loss streak</span><span>' + MEM.lossRun + '</span></div>' +
        '<div class="kv"><span class="k">Recovery data</span><span>' + Object.keys(MEM.recov || {}).map(function(k) { var r = MEM.recov[k]; return k + 'loss: ' + (r.n || 0) + ' seen'; }).join(' · ') + '</span></div>' +
        '<div class="kv"><span class="k">Cloud sync</span><span>' + (MEM.trained > 0 ? 'Active · ' + MEM.trained + ' rounds synced' : 'Waiting for data') + '</span></div>';
    }

    const c = { manual: 0, ocr: 0, paste: 0, other: 0 };
    rounds.forEach(r => { c[r.src] !== undefined ? c[r.src]++ : c.other++; });
    $('#storage').innerHTML = `
      <div class="kv"><span class="k">Storage</span><span>${PERSIST ? '<span class="ok">on this device (offline)</span>' : '<span class="wrn">temporary — download the app file for persistence</span>'}</span></div>
      <div class="kv"><span class="k">Rounds</span><span>${n} total · ${c.manual} tapped · ${c.paste} pasted · ${c.ocr} OCR</span></div>`;
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = name; a.click();
  }
  const expJson = $('#expJson');
  if (expJson) expJson.addEventListener('click', () => download('dvt-backup.json', JSON.stringify({ app: 'dvt-predictor', v: 1, exported: Date.now(), rounds }, null, 1), 'application/json'));
  const expB = $('#expBrain'), impB = $('#impBrain'), impBF = $('#impBrainFile'), bmsg = $('#brainMsg');
  if (expB) expB.addEventListener('click', () => download('dvt-brain.json', JSON.stringify(MEM, null, 1), 'application/json'));
  if (impB && impBF) {
    impB.addEventListener('click', () => impBF.click());
    impBF.addEventListener('change', e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const j = JSON.parse(rd.result);
          if (!j || j.v !== 1) throw new Error('not a brain file');
          MEM = Object.assign(emptyMem(), j);
          MEM.grams2 = j.grams2 || {}; MEM.grams3 = j.grams3 || {};
          saveMem();
          if (bmsg) { bmsg.className = 'msg ok'; bmsg.textContent = 'Memory restored · ' + MEM.trained + ' rounds'; }
        } catch (err) { if (bmsg) { bmsg.className = 'msg err'; bmsg.textContent = err.message; } }
      };
      rd.readAsText(f);
    });
  }
  const expCsv = $('#expCsv');
  if (expCsv) expCsv.addEventListener('click', () => {
    const rows = [['idx', 'timestamp', 'outcome', 'source'],
    ...rounds.map((r, i) => [i + 1, new Date(r.ts * 1000).toISOString(), r.o, r.src])];
    download('dvt-rounds.csv', rows.map(x => x.join(',')).join('\n'), 'text/csv');
  });
  const impJson = $('#impJson');
  if (impJson) impJson.addEventListener('click', () => $('#impFile').click());
  const impFile = $('#impFile');
  if (impFile) impFile.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        const inc = Array.isArray(j) ? j : j.rounds;
        if (!Array.isArray(inc)) throw new Error('no rounds found in file');
        const clean = inc.filter(r => r && 'DTX'.includes(r.o)).map(r => ({ ts: (function (x) { x = +x || (Date.now() / 1000); return x > 1e12 ? x / 1000 : x; })(r.ts), o: r.o, src: r.src || 'import' }));
        const replace = confirm(`Found ${clean.length} rounds.\n\nOK = REPLACE everything\nCancel = ADD to current ${rounds.length}`);
        if (replace) rounds = clean;
        else rounds = rounds.concat(clean).sort((a, b) => a.ts - b.ts);
        try { tapeRebuild(); } catch (err) { }
        save(); render();
        dmsg(`Done — ${rounds.length} rounds now stored.`, 'ok');
      } catch (err) { dmsg('Restore failed: ' + err.message, 'err'); }
    };
    rd.readAsText(f);
  });
  const dmsg = (t, cls) => { const m = $('#dataMsg'); if (!m) return; m.textContent = t; m.className = 'msg ' + (cls || ''); };
  const wipe = $('#wipe');
  let wipePending = false;
  if (wipe) wipe.addEventListener('click', () => {
    if (!rounds.length) { dmsg('No rounds to delete.', ''); return; }
    if (!wipePending) {
      wipePending = true;
      wipe.textContent = 'TAP AGAIN TO CONFIRM DELETE';
      wipe.style.color = '#ff4444';
      setTimeout(() => { wipePending = false; wipe.textContent = 'Delete all rounds'; wipe.style.color = ''; }, 4000);
      return;
    }
    // Second tap — actually delete
    wipePending = false;
    wipe.textContent = 'Delete all rounds';
    wipe.style.color = '';
    try {
      rounds = [];
      save();
      try { tape = { cells: [], pending: null, trained: 0 }; saveTape(); } catch(e) {}
      try { render(); } catch(e) {}
      dmsg('All ' + rounds.length + ' rounds deleted. Storage cleared.', 'ok');
      toast('All rounds deleted');
    } catch(e) {
      dmsg('Delete error: ' + e.message, 'err');
    }
  });

  if (location.protocol === 'https:' || location.protocol === 'http:') {
    try {
      const mf = document.createElement('link'); mf.rel = 'manifest'; mf.href = 'manifest.webmanifest';
      document.head.appendChild(mf);
      if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { });
    } catch (e) { }
  }

  (function bindBrainToggle() {
    const btn = $('#brainToggle'), pan = $('#brainPanel');
    if (!btn || !pan || btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', function () {
      const open = pan.hasAttribute('hidden');
      if (open) pan.removeAttribute('hidden'); else pan.setAttribute('hidden', '');
      btn.classList.toggle('on', open);
      btn.textContent = open ? 'Hide details' : 'Why this call';
    });
  })();
  paintPlay7();
  renderExt();
  /* FLAGSHIP: render function */
  function renderFlagship() {
    // Card counting
    var shoe = document.getElementById('shoeInfo');
    if (shoe) {
      var dealt = CardCount.totalDealt();
      var rem = CardCount.remainingTotal();
      var pen = CardCount.penetration();
      var bias = CardCount.shoeBias();
      var tc = CardCount.trueCount();
      shoe.textContent = 'SHOE: ' + pen + '% · TC ' + tc + ' · ' + bias;
      shoe.style.color = pen > 75 ? 'var(--bad)' : pen > 50 ? 'var(--warn)' : 'var(--dim)';
    }
    // Rounds pill (replaced bet timer)
    var rp2 = document.getElementById('rounds-pill');
    if (rp2) rp2.textContent = rounds.length + (rounds.length === 1 ? ' round' : ' rounds');
    // Session info - minimal
    var si = document.getElementById('sessionInfo');
    if (si) {
      var dur = Math.round((Date.now() - Session.start) / 60000);
      if (dur > 0) si.textContent = dur + 'm';
      else si.style.display = 'none';
    }
    // Confidence gauge
    var gauge = document.getElementById('confGauge');
    if (gauge && rounds.length >= 7) {
      try {
        var B = computeBrain(rounds);
        gauge.innerHTML = confidenceGauge(B.conf);
      } catch(e) {}
    }
    // Streak indicator
    var streakEl = document.getElementById('streakInfo');
    if (streakEl) {
      var st = getStreakInfo();
      if (st.len >= 2) {
        var col = st.side === 'D' ? '#f2a94e' : '#5d96e8';
        var name = st.side === 'D' ? 'DRAGON' : 'TIGER';
        streakEl.innerHTML = '<span style="color:' + col + ';font-weight:900">' + st.len + 'x ' + name + '</span>' + (st.hot ? ' \uD83D\uDD25' : '');
        streakEl.style.display = '';
      } else {
        streakEl.style.display = 'none';
      }
    }
    // Ratio bar
    var ratioEl = document.getElementById('ratioBar');
    if (ratioEl) {
      var r = getRecentRatio(20);
      if (r.n >= 5) {
        var dW = Math.max(2, r.dPct);
        var tW = Math.max(2, r.tPct);
        ratioEl.innerHTML =
          '<div style="display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:.5px">' +
          '<span style="color:#f2a94e">' + r.dPct + '%</span>' +
          '<div style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.06);display:flex;overflow:hidden">' +
          '<div style="width:' + dW + '%;background:#f2a94e;border-radius:3px 0 0 3px"></div>' +
          '<div style="width:' + tW + '%;background:#5d96e8;border-radius:0 3px 3px 0"></div></div>' +
          '<span style="color:#5d96e8">' + r.tPct + '%</span>' +
          '<span style="color:var(--dim);font-size:9px">' + r.n + '</span></div>';
        ratioEl.style.display = '';
      } else {
        ratioEl.style.display = 'none';
      }
    }
  }
  setInterval(renderFlagship, 1000);
  
  // Also update rounds pill and Live tab pill from renderLiveStrip
  var _origRenderLiveStrip = renderLiveStrip;
  renderLiveStrip = function() {
    _origRenderLiveStrip();
    // Update rounds pill
    var rp = document.getElementById('rounds-pill');
    if (rp) rp.textContent = rounds.length + (rounds.length === 1 ? ' round' : ' rounds');
    // Update Live tab pill
    var last = lastLiveRound() || newestRound();
    var now = Date.now() / 1000;
    var age = last && last.ts > 1e9 && last.ts < now + 60 ? now - last.ts : null;
    var pill = document.getElementById('liveStatusPill');
    var txt = document.getElementById('liveStatusTxt');
    if (pill && txt) {
      if (rounds.length > 0 && age !== null && age <= 60) {
        txt.textContent = 'LIVE';
        pill.style.borderColor = 'rgba(52,211,153,.4)';
        pill.style.color = 'var(--good)';
      } else if (rounds.length > 0 && age !== null && age <= 180) {
        txt.textContent = 'STALE';
        pill.style.borderColor = 'rgba(227,175,80,.4)';
        pill.style.color = 'var(--warn)';
      } else if (liveState.ok === false && !liveState.wsOk) {
        txt.textContent = 'OFFLINE';
        pill.style.borderColor = 'rgba(248,113,113,.4)';
        pill.style.color = 'var(--bad)';
      } else {
        txt.textContent = 'CHECKING';
        pill.style.borderColor = '';
        pill.style.color = 'var(--warn)';
      }
    }
  };
  
  render();
})();
