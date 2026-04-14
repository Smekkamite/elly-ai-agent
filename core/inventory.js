// core/inventory.js (ESM)

// =========================
// Inventory parsing
// =========================
export function parseInvTokenToMap(tok, out) {
  if (!tok) return;
  let s = String(tok).trim();
  if (!s) return;

  s = s.replace(/^\s*(?:INV:|HOTBAR:)\s*/i, "").trim();
  if (!s) return;

  // Ignore meta regions sometimes encoded as tokens
  const low0 = s.toLowerCase();
  if (low0.startsWith("armor") || low0.startsWith("offhand")) return;

  // Strip "slot=" / "selected=" style prefixes
  const eq = s.indexOf("=");
  if (eq >= 0) s = s.slice(eq + 1).trim();
  if (!s) return;

  // Accept: id*64 OR id x 64
  let m = s.match(/^([a-z0-9_:\-]+)\*(\d+)$/i);
  if (!m) m = s.match(/^([a-z0-9_:\-]+)\s*x\s*(\d+)$/i);
  if (!m) return;

  const id = m[1].trim();
  const n = Number(m[2]);
  if (!id) return;

  out[id] = (out[id] || 0) + (Number.isFinite(n) ? n : 0);
}

export function parseInvLineTotals(line) {
  const out = {};
  const s0 = String(line || "").trim();
  if (!s0.startsWith("INV:")) return out;

  let payload = s0.slice(4).trim();
  if (!payload) return out;

  const low = payload.toLowerCase();
  if (low === "none" || low === "timeout" || low === "empty") return out;

  const sections = payload
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);

  for (const section of sections) {
    const upper = section.toUpperCase();

    if (upper.startsWith("HOTBAR:")) {
      let hb = section.slice("HOTBAR:".length).trim();
      hb = hb.replace(/^selected=\d+\s*/i, "").trim();
      if (!hb || hb.toLowerCase() === "empty") continue;

      for (const tok of hb.split(";")) parseInvTokenToMap(tok.trim(), out);
      continue;
    }

    let invPart = section;
    if (upper.startsWith("INV:")) invPart = section.slice("INV:".length).trim();
    if (!invPart || invPart.toLowerCase() === "empty") continue;

    for (const tok of invPart.split(";")) parseInvTokenToMap(tok.trim(), out);
  }

  return out;
}

/**
 * Parse per-slot inventory.
 * Returns an array length 36 (0..35) with either null or {slot,id,count}.
 *
 * Notes:
 * - Some bridges encode hotbar slots as 0..8, inventory as 9..35.
 * - Some encode hotbar as 36..44 (rare). We normalize those back to 0..8.
 */
export function parseInvLineSlots(line) {
  const slots = Array.from({ length: 36 }, () => null);
  const s0 = String(line || "").trim();
  if (!s0.startsWith("INV:")) return slots;

  const payload = s0.slice(4).trim();
  if (!payload) return slots;

  const low = payload.toLowerCase();
  if (low === "none" || low === "timeout" || low === "empty") return slots;

  const sections = payload
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);

  const putSlot = (idx, id, count) => {
    let i = Number(idx);
    if (!Number.isFinite(i)) return;

    // Normalize hotbar 36..44 -> 0..8
    if (i >= 36 && i <= 44) i = i - 36;

    // Keep only 0..35
    if (i < 0 || i > 35) return;

    slots[i] = { slot: i, id, count: Number(count) || 0 };
  };

  for (const section of sections) {
    const upper = section.toUpperCase();
    let part = section;

    if (upper.startsWith("HOTBAR:")) {
      part = section.slice("HOTBAR:".length).trim();
      part = part.replace(/^selected=\d+\s*/i, "").trim();
      if (!part || part.toLowerCase() === "empty") continue;

      for (const tok of part.split(";")) {
        const t = tok.trim();
        if (!t) continue;

        const m = t.match(/^(\d+)=([a-z0-9_:\-]+)\*(\d+)$/i);
        if (!m) continue;

        putSlot(m[1], m[2], m[3]);
      }
      continue;
    }

    if (upper.startsWith("INV:")) part = section.slice("INV:".length).trim();
    if (!part || part.toLowerCase() === "empty") continue;

    for (const tok of part.split(";")) {
      const t = tok.trim();
      if (!t) continue;

      // Ignore non-inventory regions if present
      const tlow = t.toLowerCase();
      if (tlow.startsWith("armor") || tlow.startsWith("offhand")) continue;

      const m = t.match(/^(\d+)=([a-z0-9_:\-]+)\*(\d+)$/i);
      if (!m) continue;

      putSlot(m[1], m[2], m[3]);
    }
  }

  return slots;
}

