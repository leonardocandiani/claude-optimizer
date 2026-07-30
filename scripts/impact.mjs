#!/usr/bin/env node
// impact.mjs: translate a config diet into the only currency that matters day to day,
// how much more work fits before you hit a usage limit.
//
// Dollar savings are the wrong headline for most people: they are on a subscription,
// so the bill does not move. What moves is how far they get inside the 5 hour session
// window and the weekly window before being cut off.
//
// Method, all measured, nothing assumed:
//   1. Read every transcript and sum the real input tokens per request.
//   2. Find the heaviest rolling 5 hour window that actually happened.
//   3. Split each request into config overhead (the always loaded prompt) and real work.
//   4. Recompute how many requests fit in the same budget once overhead shrinks.
//
// Usage:
//   node impact.mjs                          compare against the newest backup found
//   node impact.mjs --before-bytes 84624     compare against an explicit "before" size
//   node impact.mjs --days 14                widen the measurement window
//   node impact.mjs --ratio 3.1              override bytes per token

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { title, section, bar, compareBars, sparkline, kv, stat, big, callout, color, glyph } from "./render.mjs";
import { createTranslator } from "./lib/i18n.mjs";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const CONFIG_DIR = process.env.CLAUDE_CODE_CONFIG_DIR || join(homedir(), ".claude");
const DAYS = Number(flag("days", 7));
// Measured against the real API tokenizer on Portuguese and English markdown.
// Two independent measurements landed on 3.12 and 3.08, so 3.1 is the working figure.
const BYTES_PER_TOKEN = Number(flag("ratio", 3.1));
const SESSION_WINDOW_HOURS = 5;

const { t, tag } = createTranslator({ explicit: flag("lang", null), configDir: CONFIG_DIR });
// Numbers follow the same locale as the strings: thousands and decimal separators
// differ, and a Brazilian reading "8,432,263,481" reads it as a decimal.
const n = (x) => x.toLocaleString(tag);
const pct = (x) => new Intl.NumberFormat(tag, { style: "percent", minimumFractionDigits: 2 }).format(x);
const padStart = (s, w) => " ".repeat(Math.max(0, w - String(s).length)) + s;
// Decimals follow the locale too: pt-BR writes 35,1h where en-US writes 35.1h.
const dec = (x, digits = 1) =>
  new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
const hrs = (h) => (h < 1 ? `${Math.round(h * 60)}min` : `${dec(h)}h`);

// ---------- measure the config ----------

function hasPathsFrontmatter(text) {
  // A rule that opens with a paths: glob list only loads when a matching file is
  // in play, so it does not count toward the always loaded weight.
  if (!text.startsWith("---")) return false;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return false;
  return /^paths:/m.test(text.slice(0, end));
}

function measureConfig(dir) {
  let always = 0, conditional = 0, onDemand = 0;
  const claudeMd = join(dir, "CLAUDE.md");
  if (existsSync(claudeMd)) always += statSync(claudeMd).size;

  const rulesDir = join(dir, "rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir)) {
      if (!f.endsWith(".md")) continue;
      const p = join(rulesDir, f);
      const size = statSync(p).size;
      let head = "";
      try { head = readFileSync(p, "utf8").slice(0, 500); } catch { /* unreadable, count as always */ }
      if (hasPathsFrontmatter(head)) conditional += size; else always += size;
    }
  }

  const refDir = join(dir, "references");
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) {
      if (f.endsWith(".md")) onDemand += statSync(join(refDir, f)).size;
    }
  }
  return { always, conditional, onDemand };
}

function findBackupBaseline(dir) {
  // Any prior snapshot of the config counts as a "before". Newest wins.
  const archive = join(dir, "_archive");
  if (!existsSync(archive)) return null;
  let best = null;
  for (const entry of readdirSync(archive)) {
    const p = join(archive, entry);
    let st; try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!existsSync(join(p, "CLAUDE.md"))) continue;
    if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs, label: entry };
  }
  if (!best) return null;
  return { ...measureConfig(best.path), label: best.label };
}

// ---------- measure real usage ----------

function findTranscripts(dir, cutoff, depth = 0, found = []) {
  if (depth > 4) return found;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { findTranscripts(p, cutoff, depth + 1, found); continue; }
    if (!e.name.endsWith(".jsonl")) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs >= cutoff) found.push(p);
  }
  return found;
}

// Everything the model had to read on this turn: fresh input, cache written and
// cache re-read. All three land against the usage limit, so all three count.
const inputTokens = (u) =>
  (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.input_tokens || 0);

