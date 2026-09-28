// FP-reduction experiment: 2 Jev question variants over the identical 60-tick window,
// raw noul probabilities recorded, then OFFLINE sweep of threshold x persistence.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const win = readFileSync('/tmp/window.jsonl','utf8').trim().split('\n').map(JSON.parse);
const tsKey = readFileSync('/tmp/ts_key.txt','utf8').trim();
const truth = p => (p.cpaNm < 3 && p.cpaFt < 1000 && p.tSec <= 120);
const N = Math.min(win.length, 60);

const variants = {
  base: {
    instructions: 'Will these two aircraft violate standard ATC separation (3 NM laterally and 1000 ft vertically) within 2 minutes, given their current positions, altitudes, headings, speeds and vertical rates?',
    criteria: { true: 'Separation will be lost within 2 minutes without action', false: 'Separation will be maintained' },
    extra: p => ({}),
  },
  rich: {
    instructions: 'You are auditing a deterministic closest-point-of-approach (CPA) calculation for an ATC separation watch. Loss of separation means lateral CPA under 3 NM AND vertical separation at CPA under 1000 ft, reached within 120 seconds. Given the computed CPA values, current separation, vertical rates and closing speed for this pair, will separation ACTUALLY be lost within 2 minutes? Answer true only when the geometry genuinely supports it; answer false when margins are comfortable, the pair is diverging, or vertical separation stays above 1000 ft.',
    criteria: { true: 'Geometry shows separation will be lost within 2 minutes', false: 'Margins hold: diverging, vertical separation sufficient, or CPA outside the gates' },
    extra: p => ({ closing_kt: p.closingKt || 0, trend: (p.closingKt||0) > 20 ? 'closing' : (p.closingKt||0) < -20 ? 'diverging' : 'steady' }),
  },
};

async function jevTick(pairs, v) {
  const questions = {};
  for (const p of pairs) questions[`conflict_${p.a}_${p.b}`] = { type: 'noul', instructions: v.instructions, criteria: v.criteria };
  const t0 = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    headers: { authorization: `Bearer ${tsKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: { airspace: 'SF Bay Area live ADS-B', pairs: pairs.map(p => ({ a: p.a, b: p.b, cpa_nm: +p.cpaNm.toFixed(2), cpa_ft: Math.round(p.cpaFt), cpa_sec: p.tSec, horiz_nm_now: +p.hNmNow.toFixed(2), vert_ft_now: Math.round(p.vFtNow), ...v.extra(p) })) }, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('ts ' + res.status);
  const j = await res.json();
  return { ms: Date.now() - t0, answers: j.answers };
}

const PHASE = process.argv[2] || 'all';
if (PHASE === 'record' || PHASE === 'all') {
  for (const [name, v] of Object.entries(variants)) {
    const out = `/tmp/exp_${name}.jsonl`;
    writeFileSync(out, '');
    const lat = [];
    for (let i = 0; i < N; i++) {
      const { pairs } = win[i];
      try {
        const r = await jevTick(pairs, v);
        lat.push(r.ms);
        for (const p of pairs) {
          const prob = r.answers[`conflict_${p.a}_${p.b}`]?.noul;
          if (prob == null) continue;
          appendFileSync(out, JSON.stringify({ tick: i, pair: `${p.a}|${p.b}`, p: prob, truth: truth(p) ? 1 : 0 }) + '\n');
        }
      } catch (e) { console.log(name, 'tick', i, 'err', String(e).slice(0, 80)); }
      if ((i + 1) % 20 === 0) console.log(name, 'recorded', i + 1, '/', N);
    }
    console.log(name, 'avg_ms', lat.length ? Math.round(lat.reduce((a,b)=>a+b,0)/lat.length) : 0);
  }
}

// ---- offline sweep ----
function load(name) {
  const rows = readFileSync(`/tmp/exp_${name}.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
  const byPair = {};
  for (const r of rows) (byPair[r.pair] ||= []).push(r);
  for (const k in byPair) byPair[k].sort((a, b) => a.tick - b.tick);
  return byPair;
}
function evalConfig(byPair, thr, persist) {
  let tp = 0, fp = 0, fn = 0, flags = 0;
  for (const k in byPair) {
    let streak = 0;
    for (const r of byPair[k]) {
      streak = r.p > thr ? streak + 1 : 0;
      const flag = streak >= persist;
      if (flag) flags++;
      if (r.truth) { flag ? tp++ : fn++; } else if (flag) fp++;
    }
  }
  return { flags, tp, fp, fn };
}
console.log('\nvariant,thr,persist,flags,tp,fp,fn');
for (const name of Object.keys(variants)) {
  if (!existsSync(`/tmp/exp_${name}.jsonl`)) continue;
  const byPair = load(name);
  for (const thr of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95])
    for (const persist of [1, 2, 3]) {
      const r = evalConfig(byPair, thr, persist);
      console.log([name, thr, persist, r.flags, r.tp, r.fp, r.fn].join(','));
    }
}
