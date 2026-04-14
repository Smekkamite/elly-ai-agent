// bot.js (ESM) — Elly Brain (EllyAPI)
//
// Goals:
// - Listen ONLY to "@elly ..." messages
// - Deterministic commands for obvious stuff (goto/follow/mine/store/etc.)
// - LLM can talk freely, BUT can execute commands ONLY when user explicitly asks an action
// - Reflex loop: telemetry, hostiles, vitals, auto-eat/sleep sync/retreat/ambient via reflexTick

import fs from "fs";
import { Tail } from "tail";
import { EllyAPI } from "./ellyApi.js";

import { parsePosLine, parseHostilesLine, parseTelLine } from "./core/telemetry.js";
import {
  extractSystemChat,
  parseChatLine,
  parseSleepEventFromSystemLine,
} from "./core/logParser.js";

import {
  parseInvLineTotals,
  parseInvLineSlots,
  prettyInv,
  matchItemFromInv,
} from "./core/inventory.js";

import { reflexTick } from "./brain/reflexes.js";
import { combatTick } from "./brain/combat.js";
import {
  parseEnvLine,
  classifyEnvironment,
  describeEnvironmentForPrompt,
} from "./core/envAnalyzer.js";


// =========================
// UI config
// =========================
const UI_PATH = process.env.ELLY_UI || "./UI.json";

function defaultUIConfig() {
  return {
    botName: "elly",
    instancePath: "",
    serverAddress: "",
    ollamaEnabled: true,
    systemMessages: true,
    chatCooldownMs: 1200,
  };
}

function loadUIConfig() {
  const init = defaultUIConfig();

  if (!fs.existsSync(UI_PATH)) {
    fs.writeFileSync(UI_PATH, JSON.stringify(init, null, 2));
    return init;
  }

  try {
    const raw = fs.readFileSync(UI_PATH, "utf8");
    if (!raw.trim()) {
      fs.writeFileSync(UI_PATH, JSON.stringify(init, null, 2));
      return init;
    }

    const parsed = JSON.parse(raw);

    return {
      ...init,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
    };
  } catch (e) {
    const backup = `${UI_PATH}.broken.${Date.now()}`;
    try { fs.copyFileSync(UI_PATH, backup); } catch {}
    fs.writeFileSync(UI_PATH, JSON.stringify(init, null, 2));
    console.log(`[ui] invalid -> reset. Backup: ${backup}`);
    return init;
  }
}

const ui = loadUIConfig();
// =========================
// Config (ENV first)
// =========================
const BRIDGE_HOST = process.env.ELLY_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.ELLY_PORT || "25580");

const UI_INSTANCE_PATH = String(ui.instancePath || "").trim();
const DEFAULT_LOG_FROM_UI = UI_INSTANCE_PATH
  ? `${UI_INSTANCE_PATH.replace(/[\\\/]+$/, "")}/logs/latest.log`
  : "";

const SERVER_LOG =
  process.env.ELLY_LOG ||
  DEFAULT_LOG_FROM_UI;

const BOT_NAME = String(ui.botName || "elly").trim().toLowerCase() || "elly";
const TRIGGER = String(process.env.ELLY_TRIGGER || `@${BOT_NAME}`).toLowerCase();

const SYSTEM_MESSAGES_ENABLED =
  String(ui.systemMessages).toLowerCase() !== "false";

const CHAT_COOLDOWN_MS = Math.max(
  250,
  Number(ui.chatCooldownMs || 1200)
);

const OLLAMA_ENABLED =
  String(ui.ollamaEnabled).toLowerCase() !== "false";

const DEBUG_INV_RAW =
  String(process.env.ELLY_DEBUG_INV || "false").toLowerCase() === "true";

const OLLAMA_URL =
  process.env.ELLY_OLLAMA_URL || "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = process.env.ELLY_MODEL || "llama3.1:8b";

const MEMORY_PATH = process.env.ELLY_MEMORY || "./memory.json";
const PERSONALITY_PATH = process.env.ELLY_PERSONALITY || "./personality.json";

const DEFAULT_MODE = (process.env.ELLY_MODE || "auto").toLowerCase(); // safe | assist | auto
const MAX_COMMANDS_PER_CYCLE = Math.max(
  1,
  Math.min(10, Number(process.env.ELLY_MAX_CMDS || "3"))
);

const LOOP_MS = Math.max(250, Number(process.env.ELLY_LOOP_MS || "400"));
const MAX_CONSEC_TIMEOUTS = 3;

// Chest goal timings
const CHEST_POST_OPEN_WAIT_MS = 180;


// Threat / Retreat
const HOME_NAME = (process.env.ELLY_HOME || "HOME").toUpperCase();

const RETREAT_ON_HOSTILES =
  String(process.env.ELLY_RETREAT_ON_HOSTILES || "true").toLowerCase() === "true";

const RETREAT_HOSTILES_THRESHOLD = Math.max(
  1,
  Number(process.env.ELLY_RETREAT_HOSTILES_THRESHOLD || "1")
);

const RETREAT_HP_THRESHOLD = Math.max(
  1,
  Number(process.env.ELLY_RETREAT_HP_THRESHOLD || "8")
);

const RETREAT_COOLDOWN_MS = Math.max(
  2000,
  Number(process.env.ELLY_RETREAT_COOLDOWN_MS || "15000")
);

// Ambient
const AMBIENT_COMMENT_ENABLED =
  String(process.env.ELLY_AMBIENT || "true").toLowerCase() === "true";

const AMBIENT_COMMENT_PERIOD_MS = Math.max(
  30000,
  Number(process.env.ELLY_AMBIENT_PERIOD_MS || "300000")
);

// Eat / Sleep policy
const AUTO_EAT_ENABLED =
  String(process.env.ELLY_AUTO_EAT || "true").toLowerCase() === "true";

// default 7 normally; you set 19 for aggressive eating
const EAT_FOOD_THRESHOLD = Math.max(
  1,
  Math.min(20, Number(process.env.ELLY_EAT_THRESHOLD || "19"))
);

const EAT_COOLDOWN_MS = Math.max(
  3000,
  Number(process.env.ELLY_EAT_COOLDOWN_MS || "3000")
);

const SLEEP_SYNC_ENABLED =
  String(process.env.ELLY_SLEEP_SYNC || "true").toLowerCase() === "true";

const SLEEP_COOLDOWN_MS = Math.max(
  3000,
  Number(process.env.ELLY_SLEEP_COOLDOWN_MS || "20000")
);

// =========================
// Local helpers (fallbacks)
// =========================
function isProtectedId(itemId) {
  const id = String(itemId || "").toLowerCase();
  if (!id) return false;

  // Tools / weapons
  if (id.includes("_pickaxe")) return true;
  if (id.includes("_axe")) return true;
  if (id.includes("_shovel")) return true;
  if (id.includes("_hoe")) return true;
  if (id.includes("_sword")) return true;
  if (id.includes("bow") || id.includes("crossbow")) return true;
  if (id.includes("shield")) return true;
  
  // Ammo
  if (id.includes("arrow")) return true;

  // Food to keep
  const foodKeep = [
    "bread",
    "beef",
    "porkchop",
    "chicken",
    "mutton",
    "cod",
    "salmon",
    "baked",
    "carrot"
  ];

  if (foodKeep.some(f => id.includes(f))) return true;

  return false;
}

function normalizeIdToken(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/-/g, "_").replace(/\s+/g, "_");
  while (s.includes("__")) s = s.replace(/__/g, "_");
  s = s.replace(/^_+/, "").replace(/_+$/, "");
  return s;
}

function normalizeBlockId(raw) {
  const s = normalizeIdToken(raw);
  if (!s) return null;
  if (s.includes(":")) return s;
  return `minecraft:${s}`;
}

function chooseToolForBlock(blockId) {
  const id = String(blockId || "").toLowerCase();

  // logs / wood
  if (id.includes("_log") || id.includes("wood") || id.includes("stem")) return "axe";

  // stone / ores
  if (
    id.includes("stone") ||
    id.includes("ore") ||
    id.includes("deepslate") ||
    id.includes("netherrack") ||
    id.includes("basalt") ||
    id.includes("andesite") ||
    id.includes("diorite") ||
    id.includes("granite")
  ) return "pickaxe";

  // dirt-ish
  if (
    id.includes("dirt") ||
    id.includes("sand") ||
    id.includes("gravel") ||
    id.includes("clay") ||
    id.includes("mud") ||
    id.includes("soul_sand")
  ) return "shovel";

  // default: pickaxe (più safe)
  return "pickaxe";
}

// =========================
// EllyAPI init
// =========================
const api = new EllyAPI({ host: BRIDGE_HOST, port: BRIDGE_PORT });

// fire-and-forget helper (don’t crash the loop)
function fire(cmd, timeoutMs) {
  api.cmd(cmd, timeoutMs).catch(() => null);
}

let speechChain = Promise.resolve();
let nextSpeechAt = 0;

const MC_CHAT_HARD_LIMIT = 240;
const MC_CHAT_SAFE_BUFFER = 40;
const MC_CHAT_SAFE_LIMIT = MC_CHAT_HARD_LIMIT - MC_CHAT_SAFE_BUFFER;

function normalizeSpeechText(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSpeechSmart(text, maxLen = MC_CHAT_SAFE_LIMIT) {
  const parts = [];
  let t = normalizeSpeechText(text);

  while (t.length > maxLen) {
    let cut = -1;

    // 1) prefer sentence boundaries
    for (const ch of [".", "!", "?"]) {
      const idx = t.lastIndexOf(ch, maxLen);
      if (idx > cut) cut = idx + 1;
    }

    // 2) then softer punctuation
    if (cut <= 0) {
      for (const ch of [";",","]) {
        const idx = t.lastIndexOf(ch, maxLen);
        if (idx > cut) cut = idx + 1;
      }
    }

    // 3) then whitespace
    if (cut <= 0) {
      cut = t.lastIndexOf(" ", maxLen);
    }

    // 4) last resort: hard cut
    if (cut <= 0) {
      cut = maxLen;
    }

    const chunk = t.slice(0, cut).trim();
    if (chunk) parts.push(chunk);

    t = t.slice(cut).trim();
  }

  if (t) parts.push(t);

  return parts;
}

function enqueueSpeechLine(text) {
  const t = normalizeSpeechText(text);
  if (!t) return;

  speechChain = speechChain
    .then(async () => {
      const wait = Math.max(0, nextSpeechAt - Date.now());
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }

      fire(`ELLY:SAY ${t}`, 1500);
      nextSpeechAt = Date.now() + CHAT_COOLDOWN_MS;
    })
    .catch(() => null);
}

function sayLong(text) {
  const parts = splitSpeechSmart(text, MC_CHAT_SAFE_LIMIT);
  for (const p of parts) {
    enqueueSpeechLine(p);
  }
}

function sayCharacter(text) {
  const t = normalizeSpeechText(text);
  if (!t) return;
  sayLong(t);
}

function saySystem(text) {
  if (!SYSTEM_MESSAGES_ENABLED) return;
  const t = normalizeSpeechText(text);
  if (!t) return;
  sayLong(`[sys] ${t}`);
}