function parseUsageLine(line) {
  if (!line.includes('"usage"')) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const usage = j?.message?.usage;
  const ts = j?.timestamp ? Date.parse(j.timestamp) : NaN;
  if (!usage || Number.isNaN(ts)) return null;
  const tokens = inputTokens(usage);
  return tokens > 0 ? [ts, tokens] : null;
}

function readUsageEvents(file, into, sessions) {
  let raw; try { raw = readFileSync(file, "utf8"); } catch { return; }
  const turns = [];
  for (const line of raw.split("\n")) {
    const event = parseUsageLine(line);
    if (!event) continue;
    into.push(event);
    turns.push(event[1]);
  }
  if (sessions && turns.length) sessions.push(turns);
}

// A session re-reads its own history every turn, so the cost per turn climbs as
// it goes. Comparing the opening turns against the closing ones shows how steep
// that climb is, which is the argument for starting fresh more often.
function sessionCurve(sessions, minTurns = 40) {
  const long = sessions.filter((t) => t.length >= minTurns);
  if (!long.length) return null;
  let earlySum = 0, earlyN = 0, lateSum = 0, lateN = 0, longest = 0;
  for (const turns of long) {
    const slice = Math.max(1, Math.floor(turns.length * 0.2));
    for (let i = 0; i < slice; i++) { earlySum += turns[i]; earlyN++; }
    for (let i = turns.length - slice; i < turns.length; i++) { lateSum += turns[i]; lateN++; }
    longest = Math.max(longest, turns.length);
  }
  return {
    count: long.length,
    early: earlySum / earlyN,
    late: lateSum / lateN,
    longest,
  };
}

function collectEvents(days) {
  const projects = join(CONFIG_DIR, "projects");
  if (!existsSync(projects)) return [];
  const cutoff = Date.now() - days * 86400_000;
  const events = [];
  const sessions = [];
  for (const file of findTranscripts(projects, cutoff)) {
    readUsageEvents(file, events, sessions);
  }
  collectEvents.sessions = sessions;
  // A transcript touched today can still hold messages from weeks ago, so the
  // events themselves have to be filtered by their own timestamp, not by the
  // file's mtime. Without this the window silently stretches.
  return events.filter(([ts]) => ts >= cutoff).sort((a, b) => a[0] - b[0]);
}

// Real working time, not calendar time. Requests closer than IDLE_GAP apart are
// one continuous block; anything longer is a break. Summing the blocks gives the
// hours actually spent at the keyboard, which is the only honest base for
// "how much time did this buy me".
const IDLE_GAP_MS = 15 * 60_000;

function workBlocks(events) {
  if (!events.length) return { hours: 0, blocks: 0 };
  let total = 0, blocks = 1, start = events[0][0], last = events[0][0];
  for (const [ts] of events) {
    if (ts - last > IDLE_GAP_MS) { total += last - start; blocks++; start = ts; }
    last = ts;
  }
  total += last - start;
  return { hours: total / 3600_000, blocks };
}

function heaviestWindow(events, hours) {
  const span = hours * 3600_000;
  let best = { tokens: 0, requests: 0, start: null };
  let sum = 0, left = 0;
  for (let right = 0; right < events.length; right++) {
    sum += events[right][1];
    while (events[right][0] - events[left][0] > span) { sum -= events[left][1]; left++; }
    const requests = right - left + 1;
    if (sum > best.tokens) best = { tokens: sum, requests, start: events[left][0] };
  }
  return best;
}

// ---------- render ----------

