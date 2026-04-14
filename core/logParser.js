// core/logParser.js (ESM)
// Robust parser for PrismLauncher / client logs (1.20.1) and server logs.

export function extractSystemChat(line) {
  // Returns the portion after "[CHAT]" if present (raw payload, not yet interpreted)
  const s = String(line || "");
  const i = s.indexOf("[CHAT]");
  if (i === -1) return null;
  return s.slice(i + "[CHAT]".length).trim();
}

export function parseChatLine(line) {
  const s = String(line || "");
  const payload = extractSystemChat(s);
  if (!payload) return null;

  // Normalize some common prefixes:
  // e.g. "[Not Secure] <Name> msg" (server), or "[System] ..." etc.
  let p = payload.trim();

  // Strip leading "[...]" blocks repeatedly (server prefixes)
  // Example: "[Not Secure] <Name> hi" => "<Name> hi"
  while (p.startsWith("[") && p.includes("]")) {
    const end = p.indexOf("]");
    if (end <= 0) break;
    const maybe = p.slice(0, end + 1);
    // Only strip if it looks like a prefix block
    if (/^\[[^\]]{1,40}\]$/.test(maybe)) {
      p = p.slice(end + 1).trim();
      continue;
    }
    break;
  }

  // Pattern 1: "<Name> message"
  // Allow colors/formatting removed already; keep it strict on <>.
  let m = p.match(/^<([^>]{1,32})>\s*(.+)$/);
  if (m) {
    return { from: m[1].trim(), userText: (m[2] || "").trim() };
  }

  // Pattern 2: "Name: message"
  m = p.match(/^([A-Za-z0-9_]{2,32})\s*:\s*(.+)$/);
  if (m) {
    return { from: m[1].trim(), userText: (m[2] || "").trim() };
  }

  // Not a player chat line
  return null;
}

// Sleep events can appear as system messages. We parse from system payload (already stripped).
export function parseSleepEventFromSystemLine(systemPayload) {
  const t0 = String(systemPayload || "").trim();
  if (!t0) return null;

  // If it's definitely a player chat message "<Name> ...", ignore for sleep parsing.
  // (Sleep sync watches system messages, not chat.)
  if (/^<[^>]{1,32}>\s+/.test(t0)) return null;

  // Strip leading bracketed prefixes (like "[Server]" or "[Not Secure]" etc.)
  let t = t0;
  while (t.startsWith("[") && t.includes("]")) {
    const end = t.indexOf("]");
    if (end <= 0) break;
    const maybe = t.slice(0, end + 1);
    if (/^\[[^\]]{1,40}\]$/.test(maybe)) {
      t = t.slice(end + 1).trim();
      continue;
    }
    break;
  }

  // Common English variants:
  // "Name is now sleeping"
  // "Name is sleeping"
  // "Name went to sleep"
  // "Name left the bed"
  // "Name stopped sleeping"
  // "Name woke up"
  let m =
    t.match(/^([A-Za-z0-9_]{2,32})\s+(is now sleeping|is sleeping)\b/i) ||
    t.match(/^([A-Za-z0-9_]{2,32})\s+(went to sleep|fell asleep)\b/i);
  if (m) return { player: m[1], sleeping: true };

  m =
    t.match(/^([A-Za-z0-9_]{2,32})\s+(left the bed|stopped sleeping|woke up)\b/i) ||
    t.match(/^([A-Za-z0-9_]{2,32})\s+(got out of bed)\b/i);
  if (m) return { player: m[1], sleeping: false };

  return null;
}