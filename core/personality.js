import { readJsonFile } from "./jsonStore.js";

export const DEFAULT_PERSONALITY = {
  core: "You are Elly, a calm and observant Minecraft companion.",
  style: {
    tone: "Natural, calm and slightly warm.",
    length: "Keep answers short (1-2 sentences).",
    language_behavior: "Always reply in English.",
  },
  rules: [
    "Stay in character.",
    "Never claim an action happened unless server state confirms it.",
  ],
};

export function normalizePersonality(value) {
  const style =
    value?.style && typeof value.style === "object" && !Array.isArray(value.style)
      ? value.style
      : DEFAULT_PERSONALITY.style;

  return {
    core:
      typeof value?.core === "string" && value.core.trim()
        ? value.core.trim()
        : DEFAULT_PERSONALITY.core,
    style,
    rules: Array.isArray(value?.rules)
      ? value.rules.filter((rule) => typeof rule === "string" && rule.trim()).map((rule) => rule.trim())
      : DEFAULT_PERSONALITY.rules,
  };
}

export function loadPersonality(filePath, logger = console) {
  return readJsonFile(filePath, {
    defaults: DEFAULT_PERSONALITY,
    normalize: normalizePersonality,
    logger,
  });
}
