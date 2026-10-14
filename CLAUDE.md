# CLAUDE.md

Motive-mem — one Claude Code mode (`motive-mem`) and its one skill (`principles`). Overview in `README.md`; the Korean
`README.ko.md` says the same — change both together. Code, comments and docs are in English; what users see is in
English and Korean (`hooks/text.ts`).

## Layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest · `userConfig` (language · model · effort · maxDiffChars · openOnIssue) |
| `.claude-plugin/marketplace.json` | Makes this folder a marketplace — the install is this folder itself |
| `hooks/core.ts` | Pure functions: reading principles · glob · splitting the diff · building the review request · reading the answer · panel text. The reviewer's system prompt `systemPrompt()` is here too |
| `hooks/text.ts` | Every user-facing string, in English and Korean |
| `hooks/register.tsx` | The engine side: turn start/end snapshots · background review · command · panel |
| `hooks/core.test.ts` | Run by `claude plugin test .` |
| `types/index.d.ts` | Review types and `PluginState['motive-mem']` |
| `skills/principles/` | The skill that digs out the principles file |

`.claude-plugin/types/` holds types the engine writes (gitignored). If it is missing, load the plugin-authoring skill
in this folder to get them again.

## Checks

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p tsconfig.json --noEmit
```

- Pass `$` only to top-level module functions (the validator enforces it) — that is why every helper in
  `register.tsx` is top-level.
- Anything that involves judgment goes in `core.ts`, with a test. `register.tsx` only calls the engine and git.
- The state keys, command name, panel id and log folder (`.git/motive-mem/`) all equal the plugin name. Rename them
  together.
- A new user-facing string goes in `hooks/text.ts` in both languages — `Words` makes a missing one a type error.
- The review request (system prompt, tags, file list) stays in English whatever the language; only the sentences of
  the answer follow `language`.
- The principles format is read in both languages (`- Scope:` / `- 범위:`, `## Open questions` / `## 열린 질문`).
  Change the parser, the skill's `references/format.md` and the tests together.

## When changing the reviewer prompt or the skill

If you change `systemPrompt()` (core.ts) or the principles format, rerun the reviewer's judgment check in both
languages. Expect: a violation of a principle is flagged with that principle's ID, a band-aid (e.g. a loosened test)
is flagged, a change missing from the report lands in "unstated", and a clean change comes back with no findings at
all. A minor finding on a clean change opens the panel for nothing, so it counts as a failure. The author's scenarios
use a private repository and are not in this repo; in a pull request, show before/after on a few real diffs of those
four kinds.

If you change the skill (`principles`), give a fresh agent only the skill, have it build a principles file from
scratch, and ask where it was ambiguous. Don't change it to make principles stronger or more numerous — a growing
principles file is the drift this mode exists to stop.
