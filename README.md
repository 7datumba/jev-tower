# jev-tower

AI air traffic control over the San Francisco Bay. Live ADS-B aircraft tracks feed a control loop where **Jev** ([TypeSafe](https://typesafe.com)) judges conflict risk between aircraft pairs every 2 seconds, and deterministic physics (the 1980s MITRE / Paielli-Erzberger conflict-probability model) does the final vet before anything is called a hazard.

Runs entirely in an **E2B** sandbox. Zero-dependency Node for the tower itself (no npm install needed for local replay/mock).

![stack](https://img.shields.io/badge/judge-Jev%20(TypeSafe)-ff3001) ![sandbox](https://img.shields.io/badge/sandbox-E2B-ff3001)

---

## Quickstart (no API keys, ~10 seconds)

Plays back a recorded 5-minute slice of live Bay Area traffic with a mock judge:

```bash
git clone https://github.com/7datumba/jev-tower.git
cd jev-tower
JUDGE=mock FEED=replay REPLAY_SPEED=20 node server.mjs
# open http://localhost:8000
```

## With the real judge

```bash
export TYPESAFE_API_KEY=ts-...
# recorded traffic, real Jev judgments:
JUDGE=jev FEED=replay REPLAY_SPEED=20 node server.mjs

# live traffic (polls adsb.lol every 2s, free):
JUDGE=jev node server.mjs
```

## Model ladder comparison

Replays one recorded 60-tick window through Jev + three frontier models under identical conditions:

```bash
TYPESAFE_API_KEY=ts-... OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... node tower.mjs
```

## Deploy to an E2B sandbox

```bash
npm install        # only needed for the deploy scripts (e2b sdk)
E2B_API_KEY=e2b_... TYPESAFE_API_KEY=ts-... node deploy.mjs
E2B_API_KEY=e2b_... TYPESAFE_API_KEY=ts-... REPLAY_SPEED=20 node deploy-replay.mjs
# prints a public https://<host>.e2b.app URL; kill the sandbox when done
```

---

## What it does

1. **Feed** - ADS-B state vectors over the Bay (adsb.lol), 2s cadence.
2. **Candidate generation** - pairs within 10 nm / 3000 ft get a deterministic conflict-probability pre-filter (Paielli-Erzberger model with Brownian motion, 5-min horizon).
3. **Judge** - the top ~8 candidates are sent to Jev (small fine-tuned model, structured JSON out: risk score, reason, action).
4. **Vet** - the deterministic model confirms or vetoes each call. Only consensus survives to the hazard layer.
5. **Dashboard** - map, trails, risk-ranked candidates, hazard polygons, live judge console, cost/metrics panel.

## Measured results

Model ladder on one identical recorded window (60 ticks, ~2 minutes of live traffic), judge latency per batch of candidates:

| judge | avg latency | missed hazards | false positives |
|---|---|---|---|
| **Jev** (TypeSafe) | **103 ms** | 0 | 335 |
| gpt-4o-mini | 2,242 ms | 160 | 0 |
| gpt-4o | 2,356 ms | 56 | 1 |
| claude-opus-5-5 | 12,318 ms | 0 | 174 |

Raw data in `data/` (`tower_summary.json`, `tower_out_jev.json`, `exp_*.jsonl`).

Live-mode baseline (Jev): ~12.6 judgments/sec, p50 ~100 ms per judgment, ~$0.28/hr of TypeSafe credits at the measured cadence.

## Honesty box (read before quoting numbers)

- "Missed hazards" uses the deterministic model as ground truth - a heuristic, not certified ATC separation.
- Jev's 335 false positives on the ladder are mostly absorbed by the deterministic vet; the hazard layer stays clean.
- Replay mode replays recorded traffic at `REPLAY_SPEED`x; live mode costs more per real-time hour than the replay rate suggests.
- gpt/claude rows ran over the OpenAI/Anthropic public APIs at whatever latency the network gave us that day - not a controlled benchmark of those models' peak throughput.
- The conflict-probability math is the classic Paielli-Erzberger model (1997, NASA ARC / MITRE CAASD), the same family BlueSky (TU Delft) implements. Not novel physics - the point is the LLM control loop around it.

## File map

```
geo.mjs            conflict probability: Paielli-Erzberger + Brownian motion
feed.mjs           adsb.lol poller + JSONL replay feed
judge.mjs          Jev (TypeSafe) judge + deterministic ground truth + mock judge
server.mjs         control loop, metrics, dashboard server (zero deps)
tower.mjs          model ladder comparison harness
experiment.mjs     exp1: Jev-only candidate judging (accuracy data)
exp2.mjs           exp2: formation-flight annotation sweep
recorder.mjs       live feed -> JSONL recorder
deploy.mjs         E2B sandbox deploy (live)
deploy-replay.mjs  E2B sandbox deploy (replay)
public/index.html  dashboard
public/pip.html    minimal embed view
data/              replay sample + all measured-run outputs
```

## Credits & data

- Conflict-probability model: Paielli & Erzberger, *Conflict Probability Estimation for Free Flight*, NASA Ames / MITRE CAASD, 1997. https://ntrs.nasa.gov/api/citations/19970001686/downloads/19970001686.pdf
- Reference implementation lineage: BlueSky, TU Delft. https://github.com/TUDelft-CNS-ATM/bluesky
- Aircraft data: adsb.lol (free, open ADS-B API)
- Maps: OpenStreetMap / CARTO tiles, Leaflet
- Judge: Jev by TypeSafe · Sandboxes: E2B

MIT license.