// backward compatibility: all existing generic say() become character voice
function say(text) {
  sayCharacter(text);
}

function chat(text) {
  const t = String(text ?? "").replace(/\r?\n/g, " ").trim();
  if (!t) return;
  fire(`CHAT:${t}`, 1500);
}

function speakAction(actionName, mem, extra = {}) {
  mem.speech = mem.speech || {};

  const now = Date.now();

  const safeExtra = JSON.stringify(extra || {});
  const sig = `${String(actionName)}|${safeExtra}`;

  const lastSig = String(mem.speech.lastSig || "");
  const lastAt = Number(mem.speech.lastAt || 0);

  // same exact action already spoken recently -> skip
  if (sig === lastSig && now - lastAt < 15000) return;

  mem.speech.lastSig = sig;
  mem.speech.lastAt = now;

    if (!OLLAMA_ENABLED) return;

  askOllamaActionSpeech(actionName, mem, extra)
    .then((line) => {
      if (line) sayCharacter(line);
    })
    .catch(() => null);
}
// =========================
// Personality
// =========================
function loadPersonality() {
  if (!fs.existsSync(PERSONALITY_PATH)) throw new Error("personality.json not found");
  return JSON.parse(fs.readFileSync(PERSONALITY_PATH, "utf8"));
}
const personality = loadPersonality();

// =========================
// Memory
// =========================
function defaultMemory() {
  return {
    mode: DEFAULT_MODE,
    owner: null,
    facts: [],
    recent: [],
    locations: {},
    guard: { enabled: true, notifyOnly: false, postRetreat: null },
    combat: {
    enabled: false,
    mode: "normal", // normal | death
    targetKind: "hostile", // hostile | passive
    target: null,
    targetLockedAt: 0,
    lastCombatAt: 0,
    lastDamageAt: 0,
    lastDamageHp: null,
    lastBowShotAt: 0,
    lastRepositionAt: 0,
    lastSpeechAt: 0,
    lastFollowResumeAt: 0,
    lastLookPlayerAt: 0,
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
  };
}

function loadMemory() {
  const init = defaultMemory();

  if (!fs.existsSync(MEMORY_PATH)) {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(init, null, 2));
    return init;
  }

  try {
    const raw = fs.readFileSync(MEMORY_PATH, "utf8");
    if (!raw.trim()) {
      fs.writeFileSync(MEMORY_PATH, JSON.stringify(init, null, 2));
      return init;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid root");

    if (!Array.isArray(parsed.facts)) parsed.facts = [];
    if (!Array.isArray(parsed.recent)) parsed.recent = [];
    if (!parsed.locations || typeof parsed.locations !== "object") parsed.locations = {};
    if (!parsed.mode || typeof parsed.mode !== "string") parsed.mode = DEFAULT_MODE;

    if (!("owner" in parsed)) parsed.owner = null;

    if (!parsed.guard || typeof parsed.guard !== "object") {
      parsed.guard = { enabled: true, notifyOnly: false, postRetreat: null };
      } else {
      if (typeof parsed.guard.enabled !== "boolean") parsed.guard.enabled = true;
      if (typeof parsed.guard.notifyOnly !== "boolean") parsed.guard.notifyOnly = false;
      if (!("postRetreat" in parsed.guard)) parsed.guard.postRetreat = null;
    }

    if (!("active_goal" in parsed)) parsed.active_goal = null;
    
    if (!parsed.combat || typeof parsed.combat !== "object") {
  parsed.combat = {
    enabled: false,
    mode: "normal",
    target: null,
    targetLockedAt: 0,
    lastCombatAt: 0,
    lastDamageAt: 0,
    lastDamageHp: null,
    lastBowShotAt: 0,
    lastRepositionAt: 0,
    lastSpeechAt: 0,
    lastLookPlayerAt: 0,
  };
} else {
  if (typeof parsed.combat.enabled !== "boolean") parsed.combat.enabled = false;

  if (typeof parsed.combat.mode !== "string") parsed.combat.mode = "normal";
  if (!["normal", "death"].includes(String(parsed.combat.mode).toLowerCase())) {
    parsed.combat.mode = "normal";
  } else {
    parsed.combat.mode = String(parsed.combat.mode).toLowerCase();
  }
  if (typeof parsed.combat.targetKind !== "string") parsed.combat.targetKind = "hostile";
if (!["hostile", "passive"].includes(String(parsed.combat.targetKind).toLowerCase())) {
  parsed.combat.targetKind = "hostile";
} else {
  parsed.combat.targetKind = String(parsed.combat.targetKind).toLowerCase();
}

  if (!("target" in parsed.combat)) parsed.combat.target = null;
  if (typeof parsed.combat.targetLockedAt !== "number") parsed.combat.targetLockedAt = 0;
  if (typeof parsed.combat.lastCombatAt !== "number") parsed.combat.lastCombatAt = 0;
  if (typeof parsed.combat.lastDamageAt !== "number") parsed.combat.lastDamageAt = 0;
  if (!("lastDamageHp" in parsed.combat)) parsed.combat.lastDamageHp = null;

  if (typeof parsed.combat.lastBowShotAt !== "number") parsed.combat.lastBowShotAt = 0;
  if (typeof parsed.combat.lastRepositionAt !== "number") parsed.combat.lastRepositionAt = 0;
  if (typeof parsed.combat.lastSpeechAt !== "number") parsed.combat.lastSpeechAt = 0;
  if (typeof parsed.combat.lastFollowResumeAt !== "number") parsed.combat.lastFollowResumeAt = 0;
  if (typeof parsed.combat.lastLookPlayerAt !== "number") parsed.combat.lastLookPlayerAt = 0;
}

    if (!("active_goal" in parsed)) parsed.active_goal = null;
    if (!Array.isArray(parsed.goal_queue)) parsed.goal_queue = [];
    if (!parsed.areas || typeof parsed.areas !== "object") parsed.areas = {};

    if (!parsed.capabilities || typeof parsed.capabilities !== "object") {
      parsed.capabilities = { sleep: null, use: null };
    } else {
      if (!("sleep" in parsed.capabilities)) parsed.capabilities.sleep = null;
      if (!("use" in parsed.capabilities)) parsed.capabilities.use = null;
    }

    if (!parsed.world_snapshot || typeof parsed.world_snapshot !== "object") {
      parsed.world_snapshot = init.world_snapshot;
    } else {
      parsed.world_snapshot.at ||= 0;
      parsed.world_snapshot.pos ??= null;
      parsed.world_snapshot.biome ??= null;
      parsed.world_snapshot.dim ??= null;
      parsed.world_snapshot.inventory ??= {};
      parsed.world_snapshot.last_action ??= null;
      parsed.world_snapshot.last_action_at ||= 0;
      parsed.world_snapshot.last_error ??= null;
      parsed.world_snapshot.consecutive_timeouts ||= 0;

      parsed.world_snapshot.envRaw ??= null;
      parsed.world_snapshot.envInfo ??= null;
      parsed.world_snapshot.hp ??= null;
      parsed.world_snapshot.food ??= null;
      parsed.world_snapshot.hostiles ??= null;
      parsed.world_snapshot.hostiles_detail ??= [];
      parsed.world_snapshot.passives_detail ??= [];
      parsed.world_snapshot.last_retreat_at ||= 0;
      parsed.world_snapshot.last_ambient_at ||= 0;

      parsed.world_snapshot.owner_sleeping ??= false;
      parsed.world_snapshot.last_sleep_sync_at ||= 0;
      parsed.world_snapshot.last_eat_at ||= 0;
      parsed.world_snapshot.last_respawn_at ||= 0;
      parsed.world_snapshot.last_armor_check_at ||= 0;
    }

    parsed.mode = String(parsed.mode).toLowerCase();
    if (!["safe", "assist", "auto"].includes(parsed.mode)) parsed.mode = DEFAULT_MODE;

    return parsed;
  } catch (e) {
    const backup = `${MEMORY_PATH}.broken.${Date.now()}`;
    try { fs.copyFileSync(MEMORY_PATH, backup); } catch {}
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(init, null, 2));
    console.log(`[memory] invalid -> reset. Backup: ${backup}`);
    return init;
  }
}

function saveMemory(mem) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2));
}

function addRecent(mem, from, text) {
  mem.recent.push({ t: Date.now(), from, text });
  if (mem.recent.length > 30) mem.recent = mem.recent.slice(-30);
}

function summarizeMemory(mem) {
  const facts = mem.facts.slice(-30).map((f) => `- ${f}`).join("\n");
  const recent = mem.recent.slice(-8).map((r) => `${r.from}: ${r.text}`).join("\n");

  const locKeys = Object.keys(mem.locations || {});
  const locs = locKeys.length
    ? locKeys
        .slice(0, 20)
        .map((k) => {
          const v = mem.locations[k];
          if (!v) return null;
          return `- ${k} = (${v.x} ${v.y} ${v.z}) [${v.dim || "unknown"}]`;
        })
        .filter(Boolean)
        .join("\n")
    : "- (none)";

  const g = mem.active_goal;
  const goalLine = g
    ? `ACTIVE_GOAL: ${g.type} status=${g.status} ${g.label || ""}`.trim()
    : "ACTIVE_GOAL: (none)";

  const ownerLine = `OWNER: ${mem.owner || "(unset)"}`;

  return `${goalLine}\n${ownerLine}\n\nFACTS:\n${facts || "- (none)"}\n\nLOCATIONS:\n${
    locs || "- (none)"
  }\n\nRECENT:\n${recent || "(none)"}`;
}

// =========================
// Areas / AABB
// =========================
function toAabb(c1, c2) {
  const min = { x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y), z: Math.min(c1.z, c2.z) };
  const max = { x: Math.max(c1.x, c2.x), y: Math.max(c1.y, c2.y), z: Math.max(c1.z, c2.z) };
  return { min, max };
}

function isInsideAabb(pos, aabb) {
  if (!pos || !aabb) return false;
  return (
    pos.x >= aabb.min.x && pos.x <= aabb.max.x &&
    pos.y >= aabb.min.y && pos.y <= aabb.max.y &&
    pos.z >= aabb.min.z && pos.z <= aabb.max.z
  );
}

function isInHomeSafeArea(mem) {
  const ws = mem.world_snapshot;
  const area = mem.areas?.[HOME_NAME];
  if (!ws?.pos || !area) return false;
  if (area.dim && ws.dim && area.dim !== ws.dim) return false;
  return isInsideAabb(ws.pos, area.aabb);
}

function isRetreating(mem) {
  const g = mem?.active_goal;
  if (!g) return false;
  if (g.type !== "goto") return false;

  const label = String(g.label || "").toUpperCase();
  return label === HOME_NAME;
}
// =========================
// Safe JSON parse
// =========================
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model did not return JSON.");
    return JSON.parse(m[0]);
  }
}

// =========================
// Telemetry
// =========================
async function getTelemetrySnapshot() {
  const pos = await api.pos();
  const inv = await api.inv();
  if (DEBUG_INV_RAW) console.log("[DEBUG INV RAW][telemetry]", inv);
  return { pos, inv };
}

