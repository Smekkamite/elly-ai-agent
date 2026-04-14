// combat.js — Elly combat system
// Compatible with current bot.js + EllyAPI

const SPEECH_COOLDOWN = 8000;

const PRIORITY = {
  "minecraft:creeper": 1,
  "minecraft:skeleton": 2,
  "minecraft:stray": 2,
  "minecraft:drowned": 3,
  "minecraft:spider": 4,
  "minecraft:cave_spider": 4,
  "minecraft:zombie": 5,
  "minecraft:husk": 5,
};

const ALWAYS_AVOID = new Set([
  "minecraft:blaze",
  "minecraft:ghast",
  "minecraft:wither_skeleton",
  "minecraft:zombified_piglin",
  "minecraft:piglin",
]);

const MELEE_FORBIDDEN = new Set([
  "minecraft:creeper",
  "minecraft:drowned",
  "minecraft:phantom",
  "minecraft:blaze",
  "minecraft:ghast",
  "minecraft:wither_skeleton",
  "minecraft:zombified_piglin",
  "minecraft:piglin",
]);


const MELEE_MAX_DIST = 6;
const SAFE_MELEE = 3;
const MELEE_HIT_DIST = 2.8;
const MELEE_COOLDOWN_MS = 650;
const CHASE_REFRESH_MS = 900;
const CREEPER_PANIC_DIST = 6;
const MODDED_PANIC_DIST = 9;
const DAMAGE_SPIKE_WINDOW_MS = 2000;
const TARGET_LOCK_MS = 2500;
const REPOSITION_COOLDOWN_MS = 1200;
const FOLLOW_RESUME_COOLDOWN_MS = 1200;
const NORMAL_RETREAT_HP = 10;
const PASSIVE_TARGETS = new Set([
  "minecraft:pig",
  "minecraft:cow",
  "minecraft:rabbit",
  "minecraft:chicken",
  "minecraft:sheep",
]);

function dist(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function targetKey(t) {
  return `${String(t.type || "").toLowerCase()}@${Math.floor(t.x || 0)},${Math.floor(t.y || 0)},${Math.floor(t.z || 0)}`;
}

function isFightEnabled(mem) {
  return !!mem?.combat?.enabled;
}

function getTargetKind(mem) {
  const k = String(mem?.combat?.targetKind || "hostile").toLowerCase();
  return k === "passive" ? "passive" : "hostile";
}

function isPassiveTarget(type) {
  return PASSIVE_TARGETS.has(String(type || "").toLowerCase());
}

function getSenseList(mem, ws) {
  const kind = getTargetKind(mem);
  if (kind === "passive") {
    return Array.isArray(ws?.passives_detail) ? ws.passives_detail : [];
  }
  return Array.isArray(ws?.hostiles_detail) ? ws.hostiles_detail : [];
}

function isCombatEnabled(mem) {
  return isFightEnabled(mem);
}

function isDeathMode(mem) {
  return String(mem?.combat?.mode || "normal").toLowerCase() === "death";
}

function canMeleeNow(mem) {
  return (Date.now() - Number(mem?.combat?.lastMeleeAt || 0)) >= MELEE_COOLDOWN_MS;
}

function canRefreshChase(mem) {
  return (Date.now() - Number(mem?.combat?.lastChaseAt || 0)) >= CHASE_REFRESH_MS;
}

function isVanillaHostile(type) {
  return String(type || "").startsWith("minecraft:");
}


function hasMeleeWeapon(ws) {
  const inv = ws?.inventory || {};
  return Object.keys(inv).some((id) => {
    const s = String(id).toLowerCase();
    return s.endsWith("_sword") || s.endsWith("_axe");
  });
}

function normalizeTarget(raw, ws) {
  if (!raw || !raw.type) return null;

  const t = {
    type: String(raw.type || "").toLowerCase(),
    x: Number(raw.x),
    y: Number(raw.y),
    z: Number(raw.z),
    distance: Number.isFinite(raw.distance) ? Number(raw.distance) : null,
  };

  if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) return null;

  if (!Number.isFinite(t.distance) && ws?.pos) {
    t.distance = dist(ws.pos, t);
  }

  t.key = targetKey(t);
  t.priority = PRIORITY[t.type] ?? 100;
t.isVanilla = String(t.type || "").startsWith("minecraft:");
t.isPassive = isPassiveTarget(t.type);

  return t;
}

