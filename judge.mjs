// Judge adapter: mock (offline dev) and jev (direct TypeSafe API).
// One batched call per tick: noul conflict watch + risk score for every candidate pair,
// plus a reroute choice only when the deterministic vet confirmed the top pair
// (server sets p.vetConfirmed before calling).

export function makeMockJudge() {
  return async function judge(pairsCtx) {
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
    const answers = {};
    for (const p of pairsCtx) {
      const riskN = Math.max(0, Math.min(1, 1 - p.cpaNm / 3.2)) * Math.max(0.2, Math.min(1, 1 - p.tSec / 180));
      answers[`conflict_${p.a}_${p.b}`] = { type: 'noul', noul: 0.35 + riskN * 0.4 };
      const lvl = Math.min(4, Math.floor(riskN * 5));
      answers[`risk_${p.a}_${p.b}`] = { type: 'score', score: lvl, probabilities: { [lvl]: 0.8 }, confidence: 0.7 };
      if (p.vetConfirmed) answers[`reroute_${p.a}`] = { type: 'choice', choice: 'turn_left_30', probabilities: { turn_left_30: 0.4, turn_right_30: 0.3, climb_1000: 0.2, descend_1000: 0.1 }, confidence: 0.6 };
    }
    return { ms: Date.now() - t0, answers, usage: { input_tokens: pairsCtx.length * 220, output_tokens: pairsCtx.length * 20 }, mock: true };
  };
}

export function makeJevJudge(apiKey) {
  return async function judge(pairsCtx) {
    const questions = {};
    for (const p of pairsCtx) {
      questions[`conflict_${p.a}_${p.b}`] = {
        type: 'noul',
        instructions: 'Will these two aircraft violate standard ATC separation (3 NM laterally and 1000 ft vertically) within 2 minutes, given their current positions, altitudes, headings, speeds and vertical rates?',
        criteria: { true: 'Separation will be lost within 2 minutes without action', false: 'Separation will be maintained' },
      };
      questions[`risk_${p.a}_${p.b}`] = {
        type: 'score',
        instructions: 'Rate the collision risk between this aircraft pair as an air traffic controller would.',
        criteria: ['none: diverging or well separated', 'low: converging but ample margin', 'moderate: closing, needs monitoring', 'high: separation likely to be lost without action', 'imminent: loss of separation underway'],
      };
    }
    const topConfirmed = pairsCtx.find(p => p.vetConfirmed);
    if (topConfirmed) questions[`reroute_${topConfirmed.a}`] = {
      type: 'choice',
      instructions: `Pick the safest immediate instruction for ${topConfirmed.a} to resolve the conflict with ${topConfirmed.b}. Consider their relative geometry, altitudes and speeds.`,
      criteria: { turn_left_30: 'Turn 30 degrees left', turn_right_30: 'Turn 30 degrees right', climb_1000: 'Climb 1000 ft', descend_1000: 'Descend 1000 ft', maintain: 'Maintain current heading and altitude' },
    };
    const state = { airspace: 'SF Bay Area (SFO/OAK/SJC), live ADS-B tracks', pairs: pairsCtx.map(p => ({ a: p.a, b: p.b, cpa_nm: +p.cpaNm.toFixed(2), cpa_ft: Math.round(p.cpaFt), cpa_sec: p.tSec, horiz_nm_now: +p.hNmNow.toFixed(2), vert_ft_now: Math.round(p.vFtNow), closing_kt: p.closingKt || 0 })) };
    const t0 = Date.now();
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: 'jev-latest', questions }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0,200)}`);
    const j = await res.json();
    return { ms: Date.now() - t0, answers: j.answers, usage: j.usage, mock: false };
  };
}
