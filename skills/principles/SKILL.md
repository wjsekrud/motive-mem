---
name: principles
description: Create or revise `.claude/principles.md`, the repository principles file the motive-mem mode reviews against. It does not invent principles — it digs out the ones people already settled, from CLAUDE.md, design docs, docstrings of code and tests, reverted commits and the mode's own review logs, and has the human confirm them. Use when the user wants a principles file ("set up principles.md", "make principles for intent review", "의도 리뷰 원칙 만들어줘"), when /motive-mem says there is no principles file, when the user wants to add, drop or narrow a principle ("this principle fires too often", "make this an exception", "이 원칙 너무 자주 걸려"), or when reviews keep raising wrong findings.
user-invocable: true
---

# Intent review principles file

## What this file does

After every turn, the motive-mem mode hands a separate model four things only — this principles file, the user's
request, Claude's last report, and the diff. The reviewer cannot see the codebase. So every principle must be
judgeable **from its own sentences and the diff alone**.

The reviewer already checks the following regardless of the principles file (it is in the mode's system prompt):

- Intent match — changes missing from the report, an overstated report ("checks pass" passed off as "the user
  confirmed"), changes outside the request
- Band-aid traces — bypassing a single entry point, a second copy of an existing rule or formula, a branch that fixes
  only one case, swallowed exceptions, changed test expectations or snapshots, skip/xfail, longer waits, a flag for
  one particular task

So general rules like "one thing at a time" or "don't weaken tests" need not be written again. What the principles
file covers is **what only this repository has** — which layer must not know which, which single path writes go
through, where "the one place" for a rule or formula is, which promises (determinism, contracts, preservation) must
hold. The reviewer knows the pattern "skipped the single entry point", but only the principles file can tell it that
in this repository the entry point is `commands.py`.

## When a candidate is a principle

More principles do not make reviews better. Each added principle adds findings to every review, and once wrong
findings pile up people stop looking at the panel. From then on the mode is pure cost. The principles file growing is
itself the drift this mode exists to stop — adding needs evidence; removing needs only that the evidence was wrong.

Decide each candidate by four tests.

1. **Is it non-local?** Breaking it breaks something outside the changed lines — another module, the next task, a
   property that must be preserved. Things that only make those lines unpleasant to look at (names, format, taste)
   are the job of linters and code review, not principles.
2. **Is there a temptation?** Is there a shortcut that makes breaking it attractive for solving the problem at hand
   quickly? Temptation is not only human — formatters, import sorting and a quick edit that "fixes" a linter warning
   break principles too. A rule nobody has a reason to break never produces findings and only takes up room. A record of
   having actually broken it is the best answer.
3. **Is it visible in a diff?** Can a reviewer holding only the principle's sentences and the diff judge it? What you
   only know by running (performance, correctness of results) gets rewritten as a symptom that shows in a diff, or
   dropped. "Same seed, same result" needs a run, but "do not change the order of random calls in existing steps" is
   visible in a diff.
4. **Did a person already decide it?** What people put in the repository and made others follow is theirs, even if
   Claude wrote it down — CLAUDE.md, design docs, tests and docstrings that state invariants. Lines that record a
   person's decision or answer ("maintainer's decision", "user's answer", or the label the repository itself uses) are
   the strongest; say so in the evidence field. What is not a person's is **what this
   investigation inferred from the code structure** — that is a question, not a principle. Put it in the table and add
   it once the person answers. This file is not a place for Claude's design opinions.

A candidate that passes all four is a principle. The right size is the smallest set that covers all past correction
records. Candidates with neither evidence nor cases are dropped or asked about.

Not principles:

- Style, naming rules, formatting — the linter's job
- General rules the mode already checks (above)
- Wishes ("must be fast", "must be clean")
- UI behavior specs ("Save stays disabled until the form is valid", "there are three ways to close the dialog") —
  people decided them and they show in a diff, but breaking one only breaks that behavior (local). That is the job of spec documents and UI
  tests.
- Procedures ("update the docs too", "verify on staging"). The line between procedure and principle is this — **can the
  reviewer, seeing a diff that changes only one side, tell that the other side is missing?** "If you change the CLI, update CLI.md
  too" can be told, so it is a principle; "touch up the usage docs after work" cannot, so it is a procedure.
- A property a test fully catches doesn't need a long rule — the test name and a one-line invariant are enough. That
  way a change that weakens the test gets caught. A candidate with only a test and no docs or records still counts as
  evidence if the test name or docstring states the invariant.

## Procedure

### 0. Get your bearings

- Find the repository root with `git rev-parse --show-toplevel`. If it is not a repository, stop — the mode only runs
  in git repositories.
- If `.claude/principles.md` already exists, this is a **revision** (section below). If not, **first creation**.
- If `.git/motive-mem/` holds `reviews.jsonl` or `decisions.jsonl`, the mode has run here. Those are the best evidence
  for a revision.
- Pick the language — for the file and for the table in step 5: the one the people working in the repository use
  (its CLAUDE.md and docs are a good guide). The mode reads field and section names in English or Korean; see
  `references/format.md`.

### 1. Gather evidence

Look for four kinds, and note where each candidate came from. That becomes the evidence field later.

**Written rules** — CLAUDE.md, AGENTS.md, .cursorrules, CONTRIBUTING, ARCHITECTURE, design and requirement docs under
docs/. Sentences with "never", "only", "must", "the one place", "do not" — or their equivalents in the repository's
language (Korean: "하지 않는다", "유일한", "한 곳", "오직"). Such sentences were usually written after getting burned once.

**Correction records** — the most valuable evidence: traces of a person saying "no". Where they live differs per
repository.

- Docstrings and comments of code and tests: "we used to …", "this once …", "fails before the fix", "measured",
  "reverted", "overturned". If a test header says "fails before the fix / passes after", that test is itself a
  correction record.
- In documents: "we did X, then changed to Y", "don't do X (we did once)", strikethroughs, "lessons" sections, items
  deferred or rewritten in work logs and progress tables.
- Commits: search with `git log --oneline -i --grep` for revert, regress, rollback, wrong, undo (in a Korean repository
  also 되돌림, 원복, 걷어냄, 잘못, 회귀), then open each hit's diff to see whether it really reverted something — an
  app's "undo" feature or a "cleanup" task matches too. If commits are bundled per milestone, the commit log is no
  evidence; go to the two above.

A correction record says "no" to an **approach** — "don't solve it that way, go this way". A plain bug fix (a 404, a
race, a typo in a formula) is a case, not evidence for a principle. Only when bugs of the same shape recur is there a
principle behind them.

**Guarding tests** — tests that check an invariant (`test_deps`, `test_*_contract`, tests that count calls through the
AST …). A test existing often means the property broke once.

**Structure** — import direction, writes that call only one function, constants that live in one file only. Check
with `grep` that the code actually holds it now. Structure with no written rule or correction record behind it is a
question, not a candidate.

In a large repository, split the search among investigation agents. When delegating, don't say "come up with
principles" but "find sentences and records of these kinds and bring them back with their source (file:line)".
Confirm with `grep` that the test and function names they bring back exist — agents paraphrase names, and test names
go into the signal field, where the reviewer uses that name to spot weakening.

### 2. Filter and merge

Filter with the four tests above. Then:

- One sentence in a document is not one principle. Gather sentences that state the same invariant into one principle
  — under "one write path" go the entry point, the audit log, the state check and "a rejected request writes
  nothing".
- One principle = one kind of signal. Items caught by the same signal (a list of "the one place"s, a list of forbidden
  imports) are one principle — the list tells where. Different signals are different principles — a second copy of a
  formula or table, a call that skips the channel (a notification sent around the event bus), and adding a computed value as
  a stored field all belong to the "one place" story but look different in a diff, so they are three. When scope globs
  reach about twenty, it is time to split. The reviewer must be able to point at it with one ID.
- If a correction record remains that fits no principle, the principle it points to is missing.

### 3. Measure scope

Scope is a hint to the reviewer: "if this file changed, look at this principle". A scope that covers nearly every file
says nothing. Count the way the mode reads globs — `**` and `**/` are `.*` (so `src/**/*.py` also matches files
directly in `src/`), `*` is `[^/]*`, `?` is one character, anchored with `^` and `$`. Braces like `{a,b}` are not
supported — list the globs separately.

```sh
git ls-files | grep -cE '^src/core/.*$'          # src/core/**
git ls-files | grep -cE '^src/.*\.py$'           # src/**/*.py
git ls-files | grep -cE '^src/[^/]*\.py$'        # src/*.py
```

Count per principle. Several globs are a union; the denominator is every file that could reasonably be in scope —
sources and data (tables like `rates.json` count), not tests, docs or binaries. Past about half, narrow it to where
the rule actually bites — "writes go through commands.py" only needs to cover the places that can write (core, CLI,
API handlers), and a list of "the one place"s only needs to cover those places themselves (copies made elsewhere are caught
by the mode's band-aid check). Global rules that can't be narrowed (dependency direction) get their ratio written in
the table, and the person decides. Pairing with documents goes in the rule sentence, not the scope — the mode does not
review turns that changed only docs, so putting docs in scope gains nothing.

### 4. Check against the current code

For each principle, decide its signal (how a violation shows in a diff) and grep the current code for it. Any hit is
one of three:

- Something the docs (or a docstring or comment at that spot) already call an exception → write it as an allowed exception `Exx`. If you don't, the reviewer
  flags every change that touches that spot.
- The code has more exceptions than the docs name (the docs say "only two", the code has three) → don't promote it to
  an exception on a guess. Raise it as an open question and tell the person the docs are stale. An exception makes the
  reviewer never look at that spot again; as a question, a diff touching it gets flagged and the person answers with
  "approve as exception" in the panel — that is the flow the mode is built for.
- A violation nobody knew about → the principle is not actually held. Ask the person (fix the principle, or fix the
  code); until they answer, it is an open question.

When documents disagree (CLAUDE.md says "only in one place", a comment by the copy says "deliberately the same
value"), pick neither — it is an open question. Paired rules ("if you change X, change Y") have no signal in the current
code, so skip this step for them.

### 5. Show the person — don't write yet

Show one table. Per row: ID · one-line rule · kinds of evidence (a person's decision / document / past case / test /
inferred from structure — one or more) · files in scope (count and share) · open questions. Show dropped candidates briefly too
("dropped: style", "dropped: the mode already checks it"). Wait for the person to delete or edit rows or answer the
questions. The principles are the person's — skip this step and Claude's guesses become principles. Whatever the
question column leaves unanswered becomes the file's `## Open questions` section as is.

### 6. Write

Write `.claude/principles.md` in the format of `references/format.md`. The mode machine-reads `## P01 Title` and
`- Scope:`, cuts the `## Open questions` section before the file goes to the reviewer, and gives everything else to
the reviewer as written — write it for people to read and the reviewer reads it well too. (Korean names work the same;
see the format.) Anything the person hasn't answered yet doesn't get a "(needs confirmation)" tag on a principle or
exception line — move it to `## Open questions`. Principle lines are the reviewer's criteria and exception lines
silence it, so both hold only answered things. For a principle with a question attached, keep the principle and move
just the question. Don't refer to Q numbers in principle or exception text — that section is cut, so the reviewer has
nothing to look up.

This text goes into the model whole on every review. The two or three strongest pieces of evidence and a few
representative guarding tests are enough.

### 7. Wrap up

Tell the person:

- The mode turns on in this repository from the next session (it turns on when the file exists). To see it right
  away: `/motive-mem all`.
- Wrong findings go through "approve as exception" in the panel — they land in `decisions.jsonl` and are not raised
  again. When the same exception piles up, come back to this skill to promote it to an `Exx` or narrow the scope.
- The person commits.

## Revising (when the file already exists)

Don't rewrite it. The existing principles are ones the person confirmed. Gather evidence and propose **only the lines
to change**.

The mode's logs are the best evidence (`.git/motive-mem/`, one JSON object per line):

- `decisions.jsonl` — findings the person approved as exceptions, `{principle, file, why}`. Exceptions piling up on one
  principle mean the scope is too wide, an exception `Exx` is missing, or the rule sentence is stronger than reality.
  Narrow it or add the exception.
- `reviews.jsonl` — per review, `verdict.findings[].principle` and `excepted` (the numbers of findings made
  exceptions). A principle that was flagged and not made an exception is one that actually bit — leave it. A principle
  that never produced a finding may just not have been touched — that alone is no reason to drop it.
- What remains in `## Open questions` — ask whether they have been answered since.
- Correction records since the principles file last changed (`git log --since`, or after that commit) — candidates
  for new principles.

Propose "narrow · add an exception · drop" first, and "add" only with evidence. Show a table; when the person picks,
change only those lines.

## A repository with little to go on

If there are no written rules and no correction records (a new repository, a short git history), don't dig — ask.
Three questions are enough:

1. Are there layers or modules that must not know about each other (dependency direction)?
2. Is there one path every change must go through (writes, events, config)?
3. Is there something that broke once and cost you — whether a person or an AI broke it?

Write only what comes out of the answers, keep scopes narrow, and revise with the logs the mode builds up as it runs.
