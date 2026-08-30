/* ============================================================
   Dragon vs Tiger Engine (DVTE) — pure functions, zero deps
   UMD: browser -> window.DVTE | Node -> module.exports
   All math is exact and unit-tested (test/run-tests.cjs).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DVTE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- constants (8-deck Dragon vs Tiger) ---------- */
  const BASE = { D: 0.46267, T: 0.46267, X: 0.07466 };  // true probabilities (sum = 1)
  const OUTCOMES = ['D', 'T', 'X'];
  const BASE_LOGLOSS = -(2 * BASE.D * Math.log(BASE.D) + BASE.X * Math.log(BASE.X)); // nats
  const DIRICHLET_PRIOR = { D: 138.8, T: 138.8, X: 22.4 }; // alpha0 = 300, seeded at theory
  const EDGE_DT = 2 * BASE.D + 0.5 * BASE.X - 1;             // -3.733% house edge

  /* ---------- seeded PRNG (tests only; never used for prediction) ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- special functions ---------- */
  function lgamma(xx) { // Lanczos / Numerical Recipes (exact NR form)
    const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    if (xx < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * xx)) - lgamma(1 - xx);
    let x = xx; const y = xx;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000015002;
    for (let j = 0; j < 6; j++) { x += 1; ser += cof[j] / x; }
    return -tmp + Math.log(2.5066282746310005 * ser / y);
  }
  // regularized lower gamma P(a,x)
  function gammp(a, x) {
    if (x <= 0) return 0;
    if (x < a + 1) { // series
      let ap = a, sum = 1 / a, del = sum;
      for (let n = 1; n < 1000; n++) {
        ap++; del *= x / ap; sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
      }
      return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
    }
    return 1 - gammaq(a, x); // continued fraction for Q
  }
  // regularized upper gamma Q(a,x)
  function gammaq(a, x) {
    if (x <= 0) return 1;
    if (x < a + 1) return 1 - gammp(a, x);
    const FPMIN = 1e-300;
    let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
    for (let i = 1; i < 1000; i++) {
      const an = -i * (i - a);
      b += 2; d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  }
  const chi2sf = (x, k) => (x <= 0 ? 1 : gammaq(k / 2, x / 2)); // survival
  const normSF = (z) => 0.5 * gammaq(0.5, z * z / 2); // one-sided normal tail = ½erfc(z/√2)

  /* ---------- interval & counting ---------- */
  function wilsonCI(k, n, z) {
    z = z || 1.96;
    if (n === 0) return [0, 1];
    const p = k / n, z2 = z * z, d = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / d;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
    return [Math.max(0, center - half), Math.min(1, center + half)];
  }
  function counts(rounds) {
    const c = { D: 0, T: 0, X: 0 };
    for (const r of rounds) if (c[r.o] !== undefined) c[r.o]++;
    return c;
  }
  function decided(rounds) { return rounds.filter(r => r.o !== 'X'); }

  /* ---------- chi-square goodness of fit (D/T/Tie vs theory) ---------- */
  function chiSquareGOF(rounds) {
    const n = rounds.length; if (n === 0) return null;
    const c = counts(rounds);
    let stat = 0;
    for (const o of OUTCOMES) {
      const e = BASE[o] * n; if (e === 0) continue;
      stat += (c[o] - e) * (c[o] - e) / e;
    }
    return { stat, df: 2, p: chi2sf(stat, 2), counts: c, n };
  }

  /* ---------- Wald–Wolfowitz runs test on decided sequence ---------- */
  function runsTest(rounds) {
    const seq = decided(rounds).map(r => r.o); // D/T only
    const n = seq.length; if (n < 20) return null;
    const n1 = seq.filter(s => s === 'D').length, n2 = n - n1;
    if (n1 === 0 || n2 === 0) return null;
    let runs = 1;
    for (let i = 1; i < n; i++) if (seq[i] !== seq[i - 1]) runs++;
    const mu = 2 * n1 * n2 / n + 1;
    const varr = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
    const z = (runs - mu) / Math.sqrt(varr);
    const p = 2 * normSF(Math.abs(z)); // two-sided
    return { runs, expected: mu, z, p, n1, n2 };
  }

  /* ---------- entropy ---------- */
  function entropyBits(p) {
    let h = 0;
    for (const k in p) { const q = p[k]; if (q > 0) h -= q * Math.log2(q); }
    return h;
  }
  const BASE_ENTROPY = entropyBits(BASE); // ~1.3998 bits

  /* ---------- streaks (on decided D/T subsequence) ---------- */
  function streaks(rounds) {
    const seq = decided(rounds).map(r => r.o);
    const list = [];
    let cur = null, len = 0;
    for (const s of seq) {
      if (s === cur) len++;
      else { if (cur) list.push({ side: cur, len }); cur = s; len = 1; }
    }
    if (cur) list.push({ side: cur, len });
    let maxD = 0, maxT = 0, curRun = 0, curSide = null;
    for (const st of list) {
      if (st.side === 'D') maxD = Math.max(maxD, st.len); else maxT = Math.max(maxT, st.len);
    }
    if (seq.length) { curSide = seq[seq.length - 1]; curRun = 1; for (let i = seq.length - 2; i >= 0 && seq[i] === curSide; i--) curRun++; }
    const n = seq.length;
    return {
      list, maxD, maxT, current: { side: curSide, len: curRun },
      expectedMax: n > 0 ? Math.log2(n) + 0.3327 : 0, // E[max run] of fair coin, Schilling (1990) approx
      nDecided: n
    };
  }

  /* ---------- P0: exact base rate ---------- */
  function P0() { return { D: BASE.D, T: BASE.T, X: BASE.X }; }

  /* ---------- P1: Bayesian adaptive (Dirichlet, theory-seeded) ---------- */
  function P1(rounds, priorScale) {
    const s = priorScale || 300;
    const pr = { D: BASE.D * s, T: BASE.T * s, X: BASE.X * s };
    const c = counts(rounds), n = rounds.length;
    const a0 = s + n;
    return {
      D: (pr.D + c.D) / a0, T: (pr.T + c.T) / a0, X: (pr.X + c.X) / a0,
      credible: OUTCOMES.map(o => wilsonCI(c[o], Math.max(1, n), 1.96)),
      n
    };
  }

  /* ---------- P2: Markov-k with likelihood-ratio gate ---------- */
  function markovTable(rounds, k) {
    const rows = {}; // ctx string -> {D,T,X}
    const h = rounds.map(r => r.o);
    for (let i = k; i < h.length; i++) {
      const ctx = h.slice(i - k, i).join('');
      if (ctx.includes('X')) continue;          // ties break context
      const row = rows[ctx] || (rows[ctx] = { D: 0, T: 0, X: 0, n: 0 });
      row[h[i]]++; row.n++;
    }
    return rows;
  }
  function markovGTest(rounds, k) {
    const rows = markovTable(rounds, k);
    const ctxs = Object.keys(rows).filter(c => rows[c].n >= 5);
    if (ctxs.length < 2) return { ok: false, reason: 'insufficient context rows' };
    const colTot = { D: 0, T: 0, X: 0 }; let grand = 0;
    for (const c of ctxs) for (const o of OUTCOMES) { colTot[o] += rows[c][o]; grand += rows[c][o]; }
    if (grand < 60) return { ok: false, reason: 'insufficient data (<60 obs)' };
    let G = 0, df = (ctxs.length - 1) * (OUTCOMES.length - 1);
    for (const c of ctxs) for (const o of OUTCOMES) {
      const obs = rows[c][o]; if (obs === 0) continue;
      const exp = rows[c].n * colTot[o] / grand; if (exp <= 0) continue;
      G += 2 * obs * Math.log(obs / exp);
    }
    return { ok: true, G, df, p: chi2sf(G, df), rows, ctxs };
  }
  const P2_GATE_ALPHA = 0.01 / 3; // Bonferroni over depths 1..3
  function P2(rounds, maxDepth) {
    maxDepth = maxDepth || 3;
    let best = null;
    for (let k = 1; k <= maxDepth; k++) {
      const t = markovGTest(rounds, k);
      if (t.ok && t.p < P2_GATE_ALPHA && (!best || t.p < best.p)) best = { k, ...t };
    }
    if (!best) return { active: false, gate: 'Pattern gate NOT passed — no exploitable pattern (expected on fair RNG)' };
    // predict from the deepest significant table with Laplace smoothing
    const k = best.k, rows = best.rows;
    const ctx = rounds.slice(-k).map(r => r.o).join('');
    const row = rows[ctx];
    if (!row) return { active: false, gate: 'current context unseen' };
    const a0 = row.n + 3;
    return {
      active: true, k,
      gate: `Pattern gate PASSED at depth ${k} (p=${best.p.toExponential(2)}) — treat with suspicion, verify out-of-sample`,
      probs: { D: (row.D + 1) / a0, T: (row.T + 1) / a0, X: (row.X + 1) / a0 }
    };
  }
  function P2gates(rounds, maxDepth) {
    const out = [];
    for (let k = 1; k <= (maxDepth || 3); k++) {
      const t = markovGTest(rounds, k);
      out.push(t.ok ? { k, G: t.G, df: t.df, p: t.p, fired: t.p < P2_GATE_ALPHA } : { k, fired: false, note: t.reason });
    }
    return out;
  }

  /* ---------- scoring ---------- */
  function loglossOne(q, o) { return -Math.log(Math.max(1e-15, q[o])); }
  function brierOne(q, o) { let s = 0; for (const x of OUTCOMES) s += (q[x] - (x === o ? 1 : 0)) ** 2; return s; }

  // rolling out-of-sample evaluation of each model over the last `window` rounds.
  // histCap limits how much history each per-round prediction sees (recent window),
  // keeping evaluation O(window × histCap) — instant even with 100k+ stored rounds.
  function evaluateModels(rounds, window, histCap) {
    window = window || 200;
    histCap = histCap || 2000;
    const n = rounds.length;
    if (n < 30) return { ready: false, reason: 'need ≥30 rounds' };
    const start = Math.max(1, n - window);
    const agg = { P0: 0, P1: 0, P2: 0 }, cnt = { P0: 0, P1: 0, P2: 0 };
    const brier = { P0: 0, P1: 0, P2: 0 };
    let p2ActiveRounds = 0;
    for (let i = start; i < n; i++) {
      const lo = Math.max(0, i - histCap);
      const hist = lo === 0 ? rounds.slice(0, i) : rounds.slice(lo, i);
      const actual = rounds[i].o;
      const q0 = P0();
      const q1 = P1(hist);
      agg.P0 += loglossOne(q0, actual); brier.P0 += brierOne(q0, actual); cnt.P0++;
      agg.P1 += loglossOne(q1, actual); brier.P1 += brierOne(q1, actual); cnt.P1++;
      const m2 = P2(hist);
      const q2 = m2.active ? m2.probs : P0();
      if (m2.active) p2ActiveRounds++;
      agg.P2 += loglossOne(q2, actual); brier.P2 += brierOne(q2, actual); cnt.P2++;
    }
    const out = { ready: true, nEval: cnt.P0, p2ActiveRounds, models: {} };
    for (const m of ['P0', 'P1', 'P2']) out.models[m] = { logloss: agg[m] / cnt[m], brier: brier[m] / cnt[m] };
    out.best = Object.keys(out.models).reduce((a, b) => out.models[a].logloss <= out.models[b].logloss ? a : b);
    return out;
  }

  // calibration of predicted P(Dragon) vs observed, 5 buckets
  function calibration(rounds, window, histCap) {
    window = window || 300;
    histCap = histCap || 2000;
    const n = rounds.length; if (n < 40) return null;
    const start = Math.max(1, n - window);
    const buckets = [[0, .44], [.44, .46], [.46, .48], [.48, .50], [.50, 1.01]].map(([lo, hi]) => ({ lo, hi, k: 0, n: 0 }));
    for (let i = start; i < n; i++) {
      const lo = Math.max(0, i - histCap);
      const q = P1(lo === 0 ? rounds.slice(0, i) : rounds.slice(lo, i)); // score the adaptive model (the interesting one)
      const b = buckets.find(b => q.D >= b.lo && q.D < b.hi); if (!b) continue;
      b.n++; if (rounds[i].o === 'D') b.k++;
    }
    return buckets.filter(b => b.n > 0).map(b => ({ ...b, obs: b.k / b.n }));
  }

  /* ---------- SPRT: sequential fairness test on decided rounds ---------- */
  function sprt(rounds, delta, alpha, beta) {
    delta = delta || 0.02; alpha = alpha || 0.01; beta = beta || 0.01;
    const seq = decided(rounds).map(r => r.o === 'D' ? 1 : 0);
    const n = seq.length, k = seq.reduce((a, b) => a + b, 0);
    if (n < 10) return { status: 'need-data', k, n, delta, alpha, beta };
    const p0 = 0.5, p1U = p0 + delta, p1L = p0 - delta;
    const lnA = Math.log((1 - beta) / alpha), lnB = Math.log(beta / (1 - alpha));
    const llrU = k * Math.log(p1U / p0) + (n - k) * Math.log((1 - p1U) / (1 - p0));
    const llrL = k * Math.log(p1L / p0) + (n - k) * Math.log((1 - p1L) / (1 - p0));
    let status = 'continue';
    if (llrU >= lnA) status = 'biased-dragon';
    else if (llrL >= lnA) status = 'biased-tiger';
    else if (llrU <= lnB || llrL <= lnB) status = 'fair';
    // rough expected n to conclude at |p-0.5|=delta (K-L divergence)
    const kl = 0.5 * Math.log(1 / (1 - 4 * delta * delta)); // symmetric KL for ±delta
    const estN = Math.ceil(lnA / kl);
    return { status, k, n, llrU, llrL, lnA, lnB, estN, delta, alpha, beta, pHat: k / n };
  }

  /* ---------- money math ---------- */
  function evPerUnit(q, bet) { // q: probabilities, bet: 'D'|'T'|'X'
    if (bet === 'X') return 8 * q.X - (1 - q.X);
    const w = bet === 'D' ? q.D : q.T, l = bet === 'D' ? q.T : q.D;
    return w - l - 0.5 * q.X;
  }
  function kellyGrid(q, bet) { // numeric Kelly for outcomes {+1, -1, -0.5}
    const r = bet === 'X'
      ? { X: 8, D: -1, T: -1 }
      : (bet === 'D' ? { D: 1, T: -1, X: -0.5 } : { T: 1, D: -1, X: -0.5 });
    let bestF = 0, bestG = 0;
    for (let i = 0; i <= 100; i++) {
      const f = i / 100; let g = 0;
      for (const o of OUTCOMES) if (q[o] > 0) g += q[o] * Math.log(1 + f * r[o]);
      if (g > bestG + 1e-12) { bestG = g; bestF = f; }
    }
    return { f: bestF, growth: bestG, ev: evPerUnit(q, bet) };
  }
  function riskOfRuinMonte(q, bet, bankroll, stake, roundsN, sims, rng) {
    sims = sims || 4000; rng = rng || Math.random;
    let ruined = 0; const finals = [];
    const w = bet === 'D' ? q.D : bet === 'T' ? q.T : q.X;
    const l = bet === 'D' ? q.T : bet === 'T' ? q.D : (1 - q.X);
    const half = bet === 'X' ? 0 : q.X; // tie returns half on D/T
    for (let s = 0; s < sims; s++) {
      let b = bankroll, alive = true;
      for (let i = 0; i < roundsN; i++) {
        const u = rng();
        if (u < w) b += stake;
        else if (u < w + half) b -= stake / 2;
        else b -= stake;
        if (b < stake) { alive = false; break; }
        if (b >= bankroll * 4) break;
      }
      if (!alive) ruined++;
      finals.push(b);
    }
    finals.sort((a, b) => a - b);
    return {
      ruinProb: ruined / sims,
      median: finals[Math.floor(sims / 2)],
      p05: finals[Math.floor(sims * 0.05)], p95: finals[Math.floor(sims * 0.95)]
    };
  }

  /* ---------- verdict / trust score ---------- */
  function verdict(rounds) {
    const n = rounds.length;
    const v = { n, checks: [], light: 'amber', score: null };
    if (n < 300) { v.note = 'need more rounds (300+) for a meaningful verdict'; return v; }
    const chi = chiSquareGOF(rounds), rt = runsTest(rounds), sp = sprt(rounds), gates = P2gates(rounds);
    let red = 0, penalty = 0;
    if (chi.p < 0.01) { red++; penalty += 25; }
    v.checks.push({ name: 'Chi-square (D/T/Tie vs theory)', value: `χ²=${chi.stat.toFixed(2)}, p=${chi.p.toFixed(4)}`, bad: chi.p < 0.01 });
    if (rt) { if (rt.p < 0.01) { red++; penalty += 20; } v.checks.push({ name: 'Runs test (independence)', value: `z=${rt.z.toFixed(2)}, p=${rt.p.toFixed(4)}`, bad: rt.p < 0.01 }); }
    if (sp.status.startsWith('biased')) { red += 2; penalty += 40; }
    v.checks.push({ name: 'SPRT (±2% drift)', value: sp.status === 'need-data' ? 'need data' : `${sp.status} (p̂=${sp.pHat.toFixed(4)})`, bad: sp.status.startsWith('biased') });
    const fired = gates.filter(g => g.fired);
    if (fired.length) { red += fired.length; penalty += 15 * fired.length; }
    v.checks.push({ name: 'Markov pattern gates', value: fired.length ? `FIRED at depth(s) ${fired.map(f => f.k).join(',')}` : 'not fired (as expected)', bad: fired.length > 0 });
    const c = counts(rounds), pD = c.D / n;
    const drift = Math.abs(pD - BASE.D);
    penalty += Math.max(0, (drift - 0.01)) * 800; // gentle drift penalty
    v.score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
    v.light = red === 0 ? 'green' : 'red';
    v.note = red === 0
      ? `All independence/fairness checks passed over ${n} rounds — statistically consistent with a fair RNG. (Green ≠ beatable; it means exactly 50/50 odds.)`
      : `${red} check(s) deviate from randomness — treat this game with suspicion.`;
    return v;
  }

  /* ---------- Deck Check: rank uniformity from real card data ---------- */
  const RANK_NAMES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  function rankUniformity(rounds) {
    const counts = {}; let n = 0;
    for (const r of rounds) {
      if (r && r.d && r.t) { counts[r.d] = (counts[r.d] || 0) + 1; counts[r.t] = (counts[r.t] || 0) + 1; n += 2; }
    }
    if (n < 52) return { ready: false, have: n, need: 52 - n };
    const exp = n / 13; let stat = 0;
    for (const k of RANK_NAMES) { const o = counts[k] || 0; stat += (o - exp) * (o - exp) / exp; }
    let dSum = 0, tSum = 0, pairs = 0;
    const RV = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
    for (const r of rounds) if (r && r.d && r.t && RV[r.d] && RV[r.t]) { dSum += RV[r.d]; tSum += RV[r.t]; pairs++; }
    return {
      ready: true, n, stat, df: 12, p: chi2sf(stat, 12), counts,
      expected: exp, pairs,
      dragonAvg: pairs ? (dSum / pairs) : null, tigerAvg: pairs ? (tSum / pairs) : null
    };
  }

  /* ---------- bankroll advisor (virtual chips; not an edge claim) ---------- */
  function niceChip(x) {
    x = +x;
    if (!(x > 0) || !isFinite(x)) return 1;
    if (x <= 1) return 1;
    if (x < 5) return Math.max(1, Math.round(x));
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    const n = x / mag;
    let f;
    if (n <= 1.25) f = 1;
    else if (n <= 1.75) f = 1.5;
    else if (n <= 2.5) f = 2;
    else if (n <= 3.5) f = 3;
    else if (n <= 7.5) f = 5;
    else f = 10;
    return Math.max(1, Math.round(f * mag));
  }

  function simAdvisor(state, ctx) {
    state = state || {};
    ctx = ctx || {};
    const mode = state.mode === 'risk' ? 'risk' : 'stable';
    const bank = Math.max(0, Math.floor(+state.bank || 0));
    const start = Math.max(1, Math.floor(+state.startBank || bank || 1));
    const peak = Math.max(bank, Math.floor(+state.peak || bank));
    const lossRun = Math.max(0, Math.floor(+state.lossRun || 0));
    const winRun = Math.max(0, Math.floor(+state.winRun || 0));
    let grindU = Math.max(1, Math.min(4, Math.floor(+state.grindU || 1)));
    const pick = (ctx.pick === 'D' || ctx.pick === 'T') ? ctx.pick : null;
    const agree = !!ctx.agree;
    const decidedN = Math.max(0, Math.floor(+ctx.decidedN || 0));
    const dd = peak > 0 ? (peak - bank) / peak : 0;
    const empty = function (why, unit) {
      return { action: 'WAIT', side: pick, stake: 0, why: why, unit: unit || 0, mode: mode, grindU: grindU, mult: 1 };
    };
    if (bank < 1) return empty('Bankroll empty', 0);
    if (decidedN < 7 || !pick) {
      return empty(decidedN < 7 ? ('Need ' + (7 - decidedN) + ' decided') : 'No call yet — fill a clean 7', 0);
    }
    if (mode === 'stable') {
      let unit = niceChip(start * 0.01);
      if (bank < start * 0.65) unit = niceChip(Math.max(1, bank * 0.012));
      unit = Math.max(1, Math.min(unit, Math.max(1, Math.floor(bank * 0.03))));
      if (unit > bank) return empty('Bankroll below 1 unit', unit);
      if (lossRun >= 3) return empty('Cool-off after 3 losses', unit);
      if (dd >= 0.28 && lossRun >= 1) return empty('Drawdown pause', unit);
      if (!agree) grindU = 1;
      const hole = Math.max(0, start - bank);
      let stake = grindU * unit;
      if (hole > 0) stake = Math.min(stake, hole + unit);
      const cap = Math.max(unit, Math.floor(bank * 0.04));
      stake = Math.min(stake, cap, bank);
      stake = Math.max(1, Math.floor(stake));
      let why;
      if (hole > 0) why = 'Recovery · ' + grindU + 'u';
      else if (agree) why = 'Aligned · 1u grind';
      else why = 'Base unit';
      return { action: 'BET', side: pick, stake: stake, why: why, unit: unit, mode: mode, grindU: grindU, mult: grindU };
    }
    let unit = niceChip(start * 0.035);
    if (bank < start * 0.55) unit = niceChip(Math.max(1, bank * 0.03));
    unit = Math.max(1, Math.min(unit, Math.max(1, Math.floor(bank * 0.08))));
    if (unit > bank) return empty('Bankroll below 1 unit', unit);
    if (lossRun >= 4) return empty('Forced pause after 4 losses', unit);
    let mult = 1;
    if (agree && winRun === 1) mult = 2;
    else if (agree && winRun === 2) mult = 4;
    let stake = mult * unit;
    const cap = Math.max(unit, Math.floor(bank * 0.12));
    stake = Math.min(stake, cap, bank);
    stake = Math.max(1, Math.floor(stake));
    const why = mult > 1 ? ('Press ×' + mult) : (agree ? 'Risk unit · aligned' : 'Risk unit');
    return { action: 'BET', side: pick, stake: stake, why: why, unit: unit, mode: mode, grindU: 1, mult: mult };
  }

  /* ---------- exports ---------- */
  return {
    BASE, OUTCOMES, BASE_LOGLOSS, BASE_ENTROPY, EDGE_DT, DIRICHLET_PRIOR, RANK_NAMES,
    mulberry32, lgamma, gammp, gammaq, chi2sf, normSF,
    wilsonCI, counts, decided, chiSquareGOF, runsTest, entropyBits, streaks,
    P0, P1, P2, P2gates, markovGTest, markovTable,
    evaluateModels, calibration, loglossOne, brierOne, rankUniformity,
    sprt, evPerUnit, kellyGrid, riskOfRuinMonte, verdict,
    niceChip, simAdvisor
  };
});