function shouldRetreatForDamage(mem) {
  const last = Number(mem?.combat?.lastDamageAt || 0);
  if (!last) return false;
  return Date.now() - last < DAMAGE_SPIKE_WINDOW_MS;
}

function shouldAvoidTarget(mem, target) {
  if (!target) return true;

  if (ALWAYS_AVOID.has(target.type)) return true;
  if (!target.isVanilla) return true;
  if (!target.isVanilla && target.distance < MODDED_PANIC_DIST) return true;

  return false;
}

function shouldMeleeTarget(target) {
  return !MELEE_FORBIDDEN.has(target.type);
}

function sortTargets(targets) {
  targets.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.distance ?? 999) - (b.distance ?? 999);
  });
  return targets;
}

function getLockedTarget(mem, ws) {
  const locked = mem?.combat?.target;
  if (!locked) return null;

  const lockAt = Number(mem?.combat?.targetLockedAt || 0);
  if (lockAt && Date.now() - lockAt > TARGET_LOCK_MS) return null;

  const list = getSenseList(mem, ws);

  for (const raw of list) {
    const t = normalizeTarget(raw, ws);
    if (!t) continue;

    if (typeof locked === "object" && locked.key && t.key === locked.key) return t;
    if (typeof locked === "string" && t.key === locked) return t;
  }

  return null;
}

function pickTarget(mem, ws) {
  const list = getSenseList(mem, ws);
  if (!list.length) return null;

  const targets = list
    .map((raw) => normalizeTarget(raw, ws))
    .filter(Boolean);

  if (!targets.length) return null;

  sortTargets(targets);
  return targets[0];
}

function chooseCombatMode(mem, ws, target) {
  if (target.type === "minecraft:creeper" && target.distance < CREEPER_PANIC_DIST) {
    return "retreat";
  }

  if (!target.isVanilla && target.distance < MODDED_PANIC_DIST) {
    return "retreat";
  }

  if (shouldAvoidTarget(mem, target)) {
    return "retreat";
  }

  if (target.distance <= MELEE_MAX_DIST && shouldMeleeTarget(target) && hasMeleeWeapon(ws)) {
    return "melee";
  }

  if (shouldMeleeTarget(target) && hasMeleeWeapon(ws)) {
    return "melee";
  }

  return "retreat";
}


async function equipMelee(api) {
  await api.equipBest("sword").catch(() => null);
}


async function doChase(mem, api, target) {
  await api.lookAt(target.x, target.y + 1.0, target.z).catch(() => null);

  if (!canRefreshChase(mem)) return;

  mem.combat.lastChaseAt = Date.now();
  await api.goto(Math.trunc(target.x), Math.trunc(target.y), Math.trunc(target.z)).catch(() => null);
}

async function doMeleeHit(mem, api, target) {
  if ((target.distance ?? 999) > MELEE_HIT_DIST) return;
  if (!canMeleeNow(mem)) return;

  mem.combat.lastMeleeAt = Date.now();

  await equipMelee(api);
  await api.lookAt(target.x, target.y + 1.0, target.z).catch(() => null);
  await new Promise((r) => setTimeout(r, 90));
  await api.lookAt(target.x, target.y + 1.0, target.z).catch(() => null);
  await api.cmd("MELEE:HIT").catch(() => null);
}

