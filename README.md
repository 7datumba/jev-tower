# JEV TOWER - live ATC judgment loop over the SF Bay

Real ADS-B traffic over the San Francisco Bay, watched by a judgment model inside an E2B sandbox.
Every second the loop: pulls live tracks (adsb.lol), finds converging aircraft pairs by deterministic
closest-point-of-approach (CPA), asks **Jev** (TypeSafe System One model, direct TypeSafe API) to score
conflict risk per pair, vets every flag with deterministic physics code, and issues *virtual* reroute
headings for confirmed losses of separation. The dashboard shows the map, the judgments, and the
evidence behind every probability - click any plane or conflict line.

**Reroutes are VIRTUAL - no real aircraft receives instructions. This measures separation-standard
margins, not crash probability; real ATC is flying these planes.**

## Architecture

```
adsb.lol (1 Hz) -> geo.mjs (tangent-plane tracks, CPA) -> candidate pairs
  -> Jev watch layer: noul p(conflict) + risk score 0-4 per pair (~100 ms batched)
  -> deterministic vet: cpa < 3 NM lateral AND < 1000 ft vertical within 120 s (code, not model)
  -> Jev reroute choice (top confirmed pair only)
  -> dashboard: Leaflet + dark Esri canvas tiles, evidence panel, physics conflict probability
```

## The numbers (all from recorded runs in `data/`)

Tower comparison, identical 60-tick recorded window, same pairs, ground truth = deterministic CPA rule:

| model              | avg latency | missed (of 385) | false positives |
|--------------------|------------:|----------------:|----------------:|
| **Jev**            | **103 ms**  | **0**           | 335             |
| gpt-4o-mini        | 2,242 ms    | 160             | 22              |
| gpt-4o             | 2,356 ms    | 56              | 32              |
| claude-opus-5-5    | 12,318 ms   | 0               | 174             |

Live run baseline (late morning, Bay): ~75-85 aircraft, ~12.5 judgments/sec, p50 ~100 ms, ~$0.28/hr.

### False-positive study (experiment.mjs, exp2.mjs)

- Jev's watch layer flags broadly by design: 720 flags / 0 misses / 335 false vs the physics rule.
- Threshold sweeps and multi-tick persistence **cannot** cut false alarms without creating misses
  (at p>0.7, 286 of 385 real losses missed).
- Letting Jev audit itself with the exact CPA numbers and the rule in the prompt still missed
  180 of 385 - a model is the wrong verifier.
- Final architecture: model triages, deterministic code vets, reroutes only on confirmed pairs.
  Recorded window: 720 raw flags -> 385 vet-confirmed -> 335 vetted away -> 0 real conflicts missed.

## Physics conflict probability

The amber "physics %" is a conflict probability from trajectory uncertainty, after
**Paielli & Erzberger, "Conflict Probability Estimation for Free Flight", NASA 1997**
(https://ntrs.nasa.gov/api/citations/19970001686/downloads/19970001686.pdf).
Printed assumptions: per-aircraft position sigma grows 1.0 NM/min along-track and 0.4 NM/min
cross-track from 0.05 NM nav error; vertical gate softened to a logistic around 1000 ft.
The deterministic CPA gates match the approach in the open-source BlueSky ATM simulator
(https://github.com/TUDelft-CNS-ATM/bluesky).

## Run it

```
TYPESAFE_API_KEY=... JUDGE=jev PORT=8000 node server.mjs
```

No npm dependencies (pure node 18+). `deploy.mjs` provisions an E2B sandbox (expects key files in
/tmp - see the script). `tower.mjs` replays the recorded window against comparison models;
`experiment.mjs` / `exp2.mjs` reproduce the false-positive study.

## Credits

- Live data: adsb.lol (open ADS-B feed)
- Conflict probability method: Paielli & Erzberger, NASA 1997 (linked above)
- CPA gating approach: BlueSky ATM simulator, TU Delft (linked above)
- Map: Esri dark gray canvas tiles, (c) OpenStreetMap contributors
- Judgment model: Jev, TypeSafe System One (console.typesafe.ai)
- Sandboxes: E2B
