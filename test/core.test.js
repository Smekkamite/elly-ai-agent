import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInvLineSlots,
  parseInvLineTotals,
  matchItemFromInv,
} from "../core/inventory.js";
import {
  parseBaritoneEvent,
  parseChatLine,
  parseSleepEventFromSystemLine,
} from "../core/logParser.js";
import { parsePosLine, parseTelLine } from "../core/telemetry.js";
import { classifyEnvironment, parseEnvLine } from "../core/envAnalyzer.js";
import { parseLlmPlan } from "../core/llmPlan.js";
import {
  isValidPlayerName,
  safeCoordinate,
  samePlayer,
  sanitizeProtocolLine,
} from "../core/security.js";

test("telemetry parsers accept reordered and partial fields", () => {
  assert.deepEqual(parsePosLine("OK pos=1.5,64,-3 dim=minecraft:overworld"), {
    x: 1.5,
    y: 64,
    z: -3,
    dim: "minecraft:overworld",
  });

  assert.deepEqual(parseTelLine("TEL:food=18 hp=16.5"), {
    hp: 16.5,
    food: 18,
    pos: null,
    dim: null,
  });
});

test("inventory parsing aggregates totals and normalizes hotbar slots", () => {
  const line =
    "INV: 9=minecraft:stone*32;10=minecraft:bread*3 | HOTBAR:selected=0 36=minecraft:stone*16";
  assert.deepEqual(parseInvLineTotals(line), {
    "minecraft:stone": 48,
    "minecraft:bread": 3,
  });

  const slots = parseInvLineSlots(line);
  assert.deepEqual(slots[0], { slot: 0, id: "minecraft:stone", count: 16 });
  assert.deepEqual(slots[9], { slot: 9, id: "minecraft:stone", count: 32 });
  assert.equal(matchItemFromInv("bread", parseInvLineTotals(line)).id, "minecraft:bread");
});

test("inventory totals do not double-count a hotbar repeated in the full inventory", () => {
  const line =
    "INV:HOTBAR:selected=2 0=minecraft:iron_pickaxe*1;2=minecraft:bread*32 | " +
    "INV:0=minecraft:iron_pickaxe*1;2=minecraft:bread*32;9=minecraft:carrot*7";

  assert.deepEqual(parseInvLineTotals(line), {
    "minecraft:iron_pickaxe": 1,
    "minecraft:bread": 32,
    "minecraft:carrot": 7,
  });
});

test("chat parsing ignores system lines and handles common prefixes", () => {
  assert.deepEqual(parseChatLine("[CHAT] [Not Secure] <CrookedFox> @elly status"), {
    from: "CrookedFox",
    userText: "@elly status",
  });
  assert.equal(parseChatLine("[CHAT] CrookedFox joined the game"), null);
  assert.deepEqual(parseSleepEventFromSystemLine("CrookedFox is now sleeping"), {
    player: "CrookedFox",
    sleeping: true,
  });
});

test("Baritone log events distinguish mining confirmation from errors", () => {
  assert.deepEqual(
    parseBaritoneEvent("[CHAT] [Baritone] Mining [BlockOptionalMeta{block=grass}]"),
    {
      type: "mine_started",
      message: "Mining [BlockOptionalMeta{block=grass}]",
    },
  );
  assert.deepEqual(
    parseBaritoneEvent("[CHAT] [Baritone] Error at argument #2: Expected y"),
    {
      type: "error",
      message: "Error at argument #2: Expected y",
    },
  );
});

test("environment classification identifies caves and nether", () => {
  const cave = parseEnvLine(
    "OK:env water=0 lava=0 stone=30 deepslate=12 netherrack=0 light=2",
  );
  assert.equal(classifyEnvironment(cave, { y: -20 }).environment, "deep_cave");

  const nether = parseEnvLine(
    "OK:env water=0 lava=2 stone=0 deepslate=0 netherrack=20 light=10",
  );
  assert.equal(classifyEnvironment(nether).environment, "nether");
});

test("LLM plans are parsed, bounded and normalized", () => {
  const plan = parseLlmPlan(
    '```json\n{"say":" ok ","commands":[{"tool":"GOTO","args":{"x":1,"y":2,"z":3}},null],"memory_add":[" fact "]}\n```',
    { maxCommands: 1 },
  );

  assert.equal(plan.say, "ok");
  assert.deepEqual(plan.commands, [{ tool: "goto", args: { x: 1, y: 2, z: 3 } }]);
  assert.deepEqual(plan.memory_add, ["fact"]);
});

test("protocol and player validation block line injection", () => {
  assert.equal(sanitizeProtocolLine("ELLY:SAY hello\nELLY:STOP"), "ELLY:SAY hello ELLY:STOP");
  assert.throws(() => sanitizeProtocolLine("x".repeat(5000)), /command_too_long/);
  assert.equal(isValidPlayerName("CrookedFox"), true);
  assert.equal(isValidPlayerName("bad name"), false);
  assert.equal(samePlayer("CrookedFox", "crookedfox"), true);
  assert.equal(safeCoordinate(30_000_001), null);
  assert.equal(safeCoordinate("-42.9"), -42);
});
