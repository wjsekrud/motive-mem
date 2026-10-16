# principles.md format

Write the file in the language its people use. The mode reads field and section names in English or Korean only:
use the Korean set for a Korean file and the English set for any other language. The title, the preamble and the
words in parentheses after a section name are free text — write them in the file's language.

| English | 한국어 | Machine-read |
| --- | --- | --- |
| `- Scope:` | `- 범위:` | yes — globs |
| `- Rule:` | `- 규칙:` | no |
| `- Signal:` | `- 신호:` | no |
| `- Evidence:` | `- 근거:` | no |
| `## Allowed exceptions` | `## 허용된 예외` | no |
| `## Recurring band-aids in this repository` | `## 이 저장소에서 반복된 땜질` | no |
| `## Open questions` | `## 열린 질문` | yes — cut before review |

```markdown
# Principles (for intent review)

<2–4 line preamble — the reviewer judges only by what is written here. Only people add or change principles. The names of the source docs.>

## P01 <the principle in one sentence — the title alone should carry the meaning>
- Scope: <globs from the repository root, comma-separated>
- Rule: <what to do / not do. One sentence on what breaks if it's broken.>
- Signal: <how a violation shows in a diff — function names, imports, patterns, concretely. Names of guarding tests, if any.>
- Evidence: <source doc and section / past cases (file:line · commit · date). If a person decided it directly, say so — "maintainer's decision", or the label the repository itself uses.>

## Allowed exceptions (not violations)
- E01 <where, what is allowed, and why> — P03

## Recurring band-aids in this repository (optional — only what the records show more than once)
- <one-line case> → Pxx

## Open questions (become principles or exceptions once a person answers — not given to the reviewer)
- Q01 <what disagrees, where you saw it, which side might be right>
```

## What the mode machine-reads

- `## P01 Title` — the ID is one `[A-Z]` letter plus 1–3 digits in the heading. Headings without an ID, like
  `## Allowed exceptions`, are not read as principles, and the lines under them attach to no principle.
- `- Scope:` (or `- 범위:`) — comma-separated globs. `**/` is zero or more whole folders, a trailing `**` is anything
  below, `*` stays within one folder. Which principle's scope a changed file falls in is counted from this field
  alone.
- Sections whose heading starts with `Open questions` or `Needs confirmation` (`열린 질문`, `확인 필요`) are cut
  before the file goes to the reviewer — up to the next heading of the same level or higher. All other text goes
  to the reviewer as is. A `#` line inside a ``` fence is not a heading.

## Field by field

- **Scope** — a hint, not a boundary. The reviewer gets the whole file anyway. Too wide is the same as no hint — count
  the files. Code files only; pairing with docs goes in the rule sentence. `dir/**/*.py` also matches files directly
  in `dir/`; braces like `{a,b}` are not supported.
- **Rule** — present tense, concrete names. Add one sentence on what breaks if it's broken — the reviewer judges
  borderline cases by it, and the person decides by it whether to grant an exception.
- **Signal** — the most useful field for the reviewer: what text on a `+` line should make it suspect a violation.
  Naming the guarding test catches changes that weaken that test too.
- **Evidence** — the source. Line numbers soon drift, so add a short greppable quote. If the only evidence is
  "inferred from structure", it doesn't belong in this file yet — make it an open question.
- **Exceptions (E)** — lines that silence the reviewer. Write only answered things; if unsure, an open question. The
  trailing `— P03` is text (not machine-read) — when it spans two, `— P03 · P08`.
- Don't refer to open question numbers like `Q01` in principle or exception text — the reviewer doesn't get that
  section.

## Example — a principle

A made-up repository (an order processing service). Don't copy it; look at its shape.

```markdown
## P02 Order status changes only in orders/transitions.py
- Scope: orders/**, api/handlers/**, jobs/**
- Rule: only `transitions.apply(order, event)` changes `Order.status` — the state table check, the audit log and the
  webhook dispatch hang off it. Skipping it produces unlogged status changes, and the refund job sees the wrong state.
- Signal: `order.status =` or `UPDATE orders SET status` outside `transitions.py`; a `save()` that doesn't go through
  `apply()`; a change that loosens `tests/test_transitions.py::test_status_only_changes_through_apply` (counts
  assignment sites through the AST).
- Evidence: ARCHITECTURE.md "State transitions" / the 2026-03 "cancel delay" hotfix wrote `status = CANCELLED`
  directly in a handler and refunds went out twice — reverted (commit 4f2a9c1), test added. Maintainer's decision: "no
  shortcuts; if it's slow, make apply fast".
```

## Example — not principles

| Candidate | Why not | Instead |
| --- | --- | --- |
| Functions stay under 30 lines | Local — only makes those lines unpleasant | a linter |
| Don't change test expectations to make them pass | The mode already checks it | don't write it |
| Order lookup must not get slower | Not visible in a diff | "no per-order N+1 queries on the lookup path" is visible |
| Handlers must be clean | A wish | say what clean means — "handlers don't open DB sessions directly" is a principle |
| Update the ops docs after a deploy | A procedure — one side's diff can't show the other side is missing | don't write it |
| Nobody seems to import this module | Inferred from structure | an open question |
