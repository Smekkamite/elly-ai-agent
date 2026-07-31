import test from "node:test";
import assert from "node:assert/strict";

import {
  addRecent,
  createDefaultMemory,
  expireStaleGoals,
  normalizeMemory,
  summarizeMemory,
} from "../core/memory.js";
import { normalizePersonality } from "../core/personality.js";

test("memory migration repairs malformed fields while preserving useful state", () => {
  const memory = normalizeMemory(
    {
      mode: "INVALID",
      owner: "CrookedFox",
      facts: ["home", "home", "", 42],
      recent: "broken",
      combat: { enabled: 1, mode: "DEATH", targetKind: "PASSIVE" },
      world_snapshot: { inventory: null, hostiles_detail: null },
      custom_future_field: { keep: true },
    },
    createDefaultMemory("assist"),
  );

  assert.equal(memory.mode, "assist");
  assert.deepEqual(memory.facts, ["home"]);
  assert.deepEqual(memory.recent, []);
  assert.equal(memory.combat.enabled, true);
  assert.equal(memory.combat.mode, "death");
  assert.equal(memory.combat.targetKind, "passive");
  assert.deepEqual(memory.world_snapshot.inventory, {});
  assert.deepEqual(memory.custom_future_field, { keep: true });
});

test("recent memory is bounded and prompt summary includes owner and goal", () => {
  const memory = createDefaultMemory();
  memory.owner = "CrookedFox";
  memory.active_goal = { type: "follow", status: "running", label: "owner" };

  for (let index = 0; index < 40; index += 1) {
    addRecent(memory, "CrookedFox", `message ${index}`);
  }

  assert.equal(memory.recent.length, 30);
  const summary = summarizeMemory(memory);
  assert.match(summary, /OWNER: CrookedFox/);
  assert.match(summary, /ACTIVE_GOAL: follow status=running owner/);
  assert.doesNotMatch(summary, /message 0/);
});

test("personality normalization provides safe defaults", () => {
  const personality = normalizePersonality({ core: "", rules: "broken" });
  assert.match(personality.core, /Elly/);
  assert.equal(Array.isArray(personality.rules), true);
  assert.equal(personality.style.language_behavior, "Always reply in English.");
});

test("stale persisted goals are discarded while recent goals remain resumable", () => {
  const stale = createDefaultMemory();
  stale.active_goal = {
    id: "old",
    type: "goto",
    status: "running",
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  stale.goal_queue = [{ id: "queued" }];

  assert.equal(expireStaleGoals(stale, { now: 1_000_000, maxAgeMs: 10_000 })?.type, "goto");
  assert.equal(stale.active_goal, null);
  assert.deepEqual(stale.goal_queue, []);

  const recent = createDefaultMemory();
  recent.active_goal = {
    id: "new",
    type: "follow",
    status: "running",
    createdAt: 995_000,
    updatedAt: 995_000,
  };
  assert.equal(expireStaleGoals(recent, { now: 1_000_000, maxAgeMs: 10_000 }), null);
  assert.equal(recent.active_goal.id, "new");
});