export function prettyInv(invMap, limit = 8) {
  const entries = Object.entries(invMap).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "(empty)";
  return entries
    .slice(0, limit)
    .map(([id, n]) => `${id}=${n}`)
    .join(", ");
}

export function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function normNameFromId(id) {
  const name = String(id).split(":")[1] ?? String(id);
  return name.replace(/_/g, " ").toLowerCase().trim();
}

/**
 * Match a human query to an inventory id.
 * Safer matching to avoid false positives (important for drop/store).
 */
export function matchItemFromInv(query, invMap) {
  const q = String(query).toLowerCase().trim();
  const qTokens = tokenize(q);
  const entries = Object.entries(invMap || {});
  if (!entries.length) return { id: null, qty: 0, candidates: [] };

  const scored = entries.map(([id, qty]) => {
    const name = normNameFromId(id);
    const nameTokens = tokenize(name);

    let score = 0;
    if (name === q) score += 120;
    if (id.toLowerCase() === q) score += 140;

    const allTokensPresent =
      qTokens.length > 0 && qTokens.every((t) => nameTokens.includes(t));
    if (allTokensPresent) score += 70 + qTokens.length * 6;

    if (q && name.includes(q)) score += 25;

    // small bias for stacks
    score += Math.min(10, Math.floor((qty || 0) / 16));

    return { id, score, qty: qty || 0, name };
  });

  scored.sort((a, b) => b.score - a.score || b.qty - a.qty);

  const best = scored[0];

  // dynamic threshold: short queries need stronger evidence
  const short = q.length <= 3 || qTokens.length === 1 && qTokens[0].length <= 3;
  const minScore = short ? 60 : 35;

  if (!best || best.score < minScore)
    return { id: null, qty: 0, candidates: scored.slice(0, 5) };

  return {
    id: best.id,
    qty: best.qty,
    candidates: scored.slice(0, 5),
    name: best.name,
  };
}

// =========================
// Safety helpers for "store all"
// =========================
export function isProtectedId(itemId) {
  const id = String(itemId || "").toLowerCase();
  if (!id) return false;

  // tools / weapons
  if (id.includes("_pickaxe")) return true;
  if (id.includes("_axe")) return true;
  if (id.includes("_shovel")) return true;
  if (id.includes("_hoe")) return true;
  if (id.includes("_sword")) return true;
  if (id.includes("bow") || id.includes("crossbow")) return true;
  if (id.includes("shield")) return true;

  
  // QoL
  if (id.includes("torch")) return true;

  // ammo
  if (id.includes("arrow")) return true;

  // food
  const foodKeep = [
    "bread",
    "beef",
    "porkchop",
    "chicken",
    "mutton",
    "cod",
    "salmon",
    "potato",
    "carrot"
  ];

  if (foodKeep.some(f => id.includes(f))) return true;

  return false;
}
  
export function normalizeIdToken(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/-/g, "_").replace(/\s+/g, "_");
  while (s.includes("__")) s = s.replace(/__/g, "_");
  s = s.replace(/^_+/, "").replace(/_+$/, "");
  return s;
}

export function normalizeBlockId(raw) {
  const s = normalizeIdToken(raw);
  if (!s) return null;
  if (s.includes(":")) return s;
  return `minecraft:${s}`;
}