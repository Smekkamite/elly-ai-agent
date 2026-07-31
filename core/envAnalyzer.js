// core/envAnalyzer.js (ESM)

export function parseEnvLine(line) {
  const s = String(line || "").trim();
  if (!s.startsWith("OK:env ")) return null;

  const payload = s.slice("OK:env ".length).trim();
  if (!payload) return null;

  const out = {
    water: 0,
    lava: 0,
    stone: 0,
    deepslate: 0,
    netherrack: 0,
    light: 0,
  };

  const parts = payload.split(/\s+/).filter(Boolean);

  for (const part of parts) {
    const m = part.match(/^([a-z_]+)=(-?\d+)$/i);
    if (!m) continue;

    const key = m[1].toLowerCase();
    const val = Number(m[2]);

    if (!Number.isFinite(val)) continue;
    if (!(key in out)) continue;

    out[key] = val;
  }

  return out;
}

export function classifyEnvironment(env, extra = {}) {
  const dim = String(extra?.dim || "").toLowerCase();
  const y = Number(extra?.y);
  const biome = String(extra?.biome || "").toLowerCase();

  const water = Number(env?.water || 0);
  const lava = Number(env?.lava || 0);
  const stone = Number(env?.stone || 0);
  const deepslate = Number(env?.deepslate || 0);
  const netherrack = Number(env?.netherrack || 0);
  const light = Number(env?.light || 0);

  const solidRock = stone + deepslate + netherrack;
  const undergroundLike = solidRock >= 20;
  const dark = light <= 5;
  const veryDark = light <= 2;
  const lowY = Number.isFinite(y) && y < 60;
  const deepY = Number.isFinite(y) && y < 10;

  let environment = "surface";

  // Nether wins first
  if (dim.includes("nether") || netherrack >= 12 || lava >= 10) {
    environment = "nether";
  }
  // Underwater (must be confirmed by actual water presence)
else if (
  water >= 20 ||
  (
    water >= 8 &&
    (biome.includes("ocean") || biome.includes("river"))
  )
) {
  environment = "underwater";
}   
  // Mineshaft-like heuristic placeholder for future expansion
  else if (false) {
    environment = "mineshaft_like";
  }
  // Deep cave
  else if ((deepslate >= 12 && lowY) || (deepslate >= 20 && dark) || (deepY && undergroundLike)) {
    environment = "deep_cave";
  }
  // Regular cave
  else if (
    undergroundLike &&
    (lowY || dark || biome.includes("cave") || biome.includes("deep_dark") || biome.includes("dripstone"))
  ) {
    environment = "cave";
  }

  let dangerLevel = "low";
  if (environment === "nether" || veryDark || lava >= 8) dangerLevel = "high";
  else if (environment === "deep_cave" || dark) dangerLevel = "medium";

  return {
    environment,
    isSurface: environment === "surface",
    isCave: environment === "cave" || environment === "deep_cave",
    isDeepCave: environment === "deep_cave",
    isUnderwater: environment === "underwater",
    isNether: environment === "nether",
    isDark: dark,
    isVeryDark: veryDark,
    dangerLevel,
    signals: {
      water,
      lava,
      stone,
      deepslate,
      netherrack,
      light,
      y: Number.isFinite(y) ? y : null,
      dim: dim || null,
      biome: biome || null,
    },
  };
}

export function describeEnvironmentForPrompt(envInfo) {
  if (!envInfo) return "environment=unknown";

  const tags = [
    `environment=${envInfo.environment}`,
    `dark=${envInfo.isDark ? "yes" : "no"}`,
    `danger=${envInfo.dangerLevel}`,
  ];

  const s = envInfo.signals || {};
  if (s.biome) tags.push(`biome=${s.biome}`);
  if (s.dim) tags.push(`dimension=${s.dim}`);
  if (Number.isFinite(s.y)) tags.push(`y=${s.y}`);
  tags.push(`water=${s.water}`);
  tags.push(`lava=${s.lava}`);
  tags.push(`stone=${s.stone}`);
  tags.push(`deepslate=${s.deepslate}`);
  tags.push(`netherrack=${s.netherrack}`);
  tags.push(`light=${s.light}`);

  return tags.join("\n");
}