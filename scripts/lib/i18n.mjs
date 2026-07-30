// i18n.mjs: pick the user's language and load its strings.
//
// Resolution order, first hit wins:
//   1. --lang <code> on the command line
//   2. CLAUDE_OPTIMIZER_LANG in the environment
//   3. the "language" field in the user's Claude Code settings.json
//   4. LC_ALL / LC_MESSAGES / LANG from the environment
//   5. English
//
// Missing keys fall back to English rather than showing a raw key, so a partial
// translation is still usable and contributing one is low risk.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "locales");

// Claude Code stores the preference as an English language name, not a code.
const NAME_TO_CODE = {
  english: "en", portuguese: "pt", português: "pt", brazilian: "pt",
  spanish: "es", español: "es", castellano: "es",
  french: "fr", français: "fr",
  german: "de", deutsch: "de",
  italian: "it", italiano: "it",
  japanese: "ja", chinese: "zh", korean: "ko", russian: "ru",
  dutch: "nl", polish: "pl", turkish: "tr", hindi: "hi", arabic: "ar",
};

function fromSettings(configDir) {
  const p = join(configDir, "settings.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const value = raw?.language;
    if (typeof value !== "string" || !value.trim()) return null;
    const key = value.trim().toLowerCase();
    return NAME_TO_CODE[key] || key.slice(0, 2);
  } catch {
    return null;
  }
}

function fromEnv() {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (!raw || raw === "C" || raw === "POSIX") return null;
  return raw.split(".")[0].split("_")[0].toLowerCase() || null;
}

export function availableLocales() {
  if (!existsSync(LOCALES_DIR)) return ["en"];
  return readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function resolveLanguage({ explicit, configDir } = {}) {
  const candidates = [
    explicit,
    process.env.CLAUDE_OPTIMIZER_LANG,
    configDir ? fromSettings(configDir) : null,
    fromEnv(),
    "en",
  ];
  const available = new Set(availableLocales());
  for (const c of candidates) {
    if (!c) continue;
    const code = String(c).toLowerCase().split("-")[0];
    if (available.has(code)) return code;
  }
  return "en";
}

function loadFile(code) {
  const p = join(LOCALES_DIR, `${code}.json`);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

// Returns t(key, vars) plus the locale tag, so callers can format numbers and
// dates the same way the strings are written.
export function createTranslator({ explicit, configDir } = {}) {
  const lang = resolveLanguage({ explicit, configDir });
  const base = loadFile("en");
  const strings = lang === "en" ? base : { ...base, ...loadFile(lang) };
  const tag = { en: "en-US", pt: "pt-BR", es: "es-ES", fr: "fr-FR", de: "de-DE",
                it: "it-IT", ja: "ja-JP", zh: "zh-CN", ko: "ko-KR", ru: "ru-RU",
                nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", hi: "hi-IN", ar: "ar-SA" }[lang] || "en-US";

  const t = (key, vars) => {
    let s = strings[key];
    if (s === undefined) s = base[key];
    if (s === undefined) return key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
  };

  return { t, lang, tag };
}