// ✅ NEW: vitals = single TEL:ONCE (no TEL:ON/OFF, no custom listener)
async function getVitalsOnce() {
  const telLine = await api.telOnce(1800).catch(() => null);
  return telLine;
}

// =========================
// Ambient / retreat
// =========================
function pickAmbientLine(ws) {
  const h = ws.hostiles ?? 0;
  if (h > 0) return `I have a bad feeling... ${h} hostile${h === 1 ? "" : "s"} nearby.`;
  const pool = [
    "Fine day today.",
    "It's quiet. Too quiet.",
    "I like this place.",
    "I could use a snack.",
    "I feel safer near home.",
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildFallbackRetreatTarget(mem, minDistance = 15) {
  const ws = mem.world_snapshot;
  const pos = ws?.pos;
  const hostiles = Array.isArray(ws?.hostiles_detail) ? ws.hostiles_detail : [];

  if (!pos || !hostiles.length) return null;

  const nearest = [...hostiles].sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))[0];
  if (!nearest) return null;

  let dx = pos.x - nearest.x;
  let dz = pos.z - nearest.z;

  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  dx /= len;
  dz /= len;

  return {
    x: Math.round(pos.x + dx * minDistance),
    y: Math.round(pos.y),
    z: Math.round(pos.z + dz * minDistance),
    dim: ws.dim || "minecraft:overworld",
  };
}

function startRetreatGoal(mem, reason) {
  const ws = mem.world_snapshot;
  const now = Date.now();
  if ((ws.last_retreat_at || 0) + RETREAT_COOLDOWN_MS > now) return false;

  const homeLoc = mem.locations?.[HOME_NAME];

    const fallback = buildFallbackRetreatTarget(mem, 15);

  const homeTooFar =
    homeLoc &&
    ws.pos &&
    homeLoc.dim === ws.dim &&
    dist2(ws.pos, homeLoc) > 96 * 96;

  if (!homeLoc || homeTooFar) {
    if (!fallback) {
      say(`Hostiles nearby (${reason}), but I have nowhere safe to run.`);
      api.stop().catch(() => null);
      ws.last_retreat_at = now;
      saveMemory(mem);
      return true;
    }

    clearGoals(mem, "interrupted_by_threat");

    if (mem.combat) {
      mem.combat.target = null;
      mem.combat.targetLockedAt = 0;
      mem.combat.lastCombatAt = now;
    }

    mem.active_goal = newGoal("goto", {
      label: "RETREAT_FALLBACK",
      target: fallback,
    });

    ws.last_retreat_at = now;
saveMemory(mem);

api.stop().catch(() => null);
api.goto(fallback.x, fallback.y, fallback.z).catch(() => null);

say(`Too dangerous here. Falling back.`);
speakAction("retreat_start", mem, {
  reason,
  targetName: "fallback",
});

return true;
  }

  clearGoals(mem, "interrupted_by_threat");

  if (mem.combat) {
    mem.combat.target = null;
    mem.combat.targetLockedAt = 0;
    mem.combat.lastCombatAt = now;
  }

  mem.active_goal = newGoal("goto", { label: HOME_NAME, target: { ...homeLoc } });
 ws.last_retreat_at = now;
saveMemory(mem);

api.stop().catch(() => null);
api.goto(homeLoc.x, homeLoc.y, homeLoc.z).catch(() => null);

say(`Hostiles nearby (${reason}). Going home.`);
speakAction("retreat_start", mem, { reason, targetName: "home" });

return true;
}

// =========================
// Farming helpers
// =========================
function tryParseFarm(userText) {
  const t = String(userText || "").trim().toLowerCase();

  // farm
  if (t === "farm") return { radius: 40 };

  // farm 12
  let m = t.match(/^farm\s+(\d+)\s*$/i);
  if (m) return { radius: Math.max(4, Math.min(32, Number(m[1]))) };

  return null;
}

function parseSenseCropsLine(line) {
  const s = String(line || "").trim();
  const out = [];

  if (!s.startsWith("OK:crops ")) return out;

  const payload = s.slice("OK:crops ".length).trim();
  if (!payload || payload === "none") return out;

  for (const tok of payload.split(";")) {
    const t = tok.trim();
    if (!t) continue;

    // format from bridge:
    // x,y,z=minecraft:wheat 7/7 ready
    const m = t.match(
      /^(-?\d+),(-?\d+),(-?\d+)=([a-z0-9_:\-]+)\s+(\d+)\/(\d+)\s+(ready|grow)$/i
    );
    if (!m) continue;

    out.push({
      x: Number(m[1]),
      y: Number(m[2]),
      z: Number(m[3]),
      block: m[4],
      age: Number(m[5]),
      maxAge: Number(m[6]),
      ready: String(m[7]).toLowerCase() === "ready",
    });
  }

  return out;
}

const CROP_SEED_BY_BLOCK = {
  "minecraft:wheat": "minecraft:wheat_seeds",
  "minecraft:carrots": "minecraft:carrot",
  "minecraft:potatoes": "minecraft:potato",
  "minecraft:beetroots": "minecraft:beetroot_seeds",
  "minecraft:nether_wart": "minecraft:nether_wart",
  "minecraft:cocoa": null, // cocoa placement is special; skip replant for now
  "minecraft:sweet_berry_bush": "minecraft:sweet_berries",
  "minecraft:torchflower_crop": "minecraft:torchflower_seeds",
  "minecraft:pitcher_crop": "minecraft:pitcher_pod",
};

function seedItemForCrop(blockId) {
  return CROP_SEED_BY_BLOCK[String(blockId || "").toLowerCase()] ?? null;
}

async function runFarmGoal(mem, g) {
  const ws = mem.world_snapshot;
  const here = ws.pos;
  if (!here) return;

  if (g.step === "scan") {
    const resp = await api.senseCrops(g.radius).catch((e) => `ERR:${e?.message || e}`);
    const s = String(resp || "");
    if (s.startsWith("ERR:")) throw new Error(s);

    const crops = parseSenseCropsLine(s);
    const ready = crops.filter((c) => c.ready);

    if (!ready.length) {
      saySystem("No mature crops nearby.");
      g.status = "completed";
      g.updatedAt = Date.now();
      mem.active_goal = null;
      return;
    }

    ready.sort((a, b) => {
      const da = dist2(here, { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 });
      const db = dist2(here, { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 });
      return da - db;
    });

    g.targets = ready;
    g.current = null;
    g.harvested = g.harvested || 0;
    g.step = "next";
    g.updatedAt = Date.now();
    return;
  }

  if (g.step === "next") {
    if (!Array.isArray(g.targets) || !g.targets.length) {
      saySystem(`Done farming. Harvested ${g.harvested || 0}.`);
      g.status = "completed";
      g.updatedAt = Date.now();
      mem.active_goal = null;
      return;
    }

    g.current = g.targets.shift();
    g.step = "goto";
    g.sentGoto = false;
    g.updatedAt = Date.now();
    return;
  }

  if (g.step === "goto") {
    const c = g.current;
    if (!c) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    const target = { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 };
    const d2 = dist2(here, target);

    if (!g.sentGoto) {
      g.sentGoto = true;
      g.updatedAt = Date.now();
      await api.goto(c.x, c.y, c.z).catch(() => null);
      return;
    }

    if (d2 <= 3.2 * 3.2) {
      await api.stop().catch(() => null);
      g.step = "harvest";
      g.updatedAt = Date.now();
    }

    return;
  }

  if (g.step === "harvest") {
    const c = g.current;
    if (!c) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    const status = await api.cropStatus(c.x, c.y, c.z).catch((e) => `ERR:${e?.message || e}`);
    const ss = String(status || "");

    // if no longer a crop / already gone, skip ahead
    if (ss.startsWith("ERR:")) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    // safety: harvest only if still ready=true
    if (!/ready=true/i.test(ss)) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    const h = await api.cropHarvest(c.x, c.y, c.z).catch((e) => `ERR:${e?.message || e}`);
    const hs = String(h || "");
    if (hs.startsWith("ERR:")) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    g.harvested = (g.harvested || 0) + 1;
    g.step = "replant_wait";
    g.updatedAt = Date.now();
    return;
  }

  if (g.step === "replant_wait") {
    // give drops / block update a moment
    if (!g._replantAt) g._replantAt = Date.now() + 10;
    if (Date.now() < g._replantAt) return;

    g._replantAt = 0;
    g.step = "replant";
    g.updatedAt = Date.now();
    return;
  }

  if (g.step === "replant") {
    const c = g.current;
    if (!c) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    const seedId = seedItemForCrop(c.block);
    if (!seedId) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    // equip seed if we have it
    const hasLine = await api.has(seedId).catch(() => null);
    const m = String(hasLine || "").match(/=(\d+)$/);
    const qty = m ? Number(m[1]) : 0;

    if (qty <= 0) {
      g.step = "next";
      g.updatedAt = Date.now();
      return;
    }

    await api.equipBest(`block:${seedId}`).catch(() => null);

    const p = await api.cropPlant(c.x, c.y, c.z).catch((e) => `ERR:${e?.message || e}`);
    const ps = String(p || "");
    // even if plant fails, continue to next crop
    g.step = "next";
    g.updatedAt = Date.now();
    return;
  }
}

function parseSenseChestsLine(line) {
  const s = String(line || "").trim();
  if (!s.startsWith("OK:chests ")) return [];

  const payload = s.slice("OK:chests ".length).trim();
  if (!payload || payload === "none") return [];

  const out = [];

  for (const tok of payload.split(";")) {
    const t = tok.trim();
    if (!t) continue;

    const m = t.match(/^(-?\d+),(-?\d+),(-?\d+)$/);
    if (!m) continue;

    out.push({
      x: Number(m[1]),
      y: Number(m[2]),
      z: Number(m[3]),
    });
  }

  return out;
}

function sameChest(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function parseHostilesDetailLine(line) {
  const s = String(line || "").trim();
  if (!s.startsWith("OK:hostiles_detail ")) return [];

  const payload = s.slice("OK:hostiles_detail ".length).trim();
  if (!payload || payload === "none") return [];

  const out = [];

  for (const tok of payload.split(";")) {
    const t = tok.trim();
    if (!t) continue;

    const m = t.match(/^([a-z0-9_:\-]+)@(-?\d+),(-?\d+),(-?\d+),([0-9.]+)$/i);
    if (!m) continue;

    out.push({
      type: m[1].toLowerCase(),
      x: Number(m[2]),
      y: Number(m[3]),
      z: Number(m[4]),
      distance: Number(m[5]),
    });
  }

  return out;
}

function parsePassivesDetailLine(line) {
  const s = String(line || "").trim();
  if (!s.startsWith("OK:passives_detail ")) return [];

  const payload = s.slice("OK:passives_detail ".length).trim();
  if (!payload || payload === "none") return [];

  const out = [];

  for (const tok of payload.split(";")) {
    const t = tok.trim();
    if (!t) continue;

    const m = t.match(/^([a-z0-9_:\-]+)@(-?\d+),(-?\d+),(-?\d+),([0-9.]+)$/i);
    if (!m) continue;

    out.push({
      type: m[1].toLowerCase(),
      x: Number(m[2]),
      y: Number(m[3]),
      z: Number(m[4]),
      distance: Number(m[5]),
    });
  }

  return out;
}

// =========================
// Deterministic command parsing
// =========================
function normalizeLocName(s) {
  return String(s).trim().toUpperCase().replace(/[^A-Z0-9_\-]/g, "_");
}

function tryParseMode(userText) {
  const m = userText.trim().match(/^mode\s+(safe|assist|auto)\s*$/i);
  if (!m) return null;
  return { mode: m[1].toLowerCase() };
}

function tryParseGuard(userText) {
  const t = userText.trim().toLowerCase();

  let m = t.match(/^(?:guard|threat|defense|defence)\s+(on|off|notify)\s*$/i);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === "on") return { enabled: true, notifyOnly: false, postRetreat: null };
    if (v === "off") return { enabled: false, notifyOnly: false, postRetreat: null };
    if (v === "notify") return { enabled: true, notifyOnly: true, postRetreat: null };
  }
  if (t === "guard") return { statusOnly: true };
  return null;
}

