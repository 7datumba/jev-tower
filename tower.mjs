// LLM tower vs Jev on the IDENTICAL recorded traffic window.
// Ground truth: deterministic CPA rule (loss of separation = cpa < 3nm and < 1000ft within 120s).
import { readFileSync } from 'node:fs';
const win = readFileSync(process.argv[2] || '/tmp/window.jsonl','utf8').trim().split('\n').map(JSON.parse);
const oaiKey = readFileSync('/tmp/oai_key.txt','utf8').trim();
const antKey = (() => { try { return readFileSync('/tmp/ant_key.txt','utf8').trim(); } catch { return null; } })();
const BACKEND = process.env.TOWER_BACKEND || 'openai';
const tsKey = readFileSync('/tmp/ts_key.txt','utf8').trim();

const truth = p => (p.cpaNm < 3 && p.cpaFt < 1000 && p.tSec <= 120);
const jevCaught = p => p.p != null && p.p > 0.5;

async function jevTick(pairs) {
  const questions = {};
  for (const p of pairs) questions[`conflict_${p.a}_${p.b}`] = { type: 'noul',
    instructions: 'Will these two aircraft violate standard ATC separation (3 NM laterally and 1000 ft vertically) within 2 minutes, given their current positions, altitudes, headings, speeds and vertical rates?',
    criteria: { true: 'Separation will be lost within 2 minutes without action', false: 'Separation will be maintained' } };
  const t0 = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    headers: { authorization: `Bearer ${tsKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: { airspace: 'SF Bay Area live ADS-B', pairs: pairs.map(p=>({a:p.a,b:p.b,cpa_nm:p.cpaNm,cpa_ft:p.cpaFt,cpa_sec:p.tSec,horiz_nm_now:+p.hNmNow.toFixed(2),vert_ft_now:Math.round(p.vFtNow)})) }, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('ts '+res.status);
  const j = await res.json();
  return { ms: Date.now()-t0, answers: j.answers, usage: j.usage };
}

async function llmTick(pairs) {
  const prompt = `You are an air traffic controller watching SF Bay airspace. For each aircraft pair, judge: will they violate standard separation (3 NM lateral AND 1000 ft vertical) within 2 minutes? Pairs (cpa_nm=closest point of approach in nautical miles, cpa_ft=vertical separation at CPA, cpa_sec=seconds to CPA, horiz_nm_now=current lateral separation, vert_ft_now=current vertical separation):\n${JSON.stringify(pairs.map(p=>({a:p.a,b:p.b,cpa_nm:+p.cpaNm.toFixed(2),cpa_ft:Math.round(p.cpaFt),cpa_sec:p.tSec,horiz_nm_now:+p.hNmNow.toFixed(2),vert_ft_now:Math.round(p.vFtNow)})))}\nReply ONLY JSON: {"verdicts":[{"pair":"A_B","probability":0.0-1.0}]}`;
  const t0 = Date.now();
  if (BACKEND === 'anthropic') {
    if (!antKey) throw new Error('no /tmp/ant_key.txt');
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': antKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.TOWER_LLM_MODEL || 'claude-opus-5-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('ant '+res.status+' '+(await res.text()).slice(0,150));
    const j = await res.json();
    const txt = j.content.filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '');
    const parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    return { ms: Date.now()-t0, verdicts: parsed.verdicts, usage: { prompt_tokens: j.usage?.input_tokens, completion_tokens: j.usage?.output_tokens } };
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
    headers: { authorization: `Bearer ${oaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TOWER_LLM_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0 }),
    signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('oai '+res.status+' '+(await res.text()).slice(0,150));
  const j = await res.json();
  const parsed = JSON.parse(j.choices[0].message.content);
  return { ms: Date.now()-t0, verdicts: parsed.verdicts, usage: j.usage };
}

const N = Math.min(win.length, parseInt(process.argv[3] || '30'));
const stats = { jev: { ms: [], caught: 0, total: 0, tp: 0, fp: 0, fn: 0, tok: 0 }, llm: { ms: [], caught: 0, total: 0, tp: 0, fp: 0, fn: 0, tok: 0 } };
for (let i = 0; i < N; i++) {
  const { pairs } = win[i];
  try {
    const r = await jevTick(pairs);
    stats.jev.ms.push(r.ms); stats.jev.tok += r.usage?.input_tokens || 0;
    for (const p of pairs) { stats.jev.total++; const prob = r.answers[`conflict_${p.a}_${p.b}`]?.noul; const c = prob > 0.5; if (c) stats.jev.caught++;
      if (truth(p)) { c ? stats.jev.tp++ : stats.jev.fn++; } else if (c) stats.jev.fp++; }
  } catch (e) { console.log('jev err', String(e).slice(0,80)); }
  try {
    const r = await llmTick(pairs);
    stats.llm.ms.push(r.ms); stats.llm.tok += (r.usage?.prompt_tokens || 0) + (r.usage?.completion_tokens || 0);
    const vmap = {}; for (const v of r.verdicts || []) vmap[v.pair] = v.probability;
    for (const p of pairs) { stats.llm.total++; const prob = vmap[`${p.a}_${p.b}`]; const c = prob > 0.5; if (c) stats.llm.caught++;
      if (truth(p)) { c ? stats.llm.tp++ : stats.llm.fn++; } else if (c) stats.llm.fp++; }
  } catch (e) { console.log('llm err', String(e).slice(0,80)); }
  if ((i+1) % 10 === 0) console.log('tick', i+1, '/', N);
}
const avg = a => a.length ? Math.round(a.reduce((x,y)=>x+y,0)/a.length) : 0;
const mx = a => a.length ? Math.max(...a) : 0;
console.log(JSON.stringify({
  ticks: N,
  jev: { avg_ms: avg(stats.jev.ms), max_ms: mx(stats.jev.ms), conflicts_flagged: stats.jev.caught, true_positives: stats.jev.tp, false_positives: stats.jev.fp, missed: stats.jev.fn, input_tokens: stats.jev.tok },
  llm: { avg_ms: avg(stats.llm.ms), max_ms: mx(stats.llm.ms), conflicts_flagged: stats.llm.caught, true_positives: stats.llm.tp, false_positives: stats.llm.fp, missed: stats.llm.fn, total_tokens: stats.llm.tok },
}, null, 1));
