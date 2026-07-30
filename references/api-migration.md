# Claude Opus 5 API breaking changes

Detail behind the checklist `migrate-models.mjs` prints when a file's model ID migrates to `claude-opus-5`. Read this when you need the full reasoning for one of those items, the checklist itself is enough for a quick pass.

None of `migrate-models.mjs`'s pattern checks (`budget_tokens`, `temperature`, `top_p`, `top_k`) prove your code is broken, and the tool does not attempt to detect the prefill or `tool_choice` issues at all (too easy to get a false positive on arbitrary code). Every item below needs a human to actually look at the call site.

## 1. `budget_tokens` is removed

Old (manual extended thinking with a fixed token budget):

```python
thinking={"type": "enabled", "budget_tokens": 8000}
```

Rejected with 400 on Opus 5 (and Fable 5, Opus 4.7, Opus 4.8). Replace with adaptive thinking:

```python
thinking={"type": "adaptive"}
```

Adaptive thinking lets the model decide when and how much to think, instead of a fixed pre-allocated budget. Combine with `output_config.effort` (`low` through `max`) to control depth and cost.

## 2. `temperature`, `top_p`, `top_k` are rejected

Any explicit value for these three sampling parameters returns a 400 on Opus 5. Omitting them (or passing the default) is fine. If you were relying on `temperature` for output variety, the replacement is prompting for it explicitly (for design/creative tasks, having the model propose several distinct directions and letting a human pick tends to work better than temperature-driven variance anyway), not a parameter.

## 3. Assistant-turn prefill is rejected

A `messages` array ending in a `role: "assistant"` entry (used to force the start of the response, e.g. forcing JSON output by prefilling `{`) returns a 400. Replacements, by what the prefill was doing:

| Prefill was forcing | Replacement |
|---|---|
| A JSON/schema shape | `output_config.format` with a `json_schema` (structured outputs) |
| A specific label/classification | A tool with an enum field, or structured outputs |
| Skipping a preamble ("Here is the summary:") | A system-prompt instruction: respond directly, no preamble |

## 4. Thinking is on by default, and shares `max_tokens` with the response

This is the change most likely to cause a silent, confusing failure during a migration. On Opus 4.8 and earlier, a request that omitted the `thinking` parameter ran with no thinking. On Opus 5, the same request runs with adaptive thinking by default, and `max_tokens` is a hard cap on thinking tokens plus response tokens combined.

Symptom: a route that worked fine on Opus 4.8 with a tight `max_tokens` (sized around the expected answer length, with no thinking to account for) starts returning truncated, cut-off responses on Opus 5, because thinking tokens are now eating into the same budget. Fix: either raise `max_tokens` to leave room for thinking, or explicitly disable it with `thinking: {type: "disabled"}` (only accepted at effort `high` or below; pairing `disabled` with `xhigh` or `max` is itself a 400).

## 5. One-tool-per-turn loops need `disable_parallel_tool_use`

Parallel tool use is on by default: a single assistant turn may contain multiple `tool_use` blocks. A hand-written agent loop that assumes exactly one tool call per turn (common in simpler harnesses) can misbehave if it silently drops all but the first block. If that is your loop's assumption, make it explicit rather than relying on the model happening to call one tool at a time:

```python
tool_choice={"type": "auto", "disable_parallel_tool_use": True}
```

## Why these specific five

This list mirrors what actually breaks a working Opus 4.x integration when the model string is swapped to `claude-opus-5` with nothing else changed: three are hard 400s (`budget_tokens`, sampling params, prefill), one is a silent behavior change that can truncate output without erroring (thinking on by default), and one is a latent assumption that was previously safe to leave implicit. There are more Opus 5 behavioral differences (verbosity, narration style, subagent delegation, and so on) that are worth reading about if you are doing a serious migration, but they are prompt-tuning concerns, not breaking changes, and out of scope for what a mechanical scanner can usefully flag.
