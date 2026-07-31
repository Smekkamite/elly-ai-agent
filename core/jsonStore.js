import fs from "fs";
import path from "path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function writeJsonAtomic(filePath, value) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const temp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temp, json, { encoding: "utf8", mode: 0o600 });

  try {
    fs.renameSync(temp, target);
  } catch (error) {
    // Windows can reject replacement of an existing file. copyFileSync still
    // keeps the original intact until the complete temporary file exists.
    fs.copyFileSync(temp, target);
    fs.unlinkSync(temp);
    if (!fs.existsSync(target)) throw error;
  }
}

export function readJsonFile(
  filePath,
  { defaults, normalize = (value) => value, logger = console } = {},
) {
  const initial = clone(defaults ?? {});

  if (!fs.existsSync(filePath)) {
    writeJsonAtomic(filePath, initial);
    return initial;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) throw new Error("empty JSON file");

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON root must be an object");
    }

    return normalize(parsed, initial);
  } catch (error) {
    const backup = `${filePath}.broken.${Date.now()}`;
    try {
      fs.copyFileSync(filePath, backup);
    } catch {}

    writeJsonAtomic(filePath, initial);
    logger?.warn?.(
      `[json] invalid ${path.basename(filePath)} reset; backup=${backup}; reason=${error.message}`,
    );
    return initial;
  }
}