function dailyTotals(events) {
  const byDay = new Map();
  for (const [ts, tokens] of events) {
    const day = new Date(ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + tokens);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function main() {
  const after = measureConfig(CONFIG_DIR);
  const explicitBefore = flag("before-bytes", null);
  let before, source;

  if (explicitBefore) {
    before = { always: Number(explicitBefore) };
    source = t("baseline.explicit", { bytes: n(Number(explicitBefore)) });
  } else {
    const backup = findBackupBaseline(CONFIG_DIR);
    if (!backup) {
      console.error(t("error.noBaseline"));
      process.exit(1);
    }
    before = backup;
    source = t("baseline.backup", { label: backup.label });
  }

  const beforeTokens = before.always / BYTES_PER_TOKEN;
  const afterTokens = after.always / BYTES_PER_TOKEN;
  const savedPerRequest = beforeTokens - afterTokens;
  const cutFraction = before.always > 0 ? (before.always - after.always) / before.always : 0;

  const events = collectEvents(DAYS);
  if (events.length === 0) {
    console.error(t("error.noUsage", { days: DAYS, dir: CONFIG_DIR + "/projects" }));
    process.exit(1);
  }
  const totalTokens = events.reduce((a, e) => a + e[1], 0);
  const totalRequests = events.length;
  const perRequest = totalTokens / totalRequests;
  const peak = heaviestWindow(events, SESSION_WINDOW_HOURS);
  const wb = workBlocks(events);

  // Real work is whatever is not the always loaded config: conversation history,
  // files read, tool results. That part does not change when the config shrinks.
  const work = Math.max(1, perRequest - beforeTokens);
  const costBefore = work + beforeTokens;
  const costAfter = work + afterTokens;
  const multiplier = costBefore / costAfter;


  const days = dailyTotals(events);
  const P = [];
  const push = (...l) => P.push(...l);
  const plural = (key, count) => t(count === 1 ? key : key + "Plural", { count: n(count) });

  push("");
  push(title(t("title", { arrow: glyph.arrow })));
  push(color.dim("  " + t("baseline", {
    source, bullet: glyph.bullet, days: DAYS, requests: n(totalRequests),
  })));

  // Time is the headline. Everything below is the evidence for it.
  const gain = multiplier - 1;
  const perWeekH = wb.hours * gain * (7 / DAYS);
  const sessionH = wb.blocks ? wb.hours / wb.blocks : 0;
  push(section(t("time.heading")));
  push(`  ${t("time.worked", {
    hours: color.bold(hrs(wb.hours)), sessions: color.bold(n(wb.blocks)), days: DAYS,
  })}  ${color.mute(t("time.pace", { perDay: hrs(wb.hours / DAYS), perSession: hrs(sessionH) }))}`);
  push("");
  const extraSessions = sessionH > 0 ? perWeekH / sessionH : 0;
  push(stat(t("time.perWeek"), color.good("+" + hrs(perWeekH)),
    extraSessions >= 0.9 ? plural("time.extraSessions", Math.round(extraSessions)) : ""));
  push(stat(t("time.perMonth"), color.good("+" + hrs(perWeekH * 4.345))));
  push(stat(t("time.perYear"), color.good("+" + hrs(perWeekH * 52)),
    t("time.workingDays", { days: dec((perWeekH * 52) / 8) })));

  push(section(t("prompt.heading")));
  push(compareBars(
    { label: t("prompt.before"), value: before.always,
      note: `${t("prompt.bytes", { bytes: n(before.always) })}   ${color.mute(t("prompt.tokens", { tokens: n(Math.round(beforeTokens)) }))}` },
    { label: t("prompt.after"), value: after.always,
      note: `${t("prompt.bytes", { bytes: n(after.always) })}   ${color.mute(t("prompt.tokens", { tokens: n(Math.round(afterTokens)) }))}` },
  ));
  push("");
  push(kv(t("prompt.cut"), color.good(`${t("prompt.bytes", { bytes: n(before.always - after.always) })}  (${pct(cutFraction)})`)));
  push(kv(t("prompt.saved"), color.good(t("prompt.tokens", { tokens: n(Math.round(savedPerRequest)) }))));

  push(section(t("share.heading")));
  const shareBefore = beforeTokens / perRequest;
  const shareAfter = afterTokens / perRequest;
  push(bar(t("share.configBefore"), shareBefore, pct(shareBefore), 34, "warn"));
  push(bar(t("share.configAfter"), shareAfter, pct(shareAfter), 34, "good"));
  push(bar(t("share.conversation"), work / perRequest, pct(work / perRequest), 34, "accent"));
  push("");
  push(color.dim("  " + t("share.note1", { tokens: n(Math.round(perRequest)) })));
  push(color.dim("  " + t("share.note2")));

  push(section(t("peak.heading", { hours: SESSION_WINDOW_HOURS })));
  push(kv(t("peak.when"), new Date(peak.start).toISOString().slice(0, 16).replace("T", " ") + " UTC"));
  push(kv(t("peak.burned"),
    color.warn(t("peak.burnedValue", { tokens: n(peak.tokens) })) +
    color.mute("  " + t("peak.inRequests", { requests: n(peak.requests) }))));
  const peakBefore = peak.requests * beforeTokens;
  const peakAfter = peak.requests * afterTokens;
  push(kv(t("peak.configTook"), t("peak.burnedValue", { tokens: n(Math.round(peakBefore)) })));
  push(kv(t("peak.configNow"), t("peak.burnedValue", { tokens: n(Math.round(peakAfter)) })));
  push(kv(t("peak.freed"), color.good(t("peak.burnedValue", { tokens: n(Math.round(peakBefore - peakAfter)) }))));
  const extraReq = Math.round(peak.requests * gain);
  const extraMin = Math.round(((SESSION_WINDOW_HOURS * 60) / peak.requests) * extraReq);
  push("");
  push(callout([
    t("peak.fit", { after: color.bold(n(peak.requests + extraReq)), before: n(peak.requests) }),
    color.mute(t("peak.fitNote", { extra: n(extraReq), minutes: extraMin })),
  ], "good"));

  push(section(t("week.heading")));
  push("  " + color.accent(sparkline(days.map((d) => d[1]))) +
    color.dim("  " + t("week.days", { days: days.length, peak: n(Math.max(...days.map((d) => d[1]))) })));
  push("");
  const weekBefore = totalRequests * beforeTokens;
  const weekAfter = totalRequests * afterTokens;
  push(kv(t("week.total"), n(totalTokens)));
  push(kv(t("week.configWas"), `${n(Math.round(weekBefore))}  ${color.mute("(" + pct(weekBefore / totalTokens) + ")")}`));
  push(kv(t("week.configNow"), `${n(Math.round(weekAfter))}  ${color.mute("(" + pct(weekAfter / totalTokens) + ")")}`));
  push(kv(t("week.freed"), color.good(n(Math.round(weekBefore - weekAfter)))));
  push(big(t("week.multiplier"), `${dec(multiplier, 3)}x`,
    t("week.multiplierNote", { percent: pct(gain), time: hrs(perWeekH) })));

  push(section(t("harder.heading")));
  push(color.mute(t("harder.columns")));
  for (const target of [0.5, 0.8, 0.95]) {
    const hypo = (before.always * (1 - target)) / BYTES_PER_TOKEN;
    const m = (work + beforeTokens) / (work + hypo);
    push(`  ${padStart(Math.round(target * 100) + "%", 8)}          ${color.warn(dec(m, 3) + "x")}          ${padStart(pct(m - 1), 7)}   ${color.dim(padStart("+" + hrs(wb.hours * (m - 1) * (7 / DAYS)), 7) + t("harder.perWeek"))}`);
  }
  push("");
  push(color.dim("  " + t("harder.note1")));
  push(color.dim("  " + t("harder.note2")));

  push(section(t("lever.heading")));
  push(`  ${t("lever.share", { percent: color.bold(pct(work / perRequest)) })}`);
  push(color.dim("  " + t("lever.note1")));
  push(color.dim("  " + t("lever.note2")));
  push("");
  const curve = sessionCurve(collectEvents.sessions || []);
  if (curve) {
    const growth = curve.early > 0 ? curve.late / curve.early : 0;
    push(stat(t("lever.firstTurns"), n(Math.round(curve.early)), t("lever.avgOpening")));
    push(stat(t("lever.lastTurns"), color.warn(n(Math.round(curve.late))), t("lever.avgClosing")));
    push(stat(t("lever.growth"), color.warn(dec(growth) + "x"),
      t(curve.count === 1 ? "lever.across" : "lever.acrossPlural",
        { count: n(curve.count), turns: n(curve.longest) })));
    push("");
    if (growth < 1.3) {
      push(color.dim("  " + t("lever.mild1")));
      push(color.dim("  " + t("lever.mild2")));
      push(color.dim("  " + t("lever.mild3", { tokens: n(Math.round(curve.late)) })));
    } else {
      push(color.dim("  " + t("lever.steep1")));
      push(color.dim("  " + t("lever.steep2")));
    }
    push("");
  }
  const halved = work / 2 + afterTokens;
  const mHalf = costBefore / halved;
  push(compareBars(
    { label: t("lever.configDiet"), value: gain, note: color.mute(`${dec(multiplier, 3)}x`) },
    { label: t("lever.halfHistory"), value: mHalf - 1, note: color.good(`${dec(mHalf, 2)}x`) },
  ));
  push("");
  push(callout([
    t("lever.verdict1", { time: color.bold("+" + hrs(wb.hours * (mHalf - 1) * (7 / DAYS))) }),
    t("lever.verdict2", { factor: color.bold(Math.round((mHalf - 1) / gain) + "x") }),
    color.mute(t("lever.verdict3")),
  ], "accent"));
  push("");

  console.log(P.join("\n"));
}

main();
