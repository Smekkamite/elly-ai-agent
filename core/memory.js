import { readJsonFile, writeJsonAtomic } from "./jsonStore.js";

const MODES = new Set(["safe", "assist", "auto"]);

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function cleanStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)),
  ).slice(-limit);
}

export function createDefaultMemory(defaultMode = "auto") {
  const mode = MODES.has(String(defaultMode).toLowerCase())
    ? String(defaultMode).toLowerCase()
    : "auto";

  return {
    schema_version: 1,
    mode,
    owner: null,
    facts: [],
    recent: [],
    locations: {},
    guard: { enabled: true, notifyOnly: false, postRetreat: null },
    combat: {
      enabled: false,
      mode: "normal",
      targetKind: "hostile",
      target: null,
      targetLockedAt: 0,
      lastCombatAt: 0,
      lastDamageAt: 0,
      lastDamageHp: null,
      lastDamageTaken: 0,
      lastBowShotAt: 0,
      lastRepositionAt: 0,
      lastSpeechAt: 0,
      lastFollowResumeAt: 0,
      lastLookPlayerAt: 0,
      lastMeleeAt: 0,
      lastChaseAt: 0,
    },
    active_goal: null,
    goal_queue: [],
    areas: {},
    capabilities: { sleep: null, use: null },
    world_snapshot: {
      at: 0,
      pos: null,
      biome: null,
      dim: null,
      envRaw: null,
      envInfo: null,
      hp: null,
      food: null,
      hostiles: null,
      hostiles_detail: [],
      passives_detail: [],
      inventory: {},
      last_action: null,
      last_action_at: 0,
      last_error: null,
      consecutive_timeouts: 0,
      last_retreat_at: 0,
      last_ambient_at: 0,
      owner_sleeping: false,
      last_sleep_sync_at: 0,
      last_eat_at: 0,
      last_respawn_at: 0,
      last_armor_check_at: 0,
    },
    speech: { lastSig: null, lastAt: 0 },
  };
}

export function normalizeMemory(parsed, defaults = createDefaultMemory()) {
  const out = { ...defaults, ...asObject(parsed) };

  out.schema_version = 1;
  out.mode = String(out.mode || defaults.mode).toLowerCase();
  if (!MODES.has(out.mode)) out.mode = defaults.mode;

  out.owner =
    typeof out.owner === "string" && /^[A-Za-z0-9_]{2,32}$/.test(out.owner.trim())
      ? out.owner.trim()
      : null;
  out.facts = cleanStringList(out.facts, 100);
  out.recent = Array.isArray(out.recent)
    ? out.recent
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          t: finiteOr(entry.t, Date.now()),
          from: String(entry.from || "unknown").slice(0, 32),
          text: String(entry.text || "").slice(0, 500),
        }))
        .filter((entry) => entry.text)
        .slice(-30)
    : [];

  out.locations = asObject(out.locations);
  out.areas = asObject(out.areas);
  out.goal_queue = Array.isArray(out.goal_queue) ? out.goal_queue.slice(0, 50) : [];
  if (!("active_goal" in out)) out.active_goal = null;

  const guard = asObject(out.guard);
  out.guard = {
    enabled: typeof guard.enabled === "boolean" ? guard.enabled : defaults.guard.enabled,
    notifyOnly:
      typeof guard.notifyOnly === "boolean" ? guard.notifyOnly : defaults.guard.notifyOnly,
    postRetreat: guard.postRetreat ?? null,
  };

  const combat = { ...defaults.combat, ...asObject(out.combat) };
  combat.enabled = Boolean(combat.enabled);
  combat.mode = ["normal", "death"].includes(String(combat.mode).toLowerCase())
    ? String(combat.mode).toLowerCase()
    : "normal";
  combat.targetKind = ["hostile", "passive"].includes(String(combat.targetKind).toLowerCase())
    ? String(combat.targetKind).toLowerCase()
    : "hostile";
  for (const key of [
    "targetLockedAt",
    "lastCombatAt",
    "lastDamageAt",
    "lastDamageTaken",
    "lastBowShotAt",
    "lastRepositionAt",
    "lastSpeechAt",
    "lastFollowResumeAt",
    "lastLookPlayerAt",
    "lastMeleeAt",
    "lastChaseAt",
  ]) {
    combat[key] = finiteOr(combat[key], 0);
  }
  combat.lastDamageHp = Number.isFinite(combat.lastDamageHp) ? combat.lastDamageHp : null;
  out.combat = combat;

  const capabilities = asObject(out.capabilities);
  out.capabilities = {
    sleep: capabilities.sleep ?? null,
    use: capabilities.use ?? null,
  };

  const world = { ...defaults.world_snapshot, ...asObject(out.world_snapshot) };
  world.inventory = asObject(world.inventory);
  world.hostiles_detail = Array.isArray(world.hostiles_detail) ? world.hostiles_detail : [];
  world.passives_detail = Array.isArray(world.passives_detail) ? world.passives_detail : [];
  world.owner_sleeping = Boolean(world.owner_sleeping);
  for (const key of [
    "at",
    "last_action_at",
    "consecutive_timeouts",
    "last_retreat_at",
    "last_ambient_at",
    "last_sleep_sync_at",
    "last_eat_at",
    "last_respawn_at",
    "last_armor_check_at",
  ]) {
    world[key] = finiteOr(world[key], 0);
  }
  out.world_snapshot = world;

  const speech = asObject(out.speech);
  out.speech = {
    lastSig: speech.lastSig == null ? null : String(speech.lastSig).slice(0, 300),
    lastAt: finiteOr(speech.lastAt, 0),
  };

  return out;
}

