// Local tangent-plane geo + closest point of approach for aircraft pairs.
const NM_M = 1852, FT_M = 0.3048;
export function toXY(lat, lon, refLat, refLon) {
  const kx = Math.cos(refLat * Math.PI / 180) * 111320, ky = 110540;
  return { x: (lon - refLon) * kx, y: (lat - refLat) * ky };
}
export function trackState(ac, refLat, refLon) {
  // ac: {flight, lat, lon, alt_baro(ft|'ground'), gs(kt), track(deg), baro_rate(fpm)}
  const { x, y } = toXY(ac.lat, ac.lon, refLat, refLon);
  const gs = (ac.gs || 0) * NM_M / 3600;           // m/s
  const hdg = (ac.track || 0) * Math.PI / 180;
  return {
    id: (ac.flight || ac.hex || '').trim(), x, y,
    z: (ac.alt_baro === 'ground' ? 0 : (ac.alt_baro || 0)) * FT_M,
    vx: gs * Math.sin(hdg), vy: gs * Math.cos(hdg),
    vz: (ac.baro_rate || 0) * FT_M / 60,
    alt: ac.alt_baro === 'ground' ? 0 : ac.alt_baro || 0,
    gsKt: ac.gs || 0, hdgDeg: ac.track || 0, vsFpm: ac.baro_rate || 0,
    lat: ac.lat, lon: ac.lon,
  };
}
export function cpa(a, b, horizonSec = 180) {
  // returns {cpaNm, cpaFt, tSec, hNmNow, vFtNow}
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const dvx = b.vx - a.vx, dvy = b.vy - a.vy, dvz = b.vz - a.vz;
  const dv2 = dvx*dvx + dvy*dvy + dvz*dvz;
  let t = dv2 > 1e-6 ? -(dx*dvx + dy*dvy + dz*dvz) / dv2 : 0;
  t = Math.max(0, Math.min(horizonSec, t));
  const cx = dx + dvx*t, cy = dy + dvy*t, cz = dz + dvz*t;
  const hNow = Math.hypot(dx, dy) / NM_M, vNow = Math.abs(dz) / FT_M;
  const hDistM = Math.hypot(dx, dy);
  const closingKt = hDistM > 1 ? Math.round(-((dx * dvx + dy * dvy) / hDistM) * 3600 / NM_M) : 0;
  return {
    cpaNm: Math.hypot(cx, cy) / NM_M, cpaFt: Math.abs(cz) / FT_M, tSec: Math.round(t),
    hNmNow: hNow, vFtNow: vNow, closingKt,
  };
}
export function findCandidates(tracks, opts = {}) {
  const { hGateNm = 10, vGateFt = 3000, cpaGateNm = 3.2, cpaGateSec = 180 } = opts;
  const out = [];
  for (let i = 0; i < tracks.length; i++) for (let j = i+1; j < tracks.length; j++) {
    const a = tracks[i], b = tracks[j];
    if (a.gsKt < 30 || b.gsKt < 30) continue; // skip ground
    // on or nearly on the runway at a known field: ground ops, not a conflict pair
    const onGround = t => t.alt <= 100 && FIELDS.some(f => fieldDistNm(t, f) < 3);
    if (onGround(a) || onGround(b)) continue;
    const r = cpa(a, b);
    if (r.hNmNow < hGateNm && r.vFtNow < vGateFt && r.cpaNm < cpaGateNm && r.tSec <= cpaGateSec)
      out.push({ a: a.id, b: b.id, ...r });
  }
  return out.sort((p, q) => p.cpaNm - q.cpaNm);
}