function tryParseFight(userText) {
  const t = userText.trim().toLowerCase();

  let m = t.match(/^fight\s+(on|off|death)\s*$/i);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === "on") return { enabled: true, mode: "normal" };
    if (v === "off") return { enabled: false, mode: "normal" };
    if (v === "death") return { enabled: true, mode: "death" };
  }

  if (t === "fight") return { statusOnly: true };
  return null;
}

function tryParseHunt(userText) {
  const t = userText.trim().toLowerCase();

  let m = t.match(/^hunt\s+(on|off)\s*$/i);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === "on") return { enabled: true };
    if (v === "off") return { enabled: false };
  }

  if (t === "hunt") return { statusOnly: true };
  return null;
}

function tryParseOwner(userText) {
  const m = userText.trim().match(/^owner\s+([A-Za-z0-9_]{2,32})\s*$/i);
  if (!m) return null;
  return { owner: m[1] };
}

function tryParseSaveLocation(userText) {
  const t = userText.trim();
  let m = t.match(
    /^(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(?:is|=|è)\s+([A-Za-z0-9_\-]{2,32})\s*$/i
  );
  if (!m) {
    m = t.match(
      /^(?:remember|ricorda)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(?:as|come)\s+([A-Za-z0-9_\-]{2,32})\s*$/i
    );
    if (!m) return null;
  }

  const x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
  const name = normalizeLocName(m[4]);
  if (![x, y, z].every(Number.isFinite)) return null;

  return { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z), name };
}

function tryParseForgetLocation(userText) {
  const m = userText.trim().match(/^(?:forget|dimentica|fgt)\s+([A-Za-z0-9_\-]{2,32})\s*$/i);
  if (!m) return null;
  return { name: normalizeLocName(m[1]) };
}

function tryParseGotoLocation(userText) {
  const m = userText.trim().match(/^(?:go\s+to|goto|vai\s+a)\s+([A-Za-z0-9_\-]{2,32})\s*$/i);
  if (!m) return null;
  return { name: normalizeLocName(m[1]) };
}

function tryParseStop(userText) {
  const t = userText.trim().toLowerCase();
  return t === "stop" || t === "stop?" || t === "halt" || t === "freeze";
}

function tryParseCancelGoal(userText) {
  const t = userText.trim().toLowerCase();
  return t === "cancel" || t === "abort" || t === "cancel goal" || t === "stop goal";
}

function tryParseGoalStatus(userText) {
  const t = userText.trim().toLowerCase();
  return t === "goal" || t === "goal?" || t === "status" || t === "task" || t === "tasks";
}

function tryParseFollow(userText) {
  const m = userText.trim().match(/^(?:follow)\s+([A-Za-z0-9_\-]{2,32})\s*$/i);
  if (!m) return null;
  return { player: m[1] };
}

function tryParseHelp(userText) {
  const t = String(userText || "").trim().toLowerCase();
  return t === "help" || t === "help?" || t === "commands" || t === "comandi";
}

function tryParseGotoCoords(userText) {
  const t = userText.trim();
  let m = t.match(/^(?:go\s+to|vai\s+a)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i);
  if (!m) m = t.match(/^goto\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i);
  if (!m) m = t.match(/^(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i);
  if (!m) return null;

  const x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) };
}

function tryParseRetreat(userText) {
  const t = userText.trim().toLowerCase();
  if (t === "retreat" || t === "run" || t === "go home" || t === "home") return { home: HOME_NAME };
  return null;
}

function tryParseMine(userText) {
  const m = userText.trim().match(/^mine\s+(.+?)(?:\s+(all|\d+))?\s*$/i);
  if (!m) return null;
  const block = normalizeBlockId(m[1]);
  if (!block) return null;
  const qty = m[2] ? String(m[2]).toLowerCase() : "all";
  return { block, qty };
}

function tryParseStoreChest(userText) {
  const t = String(userText || "").trim();

  // Support:
  // 1) store <what> in chest at x y z
  // 2) store <what> in chest x y z
  // 3) store <what> at chest x y z
  // 4) store <what> chest x y z
  let m =
    t.match(/^store\s+(.+?)\s+in\s+chest\s+at\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i) ||
    t.match(/^store\s+(.+?)\s+in\s+chest\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i) ||
    t.match(/^store\s+(.+?)\s+at\s+chest\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i) ||
    t.match(/^store\s+(.+?)\s+chest\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i);

    if (!m) {
    m = t.match(/^store\s+(.+?)\s+in\s+chest\s*$/i);
    if (m) {
      const whatRaw = String(m[1]).trim();
      const what = whatRaw.toLowerCase();
      const storeAll = what === "all" || what === "everything" || what === "all items";

      return {
        storeAll,
        query: storeAll ? "all" : whatRaw,
        x: null,
        y: null,
        z: null,
        useSavedChest: true,
      };
    }

    return null;
  }

  const whatRaw = String(m[1]).trim();
  const x = Number(m[2]), y = Number(m[3]), z = Number(m[4]);
  if (![x, y, z].every(Number.isFinite)) return null;

  const what = whatRaw.toLowerCase();
  const storeAll = what === "all" || what === "everything" || what === "all items";

  return {
    storeAll,
    query: storeAll ? "all" : whatRaw,
    x: Math.trunc(x),
    y: Math.trunc(y),
    z: Math.trunc(z),
  };
}

function wantsPos(userText) {
  const t = userText.trim().toLowerCase();
  return t === "pos" || t === "pos?" || t.includes("coords") || t.includes("coordinates") || t.includes("coordinate");
}

// “Does user ask an ACTION?”
function userWantsAction(text) {
  const t = String(text || "").toLowerCase().trim();
  return (
    t.startsWith("go ") ||
    t.startsWith("goto") ||
    t.startsWith("follow") ||
    t.startsWith("stop") ||
    t.startsWith("drop") ||
    t.startsWith("mine") ||
    t.startsWith("store") ||
    t.startsWith("vai") ||
    t.startsWith("segui") ||
    t.startsWith("segu") ||
    t.startsWith("ferma") ||
    t.startsWith("lascia") ||
    t.startsWith("mina") ||
    t.startsWith("metti")
  );
}

// =========================
// Goals
// =========================
function newGoal(type, payload = {}) {
  return {
    id: `g_${Date.now()}_${Math.floor(Math.random() * 9999)}`,
    type,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retries: 0,
    ...payload,
  };
}

function clearGoals(mem, reason = "cancelled") {
  if (mem.active_goal) {
    mem.active_goal.status = reason;
    mem.active_goal.updatedAt = Date.now();
  }
  mem.active_goal = null;
  mem.goal_queue = [];
}