export function createMemoryStore({ filePath, defaultMode = "auto", logger = console }) {
  const defaults = createDefaultMemory(defaultMode);

  return {
    load() {
      return readJsonFile(filePath, {
        defaults,
        normalize: (value) => normalizeMemory(value, defaults),
        logger,
      });
    },
    save(memory) {
      writeJsonAtomic(filePath, normalizeMemory(memory, defaults));
    },
  };
}

export function expireStaleGoals(memory, {
  now = Date.now(),
  maxAgeMs = 15 * 60 * 1000,
} = {}) {
  const goal = memory?.active_goal;
  if (!goal || typeof goal !== "object") return null;

  const timestamp = Number(goal.updatedAt ?? goal.createdAt);
  const age = now - timestamp;
  const stale =
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    age > maxAgeMs ||
    age < -60_000;

  if (!stale) return null;

  const expired = {
    id: goal.id ?? null,
    type: String(goal.type || "unknown"),
    ageMs: Number.isFinite(age) ? age : null,
  };

  memory.active_goal = null;
  memory.goal_queue = [];
  return expired;
}

export function addRecent(memory, from, text) {
  if (!Array.isArray(memory.recent)) memory.recent = [];
  memory.recent.push({
    t: Date.now(),
    from: String(from || "unknown").slice(0, 32),
    text: String(text || "").slice(0, 500),
  });
  memory.recent = memory.recent.slice(-30);
}

export function summarizeMemory(memory) {
  const facts = (memory.facts || []).slice(-30).map((fact) => `- ${fact}`).join("\n");
  const recent = (memory.recent || [])
    .slice(-8)
    .map((entry) => `${entry.from}: ${entry.text}`)
    .join("\n");

  const locations = Object.entries(memory.locations || {})
    .slice(0, 20)
    .map(([name, value]) =>
      value ? `- ${name} = (${value.x} ${value.y} ${value.z}) [${value.dim || "unknown"}]` : null,
    )
    .filter(Boolean)
    .join("\n");

  const goal = memory.active_goal;
  const goalLine = goal
    ? `ACTIVE_GOAL: ${goal.type} status=${goal.status} ${goal.label || ""}`.trim()
    : "ACTIVE_GOAL: (none)";

  return `${goalLine}
OWNER: ${memory.owner || "(unset)"}

FACTS:
${facts || "- (none)"}

LOCATIONS:
${locations || "- (none)"}

RECENT:
${recent || "(none)"}`;
}
