// adsb.lol live feed poller for the SF Bay, with raw recording and replay.
import { trackState } from './geo.mjs';
import { readFileSync, appendFileSync } from 'node:fs';
const REF = { lat: 37.62, lon: -122.38 }; // SFO
const URL = `https://api.adsb.lol/v2/point/${REF.lat}/${REF.lon}/45`;
function toTracks(ac) {
  return (ac || [])
    .filter(a => a.lat != null && a.lon != null)
    .map(a => trackState(a, REF.lat, REF.lon))
    .filter(t => t.gsKt >= 30);
}
export function makeFeed(onTick, opts = {}) {
  const { recordPath = null } = opts;
  let timer = null, lastSeen = new Map();
  async function poll() {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'accept': 'application/json' } });
      const j = await res.json();
      const now = Date.now();
      if (recordPath) { try { appendFileSync(recordPath, JSON.stringify({ at: now, ac: j.ac || [] }) + '\n'); } catch {} }
      const tracks = toTracks(j.ac);
      for (const t of tracks) lastSeen.set(t.id, { t, at: now });
      for (const [id, e] of lastSeen) if (now - e.at > 15000) lastSeen.delete(id);
      onTick({ at: now, tracks, count: tracks.length });
    } catch (e) { onTick({ at: Date.now(), tracks: [...lastSeen.values()].map(v => v.t), count: lastSeen.size, stale: true, error: String(e).slice(0,120) }); }
  }
  return {
    start(intervalMs = 2000) { poll(); timer = setInterval(poll, intervalMs); },
    stop() { clearInterval(timer); },
  };
}
export function makeReplayFeed(file, onTick, speed = 1) {
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  let i = 0, timer = null;
  function step() {
    if (i >= lines.length) { i = 0; } // loop
    const rec = lines[i++];
    onTick({ at: rec.at, tracks: toTracks(rec.ac), count: (rec.ac || []).length, replay: true });
    if (i < lines.length) {
      const dt = Math.max(200, Math.min(5000, lines[i].at - rec.at)) / speed;
      timer = setTimeout(step, dt);
    } else { timer = setTimeout(step, 1000); }
  }
  return { start() { step(); }, stop() { clearTimeout(timer); } };
}
