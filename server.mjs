// JEV TOWER - live air traffic control judgments over the SF Bay.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { makeFeed, makeReplayFeed } from './feed.mjs';
import { findCandidates, conflictProb, classifyPair } from './geo.mjs';
import { makeMockJudge, makeJevJudge } from './judge.mjs';

const MODE = process.env.JUDGE || 'mock';
const judge = MODE === 'jev' ? makeJevJudge(process.env.TYPESAFE_API_KEY) : makeMockJudge();
const feed = process.env.FEED === 'replay'
  ? makeReplayFeed(process.env.REPLAY_FILE || '/tmp/feed-record.jsonl', onTick, +(process.env.REPLAY_SPEED || 1))
  : makeFeed(onTick, { recordPath: process.env.RECORD_PATH || null });

const state = {
  tracks: [], candidates: [], pairInfo: {}, judgments: [], reroutes: [],
  metrics: { ticks: 0, judgedTicks: 0, totalJudgments: 0, latencies: [], watchFlags: 0, conflicts: 0, nearMissesAvoided: 0, inputTokens: 0, startedAt: Date.now(), feedStale: false, mode: MODE, replay: process.env.FEED === 'replay', replaySpeed: +(process.env.REPLAY_SPEED || 1) },
};

async function onTick({ tracks, stale }) {
  state.tracks = tracks; state.metrics.ticks++; state.metrics.feedStale = !!stale;
  const byId = {}; for (const t of tracks) byId[t.id] = t;
  const all = findCandidates(tracks);
  for (const c of all) {
    const cls = (byId[c.a] && byId[c.b]) ? classifyPair(byId[c.a], byId[c.b], c) : { kind: 'normal', field: null };
    c.kind = cls.kind; c.field = cls.field;
  }
  all.sort((p, q) => ((p.kind === 'normal' ? 0 : 1) - (q.kind === 'normal' ? 0 : 1)) || p.cpaNm - q.cpaNm); // judge real conflicts first
  const cands = all.slice(0, 12);
  for (const c of cands) {
    c.vetConfirmed = (c.kind === 'normal') && (c.cpaNm < 3 && c.cpaFt < 1000 && c.tSec <= 120); // deterministic separation vet
    try { c.physP = (byId[c.a] && byId[c.b]) ? conflictProb(byId[c.a], byId[c.b]).p : null; } catch { c.physP = null; }
  }
  state.candidates = cands;
  if (!cands.length) { prunePairInfo(); return; }
  try {
    const r = await judge(cands);
    state.metrics.judgedTicks++;
    const n = Object.keys(r.answers).length;
    state.metrics.totalJudgments += n;
    state.metrics.inputTokens += r.usage?.input_tokens || 0;
    state.metrics.latencies.push(r.ms); if (state.metrics.latencies.length > 600) state.metrics.latencies.shift();
    for (const c of cands) {
      const key = c.a + '|' + c.b;
      const conflict = r.answers[`conflict_${c.a}_${c.b}`];
      const risk = r.answers[`risk_${c.a}_${c.b}`];
      const rr = r.answers[`reroute_${c.a}`];
      const watchP = conflict && conflict.noul != null ? +conflict.noul.toFixed(3) : null;
      const confirmed = !!c.vetConfirmed; // deterministic vet, not a model call
      if (watchP != null && watchP > 0.5) state.metrics.watchFlags++;
      state.pairInfo[key] = {
        at: Date.now(), a: c.a, b: c.b,
        cpaNm: +c.cpaNm.toFixed(2), cpaFt: Math.round(c.cpaFt), tSec: c.tSec,
        hNmNow: +c.hNmNow.toFixed(2), vFtNow: Math.round(c.vFtNow), closingKt: c.closingKt,
        p: watchP, confirmed, physP: c.physP ?? null, kind: c.kind, field: c.field,
        risk: risk ? { score: risk.score ?? null, probabilities: risk.probabilities || null, confidence: risk.confidence ?? null } : null,
        reroute: confirmed && rr ? { choice: rr.choice, probabilities: rr.probabilities || null } : null,
        ms: r.ms,
      };
      state.judgments.push({ at: Date.now(), a: c.a, b: c.b, cpaNm: +c.cpaNm.toFixed(2), tSec: c.tSec, kind: c.kind, p: watchP, confirmed, physP: c.physP ?? null, risk: risk?.score ?? null, ms: r.ms });
      if (confirmed) {
        state.metrics.conflicts++;
        if (rr) { state.metrics.nearMissesAvoided++; state.reroutes.push({ at: Date.now(), flight: c.a, action: rr.choice, p: rr.probabilities }); }
      }
    }
    prunePairInfo();
    if (state.judgments.length > 200) state.judgments.splice(0, state.judgments.length - 200);
    if (state.reroutes.length > 50) state.reroutes.splice(0, state.reroutes.length - 50);
  } catch (e) { state.lastError = String(e).slice(0, 200); }
}
function prunePairInfo() {
  const now = Date.now();
  for (const k in state.pairInfo) if (now - state.pairInfo[k].at > 20000) delete state.pairInfo[k];
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/state') {
    const lats = [...state.metrics.latencies].sort((a, b) => a - b);
    const pct = q => lats.length ? lats[Math.floor(q * (lats.length - 1))] : 0;
    const upMin = (Date.now() - state.metrics.startedAt) / 60000;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ...state,
      metrics: { ...state.metrics, latencies: undefined,
        p50: pct(0.5), p95: pct(0.95),
        judgmentsPerSec: upMin > 0 ? +(state.metrics.totalJudgments / (upMin * 60)).toFixed(1) : 0,
        costPerHour: +((state.metrics.inputTokens / Math.max(upMin / 60, 1e-9)) * 0.042 / 1e6 / (state.metrics.replay ? state.metrics.replaySpeed : 1)).toFixed(3) },
    }));
    return;
  }
  if (url.startsWith('/static/')) {
    try {
      const p = new URL('./public/' + url.slice(8), import.meta.url);
      const ext = p.pathname.slice(p.pathname.lastIndexOf('.'));
      res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
      res.end(await readFile(p));
    } catch { res.statusCode = 404; res.end('nope'); }
    return;
  }
  try { res.setHeader('content-type', 'text/html'); res.end(await readFile(new URL('./public/index.html', import.meta.url))); }
  catch { res.statusCode = 404; res.end('nope'); }
});
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => { feed.start(2000); console.log(`jev-tower on :${PORT} mode=${MODE} feed=${process.env.FEED || 'live'}`); });
