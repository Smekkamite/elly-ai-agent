const MAX_SAY_LENGTH = 500;
const MAX_MEMORY_FACT_LENGTH = 200;

export function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Model returned an empty response.");

  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Model response must be a JSON object.");
    }
    return value;
  } catch (directError) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      const value = JSON.parse(fenced[1].trim());
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Model response must be a JSON object.");
      }
      return value;
    }

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw directError;
    const value = JSON.parse(raw.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Model response must be a JSON object.");
    }
    return value;
  }
}

export function parseLlmPlan(text, { maxCommands = 3 } = {}) {
  const value = parseJsonObject(text);
  const commandLimit = Math.max(0, Math.min(10, Number(maxCommands) || 0));

  return {
    say: typeof value.say === "string" ? value.say.trim().slice(0, MAX_SAY_LENGTH) : "",
    commands: Array.isArray(value.commands)
      ? value.commands
          .filter((command) => command && typeof command === "object" && !Array.isArray(command))
          .map((command) => ({
            tool: String(command.tool || "").trim().toLowerCase(),
            args:
              command.args && typeof command.args === "object" && !Array.isArray(command.args)
                ? command.args
                : {},
          }))
          .filter((command) => command.tool)
          .slice(0, commandLimit)
      : [],
    memory_add: Array.isArray(value.memory_add)
      ? value.memory_add
          .filter((fact) => typeof fact === "string" && fact.trim())
          .map((fact) => fact.trim().slice(0, MAX_MEMORY_FACT_LENGTH))
          .slice(0, 5)
      : [],
  };
}
