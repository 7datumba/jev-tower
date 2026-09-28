// Deploy the tower to an E2B sandbox replaying the bundled recorded feed.
// Usage: E2B_API_KEY=... TYPESAFE_API_KEY=... REPLAY_SPEED=20 node deploy-replay.mjs
import { Sandbox } from 'e2b';
import { readFileSync } from 'node:fs';
const apiKey = process.env.E2B_API_KEY;
const tsKey = process.env.TYPESAFE_API_KEY || '';
if (!apiKey) { console.error('E2B_API_KEY required'); process.exit(1); }
const speed = process.env.REPLAY_SPEED || '20';
const sbx = await Sandbox.create({ apiKey, timeoutMs: 3600_000 });
console.log('sandbox', sbx.sandboxId);
for (const f of ['geo.mjs','feed.mjs','judge.mjs','server.mjs']) await sbx.files.write(`/home/user/${f}`, readFileSync(f,'utf8'));
await sbx.files.write('/home/user/public/index.html', readFileSync('public/index.html','utf8'));
await sbx.files.write('/home/user/public/pip.html', readFileSync('public/pip.html','utf8'));
await sbx.files.write('/home/user/public/leaflet/leaflet.js', readFileSync('public/leaflet/leaflet.js','utf8'));
await sbx.files.write('/home/user/public/leaflet/leaflet.css', readFileSync('public/leaflet/leaflet.css','utf8'));
await sbx.files.write('/home/user/feed-replay.jsonl', readFileSync('data/feed-replay.jsonl','utf8'));
await sbx.commands.run(`cd /home/user && JUDGE=${tsKey ? 'jev' : 'mock'} FEED=replay REPLAY_FILE=/home/user/feed-replay.jsonl REPLAY_SPEED=${speed} PORT=8000 TYPESAFE_API_KEY='${tsKey}' nohup node server.mjs > server.log 2>&1 & echo ok`);
await new Promise(r => setTimeout(r, 8000));
const host = sbx.getHost(8000);
const j = await (await fetch('https://' + host + '/api/state')).json();
console.log('replay live:', JSON.stringify({ tracks: j.tracks.length, replay: j.metrics.replay, speed: j.metrics.replaySpeed }));
console.log('URL https://' + host);
console.log('remember to kill the sandbox when done: sbx.kill()');
