// Stage-2 audit experiment: Jev re-checks ONLY the pairs its watch layer flagged,
// given the deterministic tracker's CPA numbers + the exact separation rule.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const win = readFileSync('/tmp/window.jsonl','utf8').trim().split('\n').map(JSON.parse);
const flagged = readFileSync('/tmp/exp_base.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(r => r.p > 0.5);
const tsKey = readFileSync('/tmp/ts_key.txt','utf8').trim();
const N = Math.min(win.length, 60);

const byTick = {};
for (const f of flagged) (byTick[f.tick] ||= []).push(f);

writeFileSync('/tmp/exp_audit.jsonl', '');
const lat = [];
for (let i = 0; i < N; i++) {
  const fl = byTick[i] || [];
  if (!fl.length) continue;
  const pairs = win[i].pairs.filter(p => fl.some(f => f.pair === `${p.a}|${p.b}`));
  const questions = {};
  for (const p of pairs) questions[`audit_${p.a}_${p.b}`] = { type: 'noul',
    instructions: 'Strict audit. A deterministic tracker computed this pair\'s closest point of approach: cpa_nm (lateral), cpa_ft (vertical), reached in cpa_sec seconds, with current separation horiz_nm_now and vert_ft_now. Separation is lost ONLY IF cpa_nm < 3 AND cpa_ft < 1000 AND cpa_sec <= 120. Treat the tracker\'s numbers as exact. Is separation lost for this pair?',
    criteria: { true: 'cpa_nm < 3 AND cpa_ft < 1000 AND cpa_sec <= 120 all hold', false: 'at least one condition fails' } };
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
      headers: { authorization: `Bearer ${tsKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: { audit: 'verify deterministic CPA computations against the separation rule', pairs: pairs.map(p => ({ a: p.a, b: p.b, cpa_nm: +p.cpaNm.toFixed(2), cpa_ft: Math.round(p.cpaFt), cpa_sec: p.tSec, horiz_nm_now: +p.hNmNow.toFixed(2), vert_ft_now: Math.round(p.vFtNow) })) }, model: 'jev-latest', questions }),
      signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('ts ' + res.status);
    const j = await res.json();
    lat.push(Date.now() - t0);
    for (const p of pairs) {
      const prob = j.answers[`audit_${p.a}_${p.b}`]?.noul;
      if (prob == null) continue;
      const truth = (p.cpaNm < 3 && p.cpaFt < 1000 && p.tSec <= 120) ? 1 : 0;
      appendFileSync('/tmp/exp_audit.jsonl', JSON.stringify({ tick: i, pair: `${p.a}|${p.b}`, p: prob, truth }) + '\n');
    }
  } catch (e) { console.log('tick', i, 'err', String(e).slice(0, 80)); }
  if ((i + 1) % 20 === 0) console.log('audited', i + 1, '/', N);
}
console.log('audit avg_ms', lat.length ? Math.round(lat.reduce((a,b)=>a+b,0)/lat.length) : 0);

const rows = readFileSync('/tmp/exp_audit.jsonl','utf8').trim().split('\n').map(JSON.parse);
console.log('\nthr,flags,tp,fp,fn');
for (const thr of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  let tp = 0, fp = 0, fn = 0, flags = 0;
  for (const r of rows) {
    const flag = r.p > thr;
    if (flag) flags++;
    if (r.truth) { flag ? tp++ : fn++; } else if (flag) fp++;
  }
  console.log([thr, flags, tp, fp, fn].join(','));
}
