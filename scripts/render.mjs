// render.mjs: terminal drawing primitives. Box glyphs, block bars, sparklines
// and ANSI color, with a plain fallback when the terminal cannot handle them.
//
// Respects NO_COLOR (https://no-color.org) and falls back to ASCII when
// TERM is dumb or output is piped somewhere that is not a TTY.

// Two independent switches. NO_COLOR means no ANSI, it does not mean the
// terminal cannot draw a box, so glyphs survive it. Only an explicit opt out or
// a dumb terminal falls back to pure ASCII.
const plain = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";
const unicode = process.env.CLAUDE_OPTIMIZER_ASCII === undefined && process.env.TERM !== "dumb";

const C = plain
  ? new Proxy({}, { get: () => (s) => String(s) })
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      accent: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
      good: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
      warn: (s) => `\x1b[38;5;179m${s}\x1b[0m`,
      ink: (s) => `\x1b[38;5;252m${s}\x1b[0m`,
      mute: (s) => `\x1b[38;5;245m${s}\x1b[0m`,
    };

const G = unicode
  ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", lt: "├", rt: "┤",
      full: "█", part: "▓", empty: "░", spark: "▁▂▃▄▅▆▇█", arrow: "→", bullet: "•" }
  : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", lt: "+", rt: "+",
      full: "#", part: "=", empty: ".", spark: "_.-~^*", arrow: "->", bullet: "*" };

// Visible length, ignoring ANSI escape sequences.
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - vlen(s)));
const padStart = (s, n) => " ".repeat(Math.max(0, n - vlen(s))) + s;

export const WIDTH = 68;

export function rule(width = WIDTH) {
  return C.dim(G.h.repeat(width));
}

export function title(text, width = WIDTH) {
  const inner = width - 2;
  return [
    C.dim(G.tl + G.h.repeat(inner) + G.tr),
    C.dim(G.v) + " " + C.bold(C.accent(pad(text, inner - 2))) + " " + C.dim(G.v),
    C.dim(G.bl + G.h.repeat(inner) + G.br),
  ].join("\n");
}

export function section(text) {
  return "\n" + C.bold(C.ink(text)) + "\n" + rule();
}

// A labelled bar. `tone` picks the fill color.
export function bar(label, fraction, note, width = 30, tone = "accent") {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const filled = Math.round(f * width);
  const paint = C[tone] || C.accent;
  const track = paint(G.full.repeat(filled)) + C.dim(G.empty.repeat(width - filled));
  return `  ${pad(C.mute(label), 22)} ${track}  ${pad(note, 20)}`;
}

// Two bars sharing a scale, so before and after are visually comparable.
export function compareBars(a, b, width = 30) {
  const max = Math.max(a.value, b.value) || 1;
  const draw = (x, tone) => {
    const filled = Math.round((x.value / max) * width);
    const paint = C[tone] || C.accent;
    return paint(G.full.repeat(filled)) + C.dim(G.empty.repeat(width - filled));
  };
  return [
    `  ${pad(C.mute(a.label), 12)} ${draw(a, "warn")}  ${a.note}`,
    `  ${pad(C.mute(b.label), 12)} ${draw(b, "good")}  ${b.note}`,
  ].join("\n");
}

export function sparkline(values) {
  if (!values.length) return "";
  const chars = [...G.spark];
  const max = Math.max(...values) || 1;
  return values
    .map((v) => chars[Math.min(chars.length - 1, Math.round((v / max) * (chars.length - 1)))])
    .join("");
}

// key/value row with the value right aligned to the panel edge.
export function kv(key, value, width = WIDTH) {
  return `  ${pad(C.mute(key), 28)}${padStart(value, width - 30)}`;
}

// label | right aligned value | note. Keeps a column of numbers readable when
// each line carries a different trailing comment.
export function stat(label, value, note = "") {
  return `  ${pad(C.mute(label), 14)}${padStart(value, 9)}${note ? "   " + C.mute(note) : ""}`;
}

export function big(label, value, note) {
  return [
    "",
    "  " + C.bold(C.accent(value)) + "  " + C.mute(label),
    note ? "  " + C.dim(note) : "",
  ].filter(Boolean).join("\n");
}

export function callout(lines, tone = "accent") {
  const paint = C[tone] || C.accent;
  return lines.map((l) => `  ${paint(G.v)} ${l}`).join("\n");
}

export const color = C;
export const glyph = G;