function goalSummary(mem) {
  const g = mem.active_goal;
  if (!g) return "No active goal.";
  if (g.type === "goto")
    return `Goal: go to ${g.label || "target"} (${g.target.x} ${g.target.y} ${g.target.z}) status=${g.status}.`;
  if (g.type === "follow") return `Goal: follow ${g.player} status=${g.status}.`;
  if (g.type === "drop") return `Goal: drop ${g.item} x${g.qty} status=${g.status}.`;
  if (g.type === "mine") return `Goal: mine ${g.block} qty=${g.qty} status=${g.status}.`;
  if (g.type === "store_chest")
    return `Goal: store ${g.storeAll ? "all" : g.query} in chest at (${g.x} ${g.y} ${g.z}) step=${g.step} status=${g.status}.`;
  return `Goal: ${g.type} status=${g.status}.`;
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

async function runStoreChestGoal(mem, g) {
  const snap = mem.world_snapshot;
  const here = snap.pos;
  if (!here) throw new Error("no_pos");

  if (!Array.isArray(g.triedChests)) {
    g.triedChests = [{ x: g.x, y: g.y, z: g.z }];
  }

  const stand = { x: g.x + 1, y: g.y, z: g.z };
  const tgt = { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 };

  if (g.step === "goto") {
    if (!g.sentGoto) {
      g.sentGoto = true;
      g.updatedAt = Date.now();
      say("On my way.");
      await api.goto(g.x + 1, g.y, g.z).catch(() => null);
      return;
    }

    if (dist2(here, tgt) <= 1.6 * 1.6) {
      g.step = "open";
      g.updatedAt = Date.now();
    }
    return;
  }

  if (g.step === "open") {
    const resp = await api.chestOpen(g.x, g.y, g.z).catch((e) => `ERR:${e?.message || e}`);
    if (String(resp).startsWith("ERR:")) throw new Error(resp);

    await new Promise((r) => setTimeout(r, CHEST_POST_OPEN_WAIT_MS));
    g.step = "put";
    g.updatedAt = Date.now();
    return;
  }

  if (g.step === "put") {
    const invBefore = await api.inv();
    if (DEBUG_INV_RAW) console.log("[DEBUG INV RAW][store_before]", invBefore);

    const slotsBefore = parseInvLineSlots(invBefore);
    let targetId = null;

    if (!g.storeAll) {
      const totalsBefore = parseInvLineTotals(invBefore);
      const m = matchItemFromInv(g.query, totalsBefore);
      if (!m.id || (totalsBefore[m.id] || 0) <= 0) {
        g.step = "close";
        g.updatedAt = Date.now();
        return;
      }
      targetId = m.id;
    }

    let picked = null;
    for (const s of slotsBefore) {
      if (!s) continue;
      if (s.count <= 0) continue;

      if (g.storeAll) {
        if (isProtectedId(s.id)) continue;
        picked = s;
        break;
      } else {
        if (s.id.toLowerCase() === String(targetId).toLowerCase()) {
          picked = s;
          break;
        }
      }
    }

    if (!picked) {
      g.step = "close";
      g.updatedAt = Date.now();
      return;
    }

    const pickedSlot = picked.slot;
    const pickedId = String(picked.id || "").toLowerCase();
    const pickedCountBefore = Number(picked.count || 0);

    const putResp = await api.chestPut(pickedSlot, "all");
    if (String(putResp).startsWith("ERR:")) {
      g.retries = (g.retries || 0) + 1;
      if (g.retries <= 2) {
        g.step = "open";
        g.updatedAt = Date.now();
        return;
      }
      throw new Error(putResp);
    }

    const invAfter = await api.inv().catch(() => null);
    if (DEBUG_INV_RAW && invAfter) console.log("[DEBUG INV RAW][store_after]", invAfter);

    let movedSomething = true;

    if (invAfter) {
      const slotsAfter = parseInvLineSlots(invAfter);
      const sameSlotAfter = slotsAfter.find((s) => s && s.slot === pickedSlot);

      if (
        sameSlotAfter &&
        String(sameSlotAfter.id || "").toLowerCase() === pickedId &&
        Number(sameSlotAfter.count || 0) >= pickedCountBefore
      ) {
        movedSomething = false;
      }
    }

    if (!movedSomething) {
      g.step = "switch_chest";
      g.updatedAt = Date.now();
      return;
    }

    g.retries = 0;
    g.updatedAt = Date.now();
    return;
  }

  if (g.step === "switch_chest") {
    await api.chestClose().catch(() => null);

    const scan = await api.senseChests(50).catch((e) => `ERR:${e?.message || e}`);
    const chests = parseSenseChestsLine(scan);

    if (!chests.length) {
      g.step = "close";
      g.updatedAt = Date.now();
      return;
    }

    const untried = chests.filter(
      (c) => !g.triedChests.some((t) => sameChest(t, c))
    );

    if (!untried.length) {
      say("All nearby chests seem full.");
      g.step = "close";
      g.updatedAt = Date.now();
      return;
    }

    if (here) {
      untried.sort((a, b) => dist2(here, a) - dist2(here, b));
    }

    const nextChest = untried[0];
    g.x = nextChest.x;
    g.y = nextChest.y;
    g.z = nextChest.z;
    g.sentGoto = false;
    g.retries = 0;
    g.triedChests.push({ x: nextChest.x, y: nextChest.y, z: nextChest.z });
    g.step = "goto";
    g.updatedAt = Date.now();

    saySystem("Chest full. Switching chest.");
    return;
  }

  if (g.step === "close") {
    await api.chestClose().catch(() => null);
    g.status = "completed";
    g.updatedAt = Date.now();
    saySystem("Done.");
    mem.active_goal = null;
  }
}

async function tickGoals(mem) {
  const g = mem.active_goal;
  if (!g) return;
  if (g.status !== "running") return;

  const snap = mem.world_snapshot;

  if ((snap.consecutive_timeouts || 0) >= MAX_CONSEC_TIMEOUTS) {
    g.status = "failed";
    g.updatedAt = Date.now();
    snap.last_error = `Too many timeouts (${snap.consecutive_timeouts})`;
    say("Bridge not reliable. Goal failed.");
    mem.active_goal = null;
    return;
  }

  if (g.type === "goto") {
    if (snap.dim && g.target?.dim && snap.dim !== g.target.dim) {
      g.status = "blocked";
      g.updatedAt = Date.now();
      say(
        `${g.label || "That place"} is in ${g.target.dim}, but I'm in ${snap.dim}. I can't cross dimensions yet.`
      );
      mem.active_goal = null;
      return;
    }

    if (!snap.pos) return;

    const here = { x: snap.pos.x, y: snap.pos.y, z: snap.pos.z };
    const tgt = { x: g.target.x + 0.5, y: g.target.y + 0.5, z: g.target.z + 0.5 };

    const d2 = dist2(here, tgt);

        // Normal goto completion
    if (d2 <= 2.0 * 2.0) {
      say("Arrived.");
      speakAction("arrived", mem, { label: g.label || null });

      g.status = "completed";
      g.updatedAt = Date.now();
      mem.active_goal = null;
    }
    return;
  }

  if (g.type === "follow") return;
  if (g.type === "drop") {
    g.status = "completed";
    g.updatedAt = Date.now();
    mem.active_goal = null;
    return;
  }
  if (g.type === "mine") return;

if (g.type === "farm") {
  await runFarmGoal(mem, g);
  return;
}

if (g.type === "store_chest") {
  await runStoreChestGoal(mem, g);
  return;
}
}

// =========================
// Fast-path inventory/have/drop
// =========================
async function fastInventoryResponses(userText) {
  const t = userText.trim().toLowerCase();

  const wantsInventoryList =
    t === "inventory" ||
    t.includes("your inventory") ||
    t.includes("what do you have") ||
    t.includes("inventario");

  const mHave = t.match(/^(?:do you have|hai)\s+(.+?)\??$/i);
  const mDrop = t.match(/^(?:drop)\s+(.+?)(?:\s+(all|\d+))?\s*$/i);
  const mGive = t.match(/^(?:give(?:\s+me)?)\s+(.+?)(?:\s+(all|\d+))?\s*$/i);

  if (!(wantsInventoryList || mHave || mDrop || mGive)) return false;

  let invLine;
  try {
    invLine = await api.inv();
  } catch (e) {
    say(`Inventory request failed (${e.message}).`);
    return true;
  }

  if (DEBUG_INV_RAW) console.log("[DEBUG INV RAW][fastpath]", invLine);

  const invMap = parseInvLineTotals(invLine);

  if (wantsInventoryList) {
    say(`I have: ${prettyInv(invMap)}`);
    return true;
  }

  if (mHave) {
    const raw = mHave[1].trim();
    const m = matchItemFromInv(raw, invMap);

    if (!m.id) {
      say(`I can't find "${raw}" in my inventory.`);
      return true;
    }

    const qty = invMap[m.id] || 0;
    say(qty > 0 ? `Yes: ${m.name} x${qty}.` : `No, I don't have ${m.name}.`);
    return true;
  }

  const giveLike = mGive || mDrop;
  if (giveLike) {
    const raw = giveLike[1].trim();
    const wantRaw = giveLike[2];
    const wantAll = wantRaw && String(wantRaw).toLowerCase() === "all";
    const want = wantAll ? Number.MAX_SAFE_INTEGER : wantRaw ? Number(wantRaw) : 1;

    const m = matchItemFromInv(raw, invMap);
    if (!m.id) {
      say(`I can't find "${raw}" in my inventory.`);
      return true;
    }

    const have = invMap[m.id] || 0;
    if (have <= 0) {
      say(`I don't have ${m.name}.`);
      return true;
    }

    const n = wantAll ? have : Math.max(1, Math.min(want, have));
    await api.drop(m.id, n).catch(() => null);
    say(`Dropped ${m.name} x${n}.`);
    return true;
  }

  return false;
}

// =========================
// Auto Eat / Sleep helpers
// =========================
function looksUnsupported(resp) {
  const s = String(resp || "").toLowerCase();
  return (
    s.includes("unknown") ||
    s.includes("unsupported") ||
    s.includes("err") ||
    s.includes("invalid") ||
    s.includes("unrecognized")
  );
}


async function tryAutoRespawn(mem) {
  const ws = mem.world_snapshot;
  const now = Date.now();

  if (typeof ws.hp !== "number") return false;
  if (ws.hp > 0) return false;

  if ((ws.last_respawn_at || 0) + 4000 > now) return true;

  ws.last_respawn_at = now;

  console.log("[respawn] attempting auto respawn");

  await api.cmd("RESPAWN").catch(() => null);

  return true;
}

async function tryAutoLookOwner(mem) {
  const ws = mem.world_snapshot;
  const now = Date.now();

  if (!mem.owner) return false;

  const g = mem.active_goal;
  if (!g || g.type !== "follow") return false;

  if (mem.combat?.enabled && Array.isArray(ws.hostiles_detail) && ws.hostiles_detail.length > 0) {
    return false;
  }

  if ((mem.combat?.lastLookPlayerAt || 0) + 1500 > now) return false;

  if (!ws?.pos) return false;

  const playerLine = await api.playerPos(mem.owner).catch(() => null);
  const s = String(playerLine || "").trim();

  const m = s.match(/^OK:player_pos\s+([A-Za-z0-9_]+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i);
  if (!m) return false;

  const px = Number(m[2]);
  const py = Number(m[3]);
  const pz = Number(m[4]);

  if (![px, py, pz].every(Number.isFinite)) return false;

  const d2 = dist2(ws.pos, { x: px, y: py, z: pz });
  if (d2 > 5 * 5) return false;

  mem.combat.lastLookPlayerAt = now;
  await api.lookAt(px, py + 1.6, pz).catch(() => null);
  return true;
}

async function tryAutoEquipArmor(mem) {
  const ws = mem.world_snapshot;
  const now = Date.now();

  if ((ws.last_armor_check_at || 0) + 30000 > now) return false;
  ws.last_armor_check_at = now;

  const resp = await api.cmd("INV:EQUIPARMORBEST", 2000).catch(() => null);
  const s = String(resp || "").trim();

  if (/^OK:equiparmor\b/i.test(s)) {
    const m = s.match(/changed=(\d+)/i);
    const changed = m ? Number(m[1]) : 0;
    return changed > 0;
  }

  return false;
}

async function trySleepOnce(mem) {
  const ws = mem.world_snapshot;
  const now = Date.now();

  if ((ws.last_sleep_sync_at || 0) + SLEEP_COOLDOWN_MS > now) return;   
  if (mem.capabilities?.sleep === false) return;
  if ((ws.hostiles ?? 0) > 0) return;

  ws.last_sleep_sync_at = now;
  saveMemory(mem);

  say("Good night!");
    speakAction("sleep_start", mem, {});
  // 1️⃣ find bed
  const find = await api.cmd("BED:FIND 16", 3000).catch(() => null);
  const findS = String(find || "").trim();
  console.log("[sleep_find] resp:", findS);

  const m = findS.match(/free=([-\d]+),([-\d]+),([-\d]+)/);
  if (!m) {
    say("No free bed nearby.");
    return;
  }

  const bx = Number(m[1]);
  const by = Number(m[2]);
  const bz = Number(m[3]);

  // 2️⃣ try sleep
  const resp = await api.cmd(`BED:SLEEP ${bx} ${by} ${bz}`, 4000).catch(() => null);
  const s = String(resp || "").trim();
  console.log("[sleep] resp:", s);

  if (/^ERR:/i.test(s)) {
    say(`Sleep failed: ${s}`);
    return;
  }

  say("Zzz...");
}

// =========================
// Ollama
// =========================
const SYSTEM_PROMPT = `
You are Elly, an AI Minecraft companion.

IMPORTANT:
- You MUST output ONLY a single JSON object. No extra text.
- Keep answers short (1-2 sentences).
- Never claim you did something in the world unless confirmed by telemetry.

JSON SCHEMA:
{
  "say": "string",
  "commands": [
    {"tool":"say","args":{"text":"..."}},
    {"tool":"goto","args":{"x":0,"y":0,"z":0}},
    {"tool":"follow","args":{"player":"Name"}},
    {"tool":"stop","args":{}},
    {"tool":"drop","args":{"query":"stone","qty":1}},
    {"tool":"mine","args":{"block":"minecraft:oak_log","qty":"all"}}
  ],
  "memory_add": ["string"]
}

TOOLS RULES:
- Only use commands if user clearly asks for an action.
- Never exceed 3 commands.
- Prefer deterministic parsing for obvious commands, otherwise just chat.
`.trim();

const AMBIENT_PROMPT = `
Generate ONE short in-world ambient comment in Elly voice.
Rules:
- 1 sentence only (maximum 190 characters).
- No commands, no JSON.
- Must reflect signals: hp/food/hostiles/dim/time/weather if present.
- Use biome instead of generic dimension names like "overworld".
- If hostiles>0: focus on danger.
- If hungry: mention food.
- Avoid sounding like a videogame NPC.
`.trim();

const ACTION_SPEECH_PROMPT = `
Generate ONE short in-world reply in Elly voice for an action that has ALREADY started.
Rules:
- 1 sentence only.
- Max 140 characters.
- No JSON.
- No commands.
- No narration like "*does X*".
- Sound personal and in-character.
- Do not repeat the raw action name.
- The action is already happening, so speak as confirmation / attitude / intent.
`.trim();

async function fetchWithTimeout(url, options, timeoutMs = 60000, retries = 2) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;

      const msg = String(e?.message || e);
      const isAbort =
        e?.name === "AbortError" ||
        msg.toLowerCase().includes("aborted") ||
        msg.toLowerCase().includes("abort");

      if (attempt < retries && isAbort) {
        console.log(`[ollama] request aborted/timeout, retry ${attempt + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }

      throw e;
    }
  }

  throw lastErr || new Error("fetch_failed");
}

async function sleepViaLookUse(x, y, z) {
  await api.cmd(`LOOK:AT ${x + 0.5} ${y + 0.6} ${z + 0.5}`, 1200).catch(() => null);
  await api.cmd(`USE:START`, 800).catch(() => null);
  await new Promise((r) => setTimeout(r, 1100));
  await api.cmd(`USE:STOP`, 800).catch(() => null);
}

async function askOllamaAmbient(mem, ws) {
  const body = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      {
        role: "system",
        content: `Personality:\n${personality.core}\n\n${AMBIENT_PROMPT}`
      },
      {
        role: "user",
        content:
          `Signals:\n` +
          `${describeEnvironmentForPrompt(ws.envInfo)}\n` +
          `biome=${ws.biome}\n` +
          `dimension=${ws.dim}\n` +
          `hp=${ws.hp}\n` +
          `food=${ws.food}\n` +
          `hostiles=${ws.hostiles}\n` +
          `pos=${ws.pos ? `${ws.pos.x},${ws.pos.y},${ws.pos.z}` : "null"}\n`
      }
    ]
  };

  const res = await fetchWithTimeout(
    OLLAMA_URL,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    20000,
    1
  );

  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const text = String(data?.message?.content ?? "").trim();
  if (!text) return null;

  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

async function askOllamaActionSpeech(actionName, mem, extra = {}) {
  const ws = mem?.world_snapshot || {};

  const body = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      {
        role: "system",
        content: `Personality:\n${personality.core}\n\n${ACTION_SPEECH_PROMPT}`
      },
      {
        role: "user",
        content:
          `Action=${actionName}\n` +
          `Mode=${mem?.mode || "auto"}\n` +
          `Guard=${JSON.stringify(mem?.guard || {})}\n` +
          `Biome=${ws.biome}\n` +
          `Dimension=${ws.dim}\n` +
          `HP=${ws.hp}\n` +
          `Food=${ws.food}\n` +
          `Hostiles=${ws.hostiles}\n` +
          `Extra=${JSON.stringify(extra)}\n`
      }
    ]
  };

  const res = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    12000,
    1
  );

  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const text = String(data?.message?.content ?? "").trim();
  if (!text) return null;

  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}
async function askOllama(userText, mem, telemetrySnap) {
  const memoryBlock = summarizeMemory(mem);

  const body = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          `Personality:\n${personality.core}\n\n` +
          `Style:\n${
            typeof personality.style === "string"
              ? personality.style
              : JSON.stringify(personality.style)
          }\n\n` +
          `Rules:\n${
            typeof personality.rules === "string"
              ? personality.rules
              : JSON.stringify(personality.rules)
          }\n\n` +
          SYSTEM_PROMPT,
      },
      {
        role: "user",
        content:
          `Telemetry:\n${telemetrySnap.pos}\n${telemetrySnap.inv}\n\n` +
          `Memory:\n${memoryBlock}\n\n` +
          `User says: ${userText}\n\n` +
          `Return the JSON now.`,
      },
    ],
  };

  const res = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    60000,
    2
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data?.message?.content ?? "";
}

function filterByMode(mode, cmds) {
  const m = String(mode || DEFAULT_MODE).toLowerCase();
  const commands = Array.isArray(cmds) ? cmds : [];

  if (m === "safe") return { run: [], reason: "safe_mode" };

  if (m === "assist") {
    const ALLOW = new Set(["say", "goto", "follow", "stop"]);
    return { run: commands.filter((c) => ALLOW.has(String(c?.tool || "").toLowerCase())), reason: "assist_whitelist" };
  }

  const ALLOW = new Set(["say", "goto", "follow", "stop", "drop", "mine"]);
  return { run: commands.filter((c) => ALLOW.has(String(c?.tool || "").toLowerCase())), reason: "auto_whitelist" };
}

// =========================
// LLM tool -> action mapping
// =========================
async function toolToAction(mem, cmd) {
  const tool = String(cmd?.tool || "").toLowerCase();
  const args = cmd?.args || {};

  if (tool === "say") {
    const text = String(args.text ?? "").trim();
    if (!text) return null;
    return async () => say(text);
  }

  if (tool === "goto") {
    const x = Number(args.x), y = Number(args.y), z = Number(args.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return async () => api.goto(Math.trunc(x), Math.trunc(y), Math.trunc(z));
  }

  if (tool === "follow") {
    const player = String(args.player ?? "").trim();
    if (!player) return null;
    return async () => api.follow(player);
  }

  if (tool === "stop") return async () => api.stop();

  if (tool === "drop") {
    const qtyRaw = args.qty ?? 1;
    let want = 1;

    if (typeof qtyRaw === "string" && qtyRaw.toLowerCase() === "all") {
      want = Number.MAX_SAFE_INTEGER;
    } else {
      const n = Number(qtyRaw);
      if (Number.isFinite(n) && n > 0) want = Math.trunc(n);
    }

    const query = String(args.id ?? args.query ?? "").trim();
    if (!query) return null;

    const invMap = mem?.world_snapshot?.inventory || {};
    const m = matchItemFromInv(query, invMap);
    if (!m.id) return null;

    const have = invMap[m.id] || 0;
    if (have <= 0) return null;

    const n = Math.max(1, Math.min(want, have));
    return async () => api.drop(m.id, n);
  }

  if (tool === "mine") {
    const block = normalizeBlockId(args.block ?? args.id ?? "");
    if (!block) return null;

    let qty = args.qty;
    if (qty == null) qty = "all";
    if (typeof qty === "number") qty = String(Math.trunc(qty));
    qty = String(qty).toLowerCase();

    const mineCmd = qty === "all" ? `#mine ${block}` : `#mine ${block} ${qty}`;

    // ✅ Ensure correct tool is equipped before mining/lumber.
    // Uses bridge INV:EQUIPBEST (axe/pickaxe/shovel) and falls back silently.
    const kind = chooseToolForBlock(block);
    return async () => {
      try {
        if (kind) await api.equipBest(kind).catch(() => null);
      } catch {}
      chat(mineCmd);
    };
  }

  return null;
}

// =========================
// World snapshot update
// =========================
function updateCombatDamageState(mem, newHp) {
  const combat = mem.combat || (mem.combat = {});
  const now = Date.now();
  const prevHp = combat.lastDamageHp;

  if (typeof newHp !== "number") return;

  if (typeof prevHp === "number") {
    const delta = prevHp - newHp;

    // retreat trigger only on meaningful spike damage
    if (delta >= 4) {
      combat.lastDamageAt = now;
      combat.lastDamageTaken = delta;
    }
  }

  combat.lastDamageHp = newHp;
}

function updateSnapshotFromTelemetry(mem, snap) {
  const ws = mem.world_snapshot;
  ws.at = Date.now();

  const p = parsePosLine(snap.pos);
  if (p) {
    ws.pos = { x: p.x, y: p.y, z: p.z };
    ws.dim = p.dim;
  }

  if (snap.inv && snap.inv.startsWith("INV:")) {
    ws.inventory = parseInvLineTotals(snap.inv);
  }

  ws.last_error = null;
  ws.consecutive_timeouts = 0;
}

function markTimeout(mem, where) {
  const ws = mem.world_snapshot;
  ws.last_error = `timeout:${where}`;
  ws.consecutive_timeouts = (ws.consecutive_timeouts || 0) + 1;
}

// =========================
// Main
// =========================
console.log("Elly Brain (EllyAPI) Ready.");
console.log(`Reading chat from: ${SERVER_LOG}`);
console.log(`Bridge: ${BRIDGE_HOST}:${BRIDGE_PORT}`);
console.log(`Trigger in MC: ${TRIGGER} <message>`);
console.log(`Mode default: ${DEFAULT_MODE}`);
console.log(`Ollama URL: ${OLLAMA_URL}`);
console.log(`UI path: ${UI_PATH}`);
console.log(`Bot name: ${BOT_NAME}`);
console.log(`System messages: ${SYSTEM_MESSAGES_ENABLED}`);
console.log(`Chat cooldown ms: ${CHAT_COOLDOWN_MS}`);
console.log(`Ollama enabled: ${OLLAMA_ENABLED}`);
if (DEBUG_INV_RAW) console.log(`DEBUG_INV_RAW: true`);

if (!fs.existsSync(SERVER_LOG)) {
  console.error("Server log not found. Set ELLY_LOG in .env or instancePath in UI.json.");
  process.exit(1);
}

const logPath = SERVER_LOG.replace(/\\/g, "/");
const mem = loadMemory();

// HOME migration from facts -> locations
(() => {
  const HOME_NAME_LOCAL = "HOME";
  if (mem.locations?.[HOME_NAME_LOCAL]) return;

  const hit = (mem.facts || []).find((f) =>
    String(f || "").toUpperCase().startsWith(HOME_NAME_LOCAL + "=")
  );
  if (!hit) return;

  const rhs = String(hit).split("=", 2)[1] || "";
  const parts = rhs.split(",").map((x) => x.trim());
  if (parts.length < 3) return;

  const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
  if (![x, y, z].every(Number.isFinite)) return;

  const dim = mem.world_snapshot?.dim || "minecraft:overworld";
  mem.locations[HOME_NAME_LOCAL] = { x, y, z, dim };
  saveMemory(mem);
  console.log("[memory] HOME migrated from facts -> locations");
})();

if (!mem.mode) mem.mode = DEFAULT_MODE;

const tail = new Tail(logPath, { useWatchFile: true });

// =========================
// Processing queue (FIX: never drop lines)
// =========================
const lineQueue = [];
let queueBusy = false; // ONLY for log queue
let loopBusy = false;  // ONLY for brain loop

async function processOneLogLine(line) {
  // system bed lines (sleep sync)
  if (SLEEP_SYNC_ENABLED) {
  const sys = extractSystemChat(line);
  if (sys) {
    const ev = parseSleepEventFromSystemLine(sys);
    if (ev && mem.owner && String(ev.player) === String(mem.owner)) {
      mem.world_snapshot.owner_sleeping = !!ev.sleeping;
      saveMemory(mem);

      if (ev.sleeping) {
        await trySleepOnce(mem).catch(() => null);
      }
    }
  }
}
  const msg = parseChatLine(line);
  if (!msg) return;

  // --- TRIGGER FILTER (hard gate) ---
  const raw = String(msg.userText || "");
  const low = raw.toLowerCase();


  if (!low.trimStart().startsWith(TRIGGER)) return;

  const idx = low.indexOf(TRIGGER);
  let after = raw.slice(idx + TRIGGER.length).trim();
  after = after.replace(/^[:,\-\s]+/, "").trim();
  if (!after) return;

  msg.userText = after;

  // Owner set only on first triggered msg
  if (!mem.owner) {
    mem.owner = msg.from;
    saveMemory(mem);
    saySystem(`Owner set to ${mem.owner}.`);
  }

  addRecent(mem, msg.from, msg.userText);
  saveMemory(mem);

  if (tryParseHelp(msg.userText)) {
  say("Commands: help | mode safe | assist | auto | guard on | off | notify | fight on | off | death | hunt on | off | pos | goto <x y z> | goto <NAME> | home area <x1 y1 z1 x2 y2 z2> | store <item> in chest at <x y z> | mine <block> [all|N] | farm [radius] | follow <player> | stop");
    return;
}

  // deterministic: owner command
  const ocmd = tryParseOwner(msg.userText);
  if (ocmd) {  
    mem.owner = ocmd.owner;
    saveMemory(mem);
    say(`Owner set to ${mem.owner}.`);
    return;
  }

    if (tryParseStop(msg.userText)) {
    clearGoals(mem, "cancelled");

    if (mem.combat) {
      mem.combat.enabled = false;
      mem.combat.target = null;
      mem.combat.targetLockedAt = 0;
    }

    saveMemory(mem);
    saySystem("Stopping.");
    await api.stop().catch(() => null);
    return;
  }

    if (tryParseCancelGoal(msg.userText)) {
    clearGoals(mem, "cancelled");

    if (mem.combat) {
      mem.combat.enabled = false;
      mem.combat.target = null;
      mem.combat.targetLockedAt = 0;
    }

    saveMemory(mem);
    saySystem("Cancelled the current goal.");
    return;
  }

  if (tryParseGoalStatus(msg.userText)) {
    saySystem(goalSummary(mem));
    return;
  }

  const modeCmd = tryParseMode(msg.userText);
  if (modeCmd) {
    mem.mode = modeCmd.mode;
    saveMemory(mem);
    saySystem(`Mode set to ${mem.mode}.`);  
    return;
  }

  const gcmd = tryParseGuard(msg.userText);
  if (gcmd) {
    if (gcmd.statusOnly) {
      let s = "OFF";
      if (mem.guard?.enabled) {
        if (mem.guard.notifyOnly) s = "ON (notify)";
        else s = "ON (retreat)";
      }
      saySystem(`Guard is ${s}.`);
      return;
    }

    mem.guard.enabled = gcmd.enabled;
    mem.guard.notifyOnly = gcmd.notifyOnly;
    mem.guard.postRetreat = gcmd.postRetreat ?? null;

    saveMemory(mem);

        let s = "OFF";
    if (mem.guard.enabled) {
      if (mem.guard.notifyOnly) s = "ON (notify only)";
      else s = "ON (retreat)";
    }

    saySystem(`Guard set to ${s}.`);
    speakAction("guard_set", mem, { state: s });
    return;
  }
  
  const fcmd = tryParseFight(msg.userText);
if (fcmd) {
  if (fcmd.statusOnly) {
    const s = mem.combat?.enabled
      ? `ON (${mem.combat?.mode || "normal"}, ${mem.combat?.targetKind || "hostile"})`
      : "OFF";
    saySystem(`Fight is ${s}.`);
    return;
  }

  mem.combat.enabled = fcmd.enabled;
  mem.combat.mode = fcmd.mode;
  mem.combat.targetKind = "hostile";

  // mutually exclusive: fight disables guard
  if (mem.guard) {
    mem.guard.enabled = false;
    mem.guard.notifyOnly = false;
    mem.guard.postRetreat = null;
  }

  if (!fcmd.enabled) {
    mem.combat.target = null;
    mem.combat.targetLockedAt = 0;
    mem.combat.lastCombatAt = 0;
  }

  saveMemory(mem);

  const s = mem.combat.enabled
  ? `ON (${mem.combat.mode}, hostile)`
  : "OFF";

saySystem(`Fight set to ${s}.`);

if (mem.combat.enabled) {
  speakAction("fight_start", mem, {
    mode: mem.combat.mode,
    targetKind: "hostile",
  });
}

return;
}

const hcmd = tryParseHunt(msg.userText);
if (hcmd) {
  if (hcmd.statusOnly) {
    const active = !!mem.combat?.enabled && String(mem.combat?.targetKind || "") === "passive";
    saySystem(`Hunt is ${active ? "ON" : "OFF"}.`);
    return;
  }

  mem.combat.enabled = hcmd.enabled;
  mem.combat.mode = "normal";
  mem.combat.targetKind = "passive";

  // mutually exclusive: hunt disables guard
  if (mem.guard) {
    mem.guard.enabled = false;
    mem.guard.notifyOnly = false;
    mem.guard.postRetreat = null;
  }

  if (!hcmd.enabled) {
    mem.combat.target = null;
    mem.combat.targetLockedAt = 0;
    mem.combat.lastCombatAt = 0;
  }

  saveMemory(mem);

  saySystem(`Hunt set to ${mem.combat.enabled ? "ON" : "OFF"}.`);

if (mem.combat.enabled) {
  speakAction("hunt_start", mem, {
    mode: mem.combat.mode,
    targetKind: "passive",
  });
}

return;
}
  const ha = tryParseHomeArea(msg.userText);
  if (ha) {
    if (ha.action === "status") {
      const area = mem.areas?.[HOME_NAME];
      if (!area) {
        say("Home safe area is not set.");
        return;
      }
      const { min, max } = area.aabb;
      say(`Home safe area: (${min.x} ${min.y} ${min.z}) -> (${max.x} ${max.y} ${max.z}).`);
      return;
    }

    if (ha.action === "clear") {
      if (mem.areas?.[HOME_NAME]) {
        delete mem.areas[HOME_NAME];
        saveMemory(mem);
        saySystem("Home safe area cleared.");
      } else {
        say("Home safe area was not set.");
      }
      return;
    }

    // set
    let dimLine = "";
    try { dimLine = await api.pos(); } catch {}
    const dim =
      parsePosLine(dimLine)?.dim ||
      mem.world_snapshot?.dim ||
      "minecraft:overworld";

    mem.areas[HOME_NAME] = { dim, aabb: toAabb(ha.c1, ha.c2) };
    saveMemory(mem);
    saySystem("Home safe area set.");
    return;
  }

  const r = tryParseRetreat(msg.userText);
  if (r) {
    startRetreatGoal(mem, "manual");
    return;
  }

  const farmCmd = tryParseFarm(msg.userText);
if (farmCmd) {
  mem.active_goal = newGoal("farm", {
    label: "farm",
    radius: farmCmd.radius,
    step: "scan",
    targets: [],
    current: null,
    harvested: 0,
  });
  saveMemory(mem);
  saySystem(`Start farming: scan radius ${farmCmd.radius}.`);
  speakAction("farm_start", mem, { radius: farmCmd.radius });
  return;
}

  const storeCmd = tryParseStoreChest(msg.userText);
if (storeCmd) {
  let chestX = storeCmd.x;
  let chestY = storeCmd.y;
  let chestZ = storeCmd.z;

  if (storeCmd.useSavedChest) {
    const chestLoc = mem.locations?.CHEST;

    if (chestLoc) {
      chestX = chestLoc.x;
      chestY = chestLoc.y;
      chestZ = chestLoc.z;
    } else {
      const scan = await api.senseChests(50).catch((e) => `ERR:${e?.message || e}`);
      const chests = parseSenseChestsLine(scan);

      if (!chests.length) {
        say("No nearby chests found.");
        return;
      }

      const here = mem.world_snapshot?.pos;
      if (here) {
        chests.sort((a, b) => dist2(here, a) - dist2(here, b));
      }

      chestX = chests[0].x;
      chestY = chests[0].y;
      chestZ = chests[0].z;
    }
  }

    mem.active_goal = newGoal("store_chest", {
    label: "store_chest",
    status: "running",
    step: "goto",
    sentGoto: false,
    storeAll: storeCmd.storeAll,
    query: storeCmd.query,
    x: chestX,
    y: chestY,
    z: chestZ,
    triedChests: [{ x: chestX, y: chestY, z: chestZ }],
  });
  saveMemory(mem);
  saySystem(storeCmd.storeAll ? "Start storing items in chest." : `Start storing ${storeCmd.query} in chest.`);
  speakAction("store_start", mem, {
  storeAll: storeCmd.storeAll,
  query: storeCmd.query,
  x: chestX,
  y: chestY,
  z: chestZ,
  });
  return;
}

  const mineCmd = tryParseMine(msg.userText);
  if (mineCmd) {
    mem.active_goal = newGoal("mine", {
      block: mineCmd.block,
      qty: mineCmd.qty,
      label: mineCmd.block,
    });
    saveMemory(mem);

    saySystem(`Start mining ${mineCmd.block}.`);
    speakAction("mine_start", mem, { block: mineCmd.block, qty: mineCmd.qty });

    // ✅ Equip the correct tool before issuing Baritone mine.
    // (Bridge handles equip; Baritone handles path+break.)
    try {
      const kind = chooseToolForBlock(mineCmd.block);
      if (kind) await api.equipBest(kind).catch(() => null);
    } catch {}

    if (mineCmd.qty === "all") chat(`#mine ${mineCmd.block}`);
    else chat(`#mine ${mineCmd.block} ${mineCmd.qty}`);
    return;
  }

  const followCmd = tryParseFollow(msg.userText);
  if (followCmd) {
    mem.active_goal = newGoal("follow", { player: followCmd.player, label: followCmd.player });
    saveMemory(mem);
    saySystem(`Start follow ${followCmd.player}.`);
    speakAction("follow_start", mem, { player: followCmd.player });
    await api.follow(followCmd.player).catch(() => null);
    return;
  }

  const gotoCoords = tryParseGotoCoords(msg.userText);
  if (gotoCoords) {
    let snap;
    try {
      snap = await getTelemetrySnapshot();
    } catch (e) {
      markTimeout(mem, "telemetry_goto");
      saveMemory(mem);
      say(`Can't read position right now (${e.message}).`);
      return;
    }

    const dim = parsePosLine(snap.pos)?.dim || "minecraft:overworld";

    mem.active_goal = newGoal("goto", {
      label: "coords",
      target: { x: gotoCoords.x, y: gotoCoords.y, z: gotoCoords.z, dim },
    });
    saveMemory(mem);

    saySystem("On my way.");
    speakAction("goto_coords", mem, { x: gotoCoords.x, y: gotoCoords.y, z: gotoCoords.z });
    await api.goto(gotoCoords.x, gotoCoords.y, gotoCoords.z).catch(() => null);
    return;
  }

  if (wantsPos(msg.userText)) {
    try {
      const pos = await api.pos();
      saySystem(pos);
    } catch (e) {
      markTimeout(mem, "pos");
      saveMemory(mem);
      say(`POS request failed (${e.message}).`);
    }
    return;
  }

  const saveLoc = tryParseSaveLocation(msg.userText);
  if (saveLoc) {
    let snapLine = "";
    try {
      snapLine = await api.pos();
    } catch (e) {
      markTimeout(mem, "save_loc_pos");
      saveMemory(mem);
      say(`Can't read position right now (${e.message}).`);
      return;
    }

    const dim = parsePosLine(snapLine)?.dim || "minecraft:overworld";
    mem.locations[saveLoc.name] = { x: saveLoc.x, y: saveLoc.y, z: saveLoc.z, dim };
    saveMemory(mem);
    saySystem(`Saved location ${saveLoc.name}.`);
    return;
  }

  const forgetLoc = tryParseForgetLocation(msg.userText);
  if (forgetLoc) {
    if (mem.locations[forgetLoc.name]) {
      delete mem.locations[forgetLoc.name];
      saveMemory(mem);
      saySystem(`Removed location ${forgetLoc.name}.`);
    } else {
      say(`Location ${forgetLoc.name} not found.`);
    }
    return;
  }

  const gotoLoc = tryParseGotoLocation(msg.userText);
  if (gotoLoc) {
    const loc = mem.locations[gotoLoc.name];
    if (!loc) {
      say(`Location ${gotoLoc.name} not found. Provide coordinates first.`);
      return;
    }

    mem.active_goal = newGoal("goto", { label: gotoLoc.name, target: { ...loc } });
    saveMemory(mem);

    saySystem(`Going to ${gotoLoc.name}.`);
    speakAction("goto_location", mem, { name: gotoLoc.name });
    await api.goto(loc.x, loc.y, loc.z).catch(() => null);
    return;
  }

  const handledInv = await fastInventoryResponses(msg.userText);
  if (handledInv) return;

  // --- LLM path (chat always ok, commands only if action requested) ---
  let telemetrySnap;
  try {
    telemetrySnap = await getTelemetrySnapshot();
  } catch (e) {
    markTimeout(mem, "telemetry_llm");
    saveMemory(mem);
    say(`Bridge telemetry failed (${e.message}).`);
    return;
  }

  updateSnapshotFromTelemetry(mem, telemetrySnap);
  saveMemory(mem);

    let plan = null;

  if (!OLLAMA_ENABLED) {
    saySystem("Ollama is disabled.");
    return;
  }

  try {
    const out = await askOllama(msg.userText, mem, telemetrySnap);
    plan = safeJsonParse(out);
  } catch (e) {
    console.log("[ollama/chat] error:", e?.message || e);
    sayCharacter("I had a thinking hiccup.");
    return;
  }

  if (Array.isArray(plan.memory_add)) {
    for (const f of plan.memory_add) {
      if (typeof f === "string" && f.trim()) mem.facts.push(f.trim());
    }
    mem.facts = Array.from(new Set(mem.facts)).slice(-100);
    saveMemory(mem);
  }

  if (plan.say && String(plan.say).trim()) {
    say(String(plan.say));
  }

  const allowCommands = userWantsAction(msg.userText);
  const rawCmds = allowCommands && Array.isArray(plan.commands) ? plan.commands : [];
  const limited = rawCmds.slice(0, MAX_COMMANDS_PER_CYCLE);
  const { run } = filterByMode(mem.mode, limited);

  for (const c of run) {
    try {
      const act = await toolToAction(mem, c);
      if (!act) continue;
      await act().catch(() => null);
    } catch (e) {
      console.log("[llm-action] error:", e?.message || e);
    }
  }
}

async function drainQueue() {
  if (queueBusy) return;
  queueBusy = true;

  try {
    while (lineQueue.length) {
      const line = lineQueue.shift();
      try {
        await processOneLogLine(line);
      } catch (e) {
        console.log("Error:", e?.message || e);
      }
    }
  } finally {
    queueBusy = false;
  }
}

function tryParseHomeArea(userText) {
  const t = String(userText || "").trim();

  // set: "home area x1 y1 z1 x2 y2 z2"
  let m = t.match(
    /^home\s+area\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i
  );
  if (m) {
    return {
      action: "set",
      c1: { x: Math.trunc(+m[1]), y: Math.trunc(+m[2]), z: Math.trunc(+m[3]) },
      c2: { x: Math.trunc(+m[4]), y: Math.trunc(+m[5]), z: Math.trunc(+m[6]) },
    };
  }

  // clear: "home area off|clear|remove"
  if (/^home\s+area\s+(off|clear|remove)\s*$/i.test(t)) return { action: "clear" };

  // status: "home area" or "home area?"
  if (/^home\s+area\s*\??$/i.test(t)) return { action: "status" };

  return null;
}

// Tail line handler (now queues instead of dropping)
tail.on("line", (line) => {
  lineQueue.push(line);
  drainQueue().catch(() => null);
});

tail.on("error", (err) => console.error("Tail error:", err));

// connect once at startup
(async () => {
  try {
    await api.connect();
  } catch (e) {
    console.log("[ellyApi] connect failed:", e?.message || e);
  }
})();

// =========================
// Brain loop
// =========================
setInterval(async () => {
  if (queueBusy || loopBusy) return;

  loopBusy = true;
  try {
    // =========================
    // CORE TELEMETRY (only this should count as real loop timeout)
    // =========================
    let snap;
    try {
      snap = await getTelemetrySnapshot();
      updateSnapshotFromTelemetry(mem, snap);
    } catch (e) {
      markTimeout(mem, "loop_telemetry");
      saveMemory(mem);
      return;
    }

    // =========================
    // SECONDARY SENSES (must never break the loop)
    // =========================
    try {
      const hLine = await api.senseHostiles();
      const h = parseHostilesLine(hLine);
      if (h != null) mem.world_snapshot.hostiles = h;
    } catch {}

    try {
  const hdLine = await api.senseHostilesDetail(16);
  mem.world_snapshot.hostiles_detail = parseHostilesDetailLine(hdLine);
} catch {
  mem.world_snapshot.hostiles_detail = [];
}

try {
  const pdLine = await api.sensePassivesDetail(16);
  mem.world_snapshot.passives_detail = parsePassivesDetailLine(pdLine);
} catch {
  mem.world_snapshot.passives_detail = [];
}

    try {
      const bLine = await api.senseBiome();
      const m = String(bLine || "").match(/OK:biome\s+(.+)\s*$/i);
      if (m) mem.world_snapshot.biome = m[1].trim();
    } catch {}
    
        try {
      const envLine = await api.senseEnv(4);
      const parsedEnv = parseEnvLine(envLine);

      mem.world_snapshot.envRaw = parsedEnv;

      if (parsedEnv) {
        mem.world_snapshot.envInfo = classifyEnvironment(parsedEnv, {
          dim: mem.world_snapshot.dim,
          y: mem.world_snapshot?.pos?.y,
          biome: mem.world_snapshot.biome,
        });
      } else {
        mem.world_snapshot.envInfo = null;
      }
    } catch {
      mem.world_snapshot.envRaw = null;
      mem.world_snapshot.envInfo = null;
    }

    try {
      if (SLEEP_SYNC_ENABLED && mem.owner) {
        const sLine = await api.sensePlayerSleep(mem.owner);
        const sleeping = /sleeping\s*=\s*true/i.test(String(sLine));
        mem.world_snapshot.owner_sleeping = !!sleeping;

        if (sleeping) {
          await trySleepOnce(mem).catch(() => null);
        }
      }
    } catch {}

    try {
  const tel = await getVitalsOnce();
  const v = parseTelLine(tel);

  if (v) {
    mem.world_snapshot.hp = v.hp;
    mem.world_snapshot.food = v.food;
    if (typeof v.hp === "number") updateCombatDamageState(mem, v.hp);
  }
} catch {}

if (await tryAutoRespawn(mem).catch(() => false)) {
  saveMemory(mem);
  return;
}

try {
  await tryAutoEquipArmor(mem).catch(() => false);
} catch {}

    try {
      await tryAutoLookOwner(mem);
    } catch {}


    // =========================
    // AMBIENT
    // =========================
    try {
      if (
        AMBIENT_COMMENT_ENABLED &&
        (mem.world_snapshot.last_ambient_at || 0) + AMBIENT_COMMENT_PERIOD_MS <= Date.now()
      ) {
        mem.world_snapshot.last_ambient_at = Date.now();
        saveMemory(mem);

        let line = null;

        if (OLLAMA_ENABLED) {
          try {
            line = await askOllamaAmbient(mem, mem.world_snapshot);
          } catch {}
        }

        if (!line) line = pickAmbientLine(mem.world_snapshot);
        if (line) sayCharacter(line);
      }
    } catch {}

    // =========================
    // REFLEX
    // =========================
    try {
      await reflexTick({
        mem,
        api,
        config: {
          AUTO_EAT_ENABLED,
          EAT_FOOD_THRESHOLD,
          EAT_COOLDOWN_MS,
          SLEEP_SYNC_ENABLED,
          SLEEP_COOLDOWN_MS,
          RETREAT_ON_HOSTILES,
          RETREAT_HOSTILES_THRESHOLD,
          RETREAT_HP_THRESHOLD,
          RETREAT_COOLDOWN_MS,
          AMBIENT_COMMENT_ENABLED: false,
          AMBIENT_COMMENT_PERIOD_MS,
        },
        helpers: {
          saveMemory,
          looksUnsupported,
          trySleepOnce,
          isInHomeSafeArea,
          isRetreating,
          startRetreatGoal,
          pickAmbientLine,
          say,
        },
      });
    } catch (e) {
      console.log("[reflexTick] error:", e?.message || e);
    }

    // =========================
    // COMBAT
    // =========================
    try {
      await combatTick({
        mem,
        api,
        config: {
          RETREAT_HP_THRESHOLD,
          RETREAT_HOSTILES_THRESHOLD,
        },
        helpers: {
          startRetreatGoal,
          saveMemory,
          say,
        },
      });
    } catch (e) {
      console.log("[combatTick] error:", e?.message || e);
    }

    // =========================
    // GOALS
    // =========================
    try {
      await tickGoals(mem);
    } catch (e) {
      console.log("[tickGoals] error:", e?.message || e);
    }

    saveMemory(mem);
  } finally {
    loopBusy = false;
  }

}, LOOP_MS);