// Records identical candidate-pair windows for the Jev vs LLM tower comparison.
import { writeFileSync, appendFileSync } from 'node:fs';
import { makeFeed } from './feed.mjs';
import { findCandidates } from './geo.mjs';
const OUT = process.argv[2] || '/tmp/window.jsonl';
const feed = makeFeed(({ tracks }) => {
  const cands = findCandidates(tracks).slice(0, 12);
  if (cands.length) appendFileSync(OUT, JSON.stringify({ at: Date.now(), pairs: cands }) + '\n');
});
feed.start(2000);
console.log('recording to', OUT);
