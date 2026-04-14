// brain/reflexes.js (ESM)
//
// Reflex tick: auto-eat, sleep sync, guard/retreat, ambient comments
// Fix:
// - ambient uses fire-and-forget (helpers.say) to avoid cmd() interleaving/timeouts
// - guard won't spam retreat if already retreating / on cooldown
// - sleep sync cooldown handled by trySleepOnce (do not pre-set last_sleep_sync_at here)

export async function reflexTick(ctx) {
  const { mem, api, config, helpers } = ctx;

  const ws = mem.world_snapshot || (mem.world_snapshot = {});
  const now = Date.now();

  // -------------------------
  // AUTO EAT
  // -------------------------
  if (config.AUTO_EAT_ENABLED) {
    const food = ws.food;
    const canTry =
      food != null &&
      food <= config.EAT_FOOD_THRESHOLD &&
      (ws.last_eat_at || 0) + config.EAT_COOLDOWN_MS <= now;

    if (canTry) {
      ws.last_eat_at = now;
      helpers.saveMemory(mem);

      const resp = await api.cmd("EAT:BEST 1600", 2500).catch(() => null);

      if (helpers.looksUnsupported(resp)) mem.capabilities.use = false;
      else mem.capabilities.use = true;

      helpers.saveMemory(mem);
    }
  }

  // -------------------------
  // SLEEP SYNC
  // -------------------------
  if (config.SLEEP_SYNC_ENABLED && mem.owner && ws.owner_sleeping) {
    // Let trySleepOnce manage cooldown + capability + timestamps
    await helpers.trySleepOnce(mem).catch(() => null);
  }

  // -------------------------
  // GUARD / RETREAT
  // -------------------------
    const inHome = helpers.isInHomeSafeArea(mem);

  const fightEnabled = !!mem.combat?.enabled;
  const deathMode = String(mem.combat?.mode || "normal").toLowerCase() === "death";

  if (mem.guard?.enabled && !mem.guard?.notifyOnly && !inHome) {
    const h = ws.hostiles ?? 0;
    const hp = ws.hp;

    // in fight normal: retreat only by HP, not by hostile count
    // in fight death: never retreat from reflex layer
    const byHp = !deathMode && hp != null && hp <= config.RETREAT_HP_THRESHOLD;
    const byHostiles =
      !fightEnabled &&
      config.RETREAT_ON_HOSTILES &&
      h >= config.RETREAT_HOSTILES_THRESHOLD;

    const alreadyRetreating =
      (typeof helpers.isRetreating === "function" && helpers.isRetreating(mem)) ||
      (mem.active_goal &&
        mem.active_goal.type === "goto" &&
        String(mem.active_goal.label || "").toUpperCase() === "HOME");

    const cooledDown =
      (ws.last_retreat_at || 0) + (config.RETREAT_COOLDOWN_MS || 0) <= now;

    if (!alreadyRetreating && cooledDown) {
      if (byHp) helpers.startRetreatGoal(mem, `hp=${hp}`);
      else if (byHostiles) helpers.startRetreatGoal(mem, `count=${h}`);
    }
  }

  // -------------------------
  // AMBIENT COMMENT
  // -------------------------
  if (
    config.AMBIENT_COMMENT_ENABLED &&
    (ws.last_ambient_at || 0) + config.AMBIENT_COMMENT_PERIOD_MS <= now
  ) {
    ws.last_ambient_at = now;
    helpers.saveMemory(mem);

    const line = helpers.pickAmbientLine(ws);

    // Prefer fire-and-forget say to avoid cmd() waiting on a reply while TEL lines interleave
    if (typeof helpers.say === "function") {
      helpers.say(line);
    } else {
      // fallback (still best-effort)
      api.cmd(`ELLY:SAY ${String(line).replace(/\r?\n/g, " ")}`, 1500).catch(() => null);
    }
  }
}