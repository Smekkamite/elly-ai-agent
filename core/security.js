export function isValidPlayerName(value) {
  return /^[A-Za-z0-9_]{2,32}$/.test(String(value || "").trim());
}

export function samePlayer(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

export function sanitizeProtocolLine(value, maxLength = 4096) {
  const line = String(value ?? "")
    .replace(/[\r\n\u0000]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!line) throw new Error("empty_command");
  if (line.length > maxLength) throw new Error("command_too_long");
  return line;
}

export function safeCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return Math.abs(integer) <= 30_000_000 ? integer : null;
}