// --- Operational context: pairs the 3 NM / 1000 ft standard does not govern ---
// Formation flight (matched velocity, glued together) and parallel-final arrivals
// (both established on approach to the same field, runway-aligned) are annotated,
// not counted as separation losses.
const FIELDS = [
  { icao: 'SFO', lat: 37.6213, lon: -122.3790, courses: [281] },
  { icao: 'OAK', lat: 37.7126, lon: -122.2197, courses: [300, 120] },
  { icao: 'SJC', lat: 37.3639, lon: -121.9289, courses: [300, 120] },
];
function hdgDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function fieldDistNm(t, f) {
  const dy = (t.lat - f.lat) * 60, dx = (t.lon - f.lon) * 60 * Math.cos(f.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}
export function classifyPair(a, b, r) {
  const relKt = Math.hypot(b.vx - a.vx, b.vy - a.vy) / NM_M * 3600;
  // glued low/slow GA: formation, photo flight, or interp artifact of nearby VFR tracks - the IFR standard does not govern
  if ((relKt < 25 && r.hNmNow < 1.0) || (r.hNmNow < 0.5 && a.alt < 3000 && b.alt < 3000 && a.gsKt < 120 && b.gsKt < 120)) return { kind: 'formation', field: null };
  if (a.alt < 3500 && b.alt < 3500 && relKt < 40 && hdgDiff(a.hdgDeg, b.hdgDeg) < 30) {
    for (const f of FIELDS) {
      if (fieldDistNm(a, f) < 12 && fieldDistNm(b, f) < 12 &&
          f.courses.some(c => hdgDiff(a.hdgDeg, c) < 25 && hdgDiff(b.hdgDeg, c) < 25))
        return { kind: 'parallel', field: f.icao };
    }
  }
  return { kind: 'normal', field: null };
}

// --- Probabilistic conflict probability (after Paielli & Erzberger, NASA TM-1997-00436) ---
// Position uncertainty per aircraft grows with lookahead time; the relative position
// at CPA is a 2D Gaussian; P(conflict) = mass inside the 3 NM disk, times a vertical factor.
const GAUSS = (x, y, sx, sy) => Math.exp(-(x*x)/(2*sx*sx) - (y*y)/(2*sy*sy));
export function conflictProb(a, b, opts = {}) {
  const R_NM = 3.0;
  const { navNm = 0.05, growAlongNmMin = 1.0, growCrossNmMin = 0.4 } = opts;
  const r = cpa(a, b);
  const tMin = r.tSec / 60;
  // uncertainty of each aircraft at CPA time, projected on (along-rel-velocity, cross) axes
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const rv = Math.hypot(rvx, rvy) || 1e-6;
  const ux = rvx / rv, uy = rvy / rv; // unit vector along relative motion
  function sigmas(ac) {
    const sa = navNm + growAlongNmMin * tMin, sc = navNm + growCrossNmMin * tMin;
    const hx = Math.sin(ac.hdgDeg * Math.PI / 180), hy = Math.cos(ac.hdgDeg * Math.PI / 180);
    const projA = hx * ux + hy * uy, projC = -hx * uy + hy * ux; // heading projection on axes
    const sAlong = Math.hypot(sa * projA, sc * projC), sCross = Math.hypot(sc * projA, sa * projC);
    return { sAlong, sCross };
  }
  const A = sigmas(a), B = sigmas(b);
  const sx = Math.hypot(A.sAlong, B.sAlong), sy = Math.hypot(A.sCross, B.sCross);
  // CPA offset in relative-motion frame
  const dx = b.x - a.x + rvx * r.tSec, dy = b.y - a.y + rvy * r.tSec;
  const mx = (dx * ux + dy * uy) / NM_M, my = (-dx * uy + dy * ux) / NM_M;
  // numeric integration of 2D Gaussian over disk of radius R around origin, mean (mx,my)
  const ext = R_NM + 3 * Math.max(sx, sy);
  const N = 48, step = 2 * ext / N;
  let mass = 0, disk = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = -ext + (i + 0.5) * step, y = -ext + (j + 0.5) * step;
    const g = GAUSS(x - mx, y - my, sx, sy);
    mass += g;
    if (x * x + y * y < R_NM * R_NM) disk += g;
  }
  const pLat = mass > 0 ? disk / mass : 0;
  // vertical factor: logistic around the 1000 ft gate with +-200 ft softness
  const pVert = 1 / (1 + Math.exp((r.cpaFt - 1000) / 120));
  const p = Math.max(0, Math.min(1, pLat * pVert));
  return { p: +p.toFixed(3), pLat: +pLat.toFixed(3), pVert: +pVert.toFixed(3), sxNm: +sx.toFixed(2), syNm: +sy.toFixed(2) };
}
