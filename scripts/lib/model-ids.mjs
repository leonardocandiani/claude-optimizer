// model-ids.mjs
// Known Claude model ID tables (as of jul/2026) and the matching helpers
// used to find outdated references in a user's config or codebase.
//
// Source of truth for these tables: Anthropic's own model migration guide.
// Nothing here is invented; the retired/outdated -> replacement mappings are
// the published "Model-ID Rename Quick Reference" and retirement schedule.

// Current, recommended model IDs (jul/2026).
export const CURRENT_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
];

// Retired: these return HTTP 404 today. Must be fixed.
export const RETIRED_MODELS = [
  { id: 'claude-3-7-sonnet-20250219', replacement: 'claude-sonnet-5', retiredOn: '2026-02-19' },
  { id: 'claude-3-5-haiku-20241022', replacement: 'claude-haiku-4-5-20251001', retiredOn: '2026-02-19' },
  { id: 'claude-3-opus-20240229', replacement: 'claude-opus-5', retiredOn: '2026-01-05' },
  { id: 'claude-3-5-sonnet-20241022', replacement: 'claude-sonnet-5', retiredOn: '2025-10-28' },
  { id: 'claude-3-5-sonnet-20240620', replacement: 'claude-sonnet-5', retiredOn: '2025-10-28' },
  { id: 'claude-3-sonnet-20240229', replacement: 'claude-sonnet-5', retiredOn: '2025-07-21' },
  { id: 'claude-2.1', replacement: 'claude-sonnet-5', retiredOn: '2025-07-21' },
  { id: 'claude-2.0', replacement: 'claude-sonnet-5', retiredOn: '2025-07-21' },
];

// Deprecated: still active today, but scheduled to retire. Worth migrating
// now rather than waiting for the 404.
export const DEPRECATING_MODELS = [
  { id: 'claude-3-haiku-20240307', replacement: 'claude-haiku-4-5-20251001', retiresOn: '2026-04-19' },
  { id: 'claude-opus-4-1-20250805', replacement: 'claude-opus-5', retiresOn: '2026-08-05' },
  { id: 'claude-opus-4-1', replacement: 'claude-opus-5', retiresOn: '2026-08-05' },
];

// Outdated: active, not scheduled to retire, but superseded by a current
// model. Migrating is a recommendation, not an emergency.
export const OUTDATED_MODELS = [
  { id: 'claude-opus-4-8', replacement: 'claude-opus-5' },
  { id: 'claude-opus-4-7', replacement: 'claude-opus-5' },
  { id: 'claude-opus-4-6', replacement: 'claude-opus-5' },
  { id: 'claude-opus-4-5-20251101', replacement: 'claude-opus-5' },
  { id: 'claude-opus-4-5', replacement: 'claude-opus-5' },
  { id: 'claude-opus-4-0', replacement: 'claude-opus-5' },
  { id: 'claude-opus-4-20250514', replacement: 'claude-opus-5' },
  { id: 'claude-sonnet-4-6', replacement: 'claude-sonnet-5' },
  { id: 'claude-sonnet-4-5-20250929', replacement: 'claude-sonnet-5' },
  { id: 'claude-sonnet-4-5', replacement: 'claude-sonnet-5' },
  { id: 'claude-sonnet-4-0', replacement: 'claude-sonnet-5' },
  { id: 'claude-sonnet-4-20250514', replacement: 'claude-sonnet-5' },
  { id: 'claude-mythos-preview', replacement: 'claude-fable-5' },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary-safe match: a model ID must not be a substring of a longer
// one (e.g. "claude-opus-4-1" inside "claude-opus-4-1-20250805"). Using a
// custom boundary (rather than \b) because model IDs contain "-" and ".",
// which \b treats as boundaries on their own.
export function buildBoundaryRegex(id) {
  return new RegExp(`(?<![\\w.-])${escapeRegex(id)}(?![\\w.-])`, 'g');
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function collectMatches(content, table, severity) {
  const found = [];
  for (const entry of table) {
    const re = buildBoundaryRegex(entry.id);
    let m;
    while ((m = re.exec(content)) !== null) {
      found.push({
        id: entry.id,
        severity,
        replacement: entry.replacement,
        line: lineNumberAt(content, m.index),
        index: m.index,
      });
    }
  }
  return found;
}

// Finds every retired/deprecating/outdated model ID reference in a string.
// Returns entries sorted by position in the file.
export function findModelIdIssues(content) {
  const issues = [
    ...collectMatches(content, RETIRED_MODELS, 'retired'),
    ...collectMatches(content, DEPRECATING_MODELS, 'deprecating'),
    ...collectMatches(content, OUTDATED_MODELS, 'outdated'),
  ];
  return issues.sort((a, b) => a.index - b.index);
}

// Cheap, low-false-positive gate: only run the breaking-change keyword scan
// on files that plausibly touch the Anthropic API in the first place.
const ANTHROPIC_HINT_RE = /\banthropic\b|claude-(opus|sonnet|haiku|fable|mythos)|ANTHROPIC_API_KEY|messages\.create|messages\.stream|messages\.parse/i;

export function fileLooksAnthropicRelated(content) {
  return ANTHROPIC_HINT_RE.test(content);
}

// Purely mechanical token checks for the Opus 5 / Fable 5 breaking changes
// the team asked to be flagged. These are intentionally narrow (exact
// parameter tokens) to keep false positives low; they are hints for a human
// to verify, not proof of a broken call.
//
// Each hint carries both a `key` and a `message`. The key is what the text
// report prints through the translator, so the hint reaches the reader in the
// language the rest of the report is in -- these lines are the ones that ask
// for a judgement call, so they are the last place to leave in English.
// The `message` is the English text, kept verbatim in the --json output: that
// output is read by machines and by people who did not choose a language, and
// changing its wording per locale would make it unstable to diff.
const BREAKING_PATTERN_HINTS = [
  {
    re: /budget_tokens/g,
    key: 'migrate.hint.budgetTokens',
    message: "uses 'budget_tokens', rejected with 400 on Opus 5 / Fable 5 / Opus 4.7+. Replace with thinking: {type: \"adaptive\"}.",
  },
  {
    re: /\btemperature\s*[:=]/g,
    key: 'migrate.hint.temperature',
    message: "sets 'temperature', rejected with 400 on Opus 5 / Fable 5 / Opus 4.7+. Remove it.",
  },
  {
    re: /\btop_p\s*[:=]/g,
    key: 'migrate.hint.topP',
    message: "sets 'top_p', rejected with 400 on Opus 5 / Fable 5 / Opus 4.7+. Remove it.",
  },
  {
    re: /\btop_k\s*[:=]/g,
    key: 'migrate.hint.topK',
    message: "sets 'top_k', rejected with 400 on Opus 5 / Fable 5 / Opus 4.7+. Remove it.",
  },
];

// Exported so a test can assert every hint key really exists in the locale
// files. A hint whose key is missing would print the raw key to the reader.
export const BREAKING_HINT_KEYS = BREAKING_PATTERN_HINTS.map((h) => h.key);

export function findBreakingPatternHints(content) {
  const hits = [];
  for (const { re, key, message } of BREAKING_PATTERN_HINTS) {
    re.lastIndex = 0;
    const seenLines = new Set();
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = lineNumberAt(content, m.index);
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      hits.push({ line, key, message });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}