async function doReposition(ctx) {
  const { mem, api } = ctx;
  const now = Date.now();

  if ((mem?.combat?.lastRepositionAt || 0) + REPOSITION_COOLDOWN_MS > now) return;

  mem.combat.lastRepositionAt = now;
  await api.stop().catch(() => null);
}

async function retreat(mem, helpers, reason = "combat") {
  if (typeof helpers?.startRetreatGoal === "function") {
    helpers.startRetreatGoal(mem, reason);
  }
}

function updateCombatState(mem, target) {
  if (!mem.combat) mem.combat = {};
  if (typeof mem.combat.lastMeleeAt !== "number") mem.combat.lastMeleeAt = 0;
  if (typeof mem.combat.lastChaseAt !== "number") mem.combat.lastChaseAt = 0;

  mem.combat.target = target ? { key: target.key, type: target.type } : null;
  mem.combat.targetLockedAt = target ? Date.now() : 0;
  mem.combat.lastCombatAt = Date.now();
}

function maybeSay(mem, helpers, text) {
  if (typeof helpers?.say !== "function") return;

  const now = Date.now();
  if ((mem?.combat?.lastSpeechAt || 0) + SPEECH_COOLDOWN > now) return;

  mem.combat.lastSpeechAt = now;
  helpers.say(text);
}

async function maybeResumeFollow(ctx) {
  const { mem, api } = ctx;
  const g = mem?.active_goal;

  if (!g || g.type !== "follow" || !g.player) return;

  const now = Date.now();
  if ((mem?.combat?.lastFollowResumeAt || 0) + FOLLOW_RESUME_COOLDOWN_MS > now) return;

  mem.combat.lastFollowResumeAt = now;
  await api.follow(g.player).catch(() => null);
}

export async function combatTick(ctx) {
  const { mem, api, helpers } = ctx;
  const ws = mem?.world_snapshot || {};

  if (!isCombatEnabled(mem)) return;
  if (!ws?.pos) return;
  if (!isDeathMode(mem) && typeof ws.hp === "number" && ws.hp <= NORMAL_RETREAT_HP) {
    await retreat(mem, helpers, `low_hp=${ws.hp}`);
    updateCombatState(mem, null);
    return;
  }

  const senseList = getSenseList(mem, ws);

if (!Array.isArray(senseList) || senseList.length === 0) {
  updateCombatState(mem, null);
  await maybeResumeFollow(ctx);
  return;
}

  if (!isDeathMode(mem) && shouldRetreatForDamage(mem)) {
    await retreat(mem, helpers, "damage_spike");
    updateCombatState(mem, null);
    return;
  }

  let target = getLockedTarget(mem, ws);
  if (!target) target = pickTarget(mem, ws);

  if (!target) {
    updateCombatState(mem, null);
    await maybeResumeFollow(ctx);
    return;
  }

  if (getTargetKind(mem) === "hostile" && !target.isVanilla) {
  maybeSay(mem, helpers, `Unknown hostile ${target.type}. Retreating.`);
  await retreat(mem, helpers, `modded_${target.type}`);
  updateCombatState(mem, null);
  return;
}

 const kind = getTargetKind(mem);

if (kind === "passive") {
  updateCombatState(mem, target);

  if ((target.distance ?? 999) > MELEE_HIT_DIST) {
    await doChase(mem, api, target);
    return;
  }

  await doMeleeHit(mem, api, target);
  return;
}

const mode = chooseCombatMode(mem, ws, target);

if (mode === "retreat") {
  if (!target.isVanilla) {
    maybeSay(mem, helpers, `Dangerous hostile ${target.type}. Retreating.`);
  }
  await retreat(mem, helpers, `avoid_${target.type}`);
  updateCombatState(mem, null);
  return;
}

updateCombatState(mem, target);

if (mode === "melee") {
  if ((target.distance ?? 999) > MELEE_HIT_DIST) {
    await doChase(mem, api, target);
    return;
  }

  await doMeleeHit(mem, api, target);
}
}