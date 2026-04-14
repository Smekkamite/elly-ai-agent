// core/telemetry.js (ESM)
//
// Parsers robusti per linee del bridge Elly.
// Obiettivo: non rompersi se cambiano ordine/campi, e estrarre hp/food anche se pos/dim mancano.

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick(line, re) {
  const m = String(line || "").match(re);
  return m ? m[1] : null;
}

// =========================
// Telemetry parsing helpers
// =========================

export function parsePosLine(line) {
  const s = String(line || "");

  // accetta: "OK pos=... dim=..." oppure "pos=... dim=..." oppure "ELLY:POS? OK pos=..."
  const posStr = pick(s, /pos=([\-0-9.]+,[\-0-9.]+,[\-0-9.]+)/i);
  const dim = pick(s, /\bdim=([^\s]+)/i);

  if (!posStr || !dim) return null;

  const parts = posStr.split(",").map((x) => x.trim());
  if (parts.length !== 3) return null;

  const x = toNum(parts[0]);
  const y = toNum(parts[1]);
  const z = toNum(parts[2]);
  if (x == null || y == null || z == null) return null;

  return { x, y, z, dim };
}

export function parseHostilesLine(line) {
  const s = String(line || "");

  // accetta: "OK:hostiles count=3" oppure "hostiles count=3"
  const c = pick(s, /hostiles\s+count=(\d+)/i);
  if (c == null) return null;

  const n = toNum(c);
  return n == null ? null : Math.trunc(n);
}

export function parseTelLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;

  // TEL può essere:
  // "TEL:pos=... dim=... hp=.. food=.."
  // oppure "TEL:hp=.. food=.." (ordine diverso)
  // oppure "TEL: ... food=.. hp=.." ecc.
  if (!s.toUpperCase().startsWith("TEL:")) return null;

  const hpStr = pick(s, /\bhp=([0-9.]+)/i);
  const foodStr = pick(s, /\bfood=(\d+)/i);

  const hp = hpStr != null ? toNum(hpStr) : null;
  const food = foodStr != null ? toNum(foodStr) : null;

  // hp/food sono la parte che ci serve davvero
  if (hp == null && food == null) return null;

  // opzionale: se presenti, estrai pos/dim (non bloccare se mancano)
  const posStr = pick(s, /pos=([\-0-9.]+,[\-0-9.]+,[\-0-9.]+)/i);
  const dim = pick(s, /\bdim=([^\s]+)/i);

  let pos = null;
  if (posStr) {
    const parts = posStr.split(",").map((x) => x.trim());
    if (parts.length === 3) {
      const x = toNum(parts[0]);
      const y = toNum(parts[1]);
      const z = toNum(parts[2]);
      if (x != null && y != null && z != null) pos = { x, y, z };
    }
  }

  return {
    hp: hp == null ? null : hp,
    food: food == null ? null : Math.trunc(food),
    pos,          // null se assente o non parsabile
    dim: dim || null, // null se assente
  };
}