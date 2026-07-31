import path from "path";
import { fileURLToPath } from "url";

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url + "/../"));

export function resolveAppPath(value, fallback) {
  const chosen = String(value || fallback || "").trim();
  if (!chosen) return "";
  return path.isAbsolute(chosen) ? path.normalize(chosen) : path.resolve(APP_DIR, chosen);
}
