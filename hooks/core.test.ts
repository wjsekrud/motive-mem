import { describe, expect, test } from 'claude-code/testing'

import type { Review } from '../types'
import {
  budgetDiff,
  buildPrompt,
  fixPrompt,
  forReviewer,
  globToRegExp,
  hasIssues,
  levelOf,
  parseDiff,
  parsePrinciples,
  parseVerdict,
  reviewMarkdown,
  scopeHits,
  statusLine,
  systemPrompt,
  untrackedChunk,
} from './core'

const PRINCIPLES = `# Principles

Preamble.

## P01 The core knows nothing outside it
- Scope: app/core/**
- Rule: no UI imports.

## P06 Sync after a write goes one way
- Scope: app/ui/**, \`app/web/**\`
- Rule: one changed signal.

## Allowed exceptions
- Scope: this is not a principle

## Open questions (not given to the reviewer)
- Q01 are the three meta writes exceptions?
### To ask later
- not known yet

## Recurring band-aids
- direct setData call → P06
`

// The skill writes Korean files with Korean field names; the mode reads both
const PRINCIPLES_KO = `# 대원칙

## P01 코어는 바깥을 모른다
- 범위: app/core/**

## 열린 질문
- Q01 아직 모름

## 허용된 예외
- E01 남는 절
`

const DIFF = `diff --git a/app/core/commands.py b/app/core/commands.py
index 1111111..2222222 100644
--- a/app/core/commands.py
+++ b/app/core/commands.py
@@ -10,3 +10,4 @@ def apply(cs):
     store = open_store()
-    return store.apply_changeset(cs)
+    store.raw_write(cs)
+    return None
diff --git a/app/core/model.py b/app/core/model.py
index 1111111..2222222 100644
--- a/app/core/model.py
+++ b/app/core/model.py
@@ -1,2 +1,2 @@
-# authority order
+# authority order (canon is highest)

diff --git a/사용 안내.md b/사용 안내.md
index 1111111..2222222 100644
--- a/사용 안내.md\t
+++ b/사용 안내.md\t
@@ -1 +1 @@
-old sentence
+new sentence
diff --git a/map.png b/map.png
index 1111111..2222222 100644
Binary files a/map.png and b/map.png differ
diff --git a/tests/test_cli.py b/tests/test_cli.py
index 1111111..2222222 100644
--- a/tests/test_cli.py
+++ b/tests/test_cli.py
@@ -5 +5 @@
-    assert r.code == 3
+    assert r.code in (1, 3)
diff --git a/CLAUDE.md b/CLAUDE.md
index 1111111..2222222 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1 +1 @@
-# CLAUDE.md
+# CLAUDE.md (edited)
`

function review(over: Partial<Review>): Review {
  return {
    id: 'r1',
    at: 0,
    origin: 'turn',
    status: 'done',
    level: 'logic',
    range: { from: 'a', to: 'b', fresh: [] },
    files: [],
    principleDocs: [],
    hits: {},
    intent: { prompts: [], answer: '' },
    model: 'sonnet',
    excepted: [],
    ...over,
  }
}

describe('principles doc', () => {
  test('only headings with an ID are principles; scope splits on commas', () => {
    const list = parsePrinciples(PRINCIPLES)
    expect(list.map(p => p.id)).toEqual(['P01', 'P06'])
    expect(list[1]?.scope).toEqual(['app/ui/**', 'app/web/**'])
  })

  test('Korean field and section names read the same', () => {
    expect(parsePrinciples(PRINCIPLES_KO)).toEqual([{ id: 'P01', title: '코어는 바깥을 모른다', scope: ['app/core/**'] }])
    const text = forReviewer(PRINCIPLES_KO)
    expect(text).not.toContain('아직 모름')
    expect(text).toContain('E01 남는 절')
  })

  test('glob: ** crosses folders, * stays inside one', () => {
    expect(globToRegExp('app/core/**').test('app/core/render/tiler.py')).toBe(true)
    expect(globToRegExp('app/core/**').test('app/cli/main.py')).toBe(false)
    expect(globToRegExp('app/*.py').test('app/a/b.py')).toBe(false)
    expect(globToRegExp('**/test_*.py').test('tests/test_cli.py')).toBe(true)
  })

  test('the open questions section is cut from what the reviewer gets; the next section stays', () => {
    const text = forReviewer(PRINCIPLES)
    expect(text).not.toContain('three meta writes')
    expect(text).not.toContain('not known yet')
    expect(text).toContain('## P06')
    expect(text).toContain('direct setData call → P06')
    expect(parsePrinciples(PRINCIPLES).map(p => p.id)).toEqual(['P01', 'P06'])
    const blocks = buildPrompt({
      principles: PRINCIPLES,
      decisions: [],
      intent: { prompts: [], answer: '' },
      files: [],
      diff: '',
      hits: {},
      maxDiffChars: 1000,
      lang: 'en',
    })
    expect(blocks[0]?.text).not.toContain('Open questions')
  })

  test('which principle scopes the changed files fall in', () => {
    const hits = scopeHits(parsePrinciples(PRINCIPLES), ['app/core/commands.py', 'app/web/commands.js'])
    expect(hits).toEqual({
      P01: ['app/core/commands.py'],
      P06: ['app/web/commands.js'],
    })
  })
})

describe('splitting the diff', () => {
  test('code · comments only · docs (Hangul and spaces in the name) · binary · test · principles doc', () => {
    const files = parseDiff(DIFF)
    expect(files.map(f => [f.path, f.kind])).toEqual([
      ['app/core/commands.py', 'code'],
      ['app/core/model.py', 'comment'],
      ['사용 안내.md', 'docs'],
      ['map.png', 'binary'],
      ['tests/test_cli.py', 'test'],
      ['CLAUDE.md', 'principles'],
    ])
    expect(files[0]).toMatchObject({ added: 2, removed: 1, status: 'modified' })
    expect(levelOf(files)).toBe('logic')
    expect(levelOf(files.filter(f => f.kind !== 'code'))).toBe('tests')
    expect(levelOf(files.filter(f => f.kind !== 'code' && f.kind !== 'test'))).toBe('trivial')
  })

  test('an untracked new file becomes a new file of all + lines', () => {
    const [file] = parseDiff(untrackedChunk('app/core/new.py', 'a = 1\r\nb = 2\r\n'))
    expect(file).toMatchObject({ path: 'app/core/new.py', status: 'added', added: 2, kind: 'code' })
  })

  test('over budget, code goes in first and the rest by name only', () => {
    const files = parseDiff(DIFF)
    const code = DIFF.slice(0, DIFF.indexOf('diff --git a/app/core/model.py'))
    const out = budgetDiff(files, DIFF, code.length + 10)
    expect(out.startsWith('diff --git a/app/core/commands.py')).toBe(true)
    expect(out).toContain('diff left out for length')
    expect(out).toContain('tests/test_cli.py')
    expect(out).not.toContain('map.png (')
  })

  test('request blocks: principles first and cached, scope per file, answer language last', () => {
    const files = parseDiff(DIFF)
    const blocks = buildPrompt({
      principles: PRINCIPLES,
      decisions: [{ at: 0, principle: 'P06', file: 'x.js', why: 'reversing the direction is an exception' }],
      intent: { prompts: ['fix the write bug'], answer: 'Fixed the write path.' },
      files,
      diff: DIFF,
      hits: { P01: ['app/core/commands.py'] },
      maxDiffChars: 100_000,
      lang: 'ko',
    })
    expect(blocks[0]?.cache).toBe(true)
    expect(blocks[0]?.text).toContain('## P01')
    expect(blocks[1]?.text).toContain('app/core/commands.py (code, modified, +2 -1) [in scope of: P01]')
    expect(blocks[1]?.text).toContain('P06 x.js: reversing the direction is an exception')
    expect(blocks[1]?.text.trimEnd().endsWith('principles are in.')).toBe(true)
    expect(blocks[1]?.text).toContain('in Korean')
    expect(systemPrompt('en')).toContain('in English')
  })
})

describe('reading the answer', () => {
  test('reads JSON wrapped in a code fence; an unknown severity drops to suspect', () => {
    const v = parseVerdict(
      '```json\n{"summary":"bypasses the write","intent":"partial","intent_note":"differs from the report","findings":[{"principle":"P03","severity":"critical","file":"a.py","line":12.4,"why":"skips apply_changeset","evidence":"store.raw_write(cs)"},{"principle":"P01","why":""}],"unstated":["renamed b.py",""],"attention":["a","b","c","d"]}\n```',
    )
    expect(v?.intent).toBe('partial')
    expect(v?.findings).toEqual([
      { principle: 'P03', severity: 'suspect', file: 'a.py', line: 12, why: 'skips apply_changeset', evidence: 'store.raw_write(cs)' },
    ])
    expect(v?.unstated).toEqual(['renamed b.py'])
    expect(v?.attention.length).toBe(3)
  })

  test('not JSON → undefined', () => {
    expect(parseVerdict('not sure')).toBeUndefined()
    expect(parseVerdict('{ broken')).toBeUndefined()
  })

  test('a finding approved as an exception leaves the status line', () => {
    const verdict = parseVerdict(
      '{"summary":"s","intent":"match","findings":[{"principle":"P03","severity":"violation","file":"a.py","why":"bypass"}],"unstated":[]}',
    )
    const open = review({ verdict })
    expect(hasIssues(open)).toBe(true)
    expect(statusLine(open, 'en')).toContain('1 violation')
    expect(statusLine(open, 'ko')).toContain('위반 1')
    const excepted = review({ verdict, excepted: [0] })
    expect(hasIssues(excepted)).toBe(false)
    expect(statusLine(excepted, 'en')).toContain('no findings')
    expect(statusLine(excepted, 'ko')).toContain('지적 없음')
  })

  test('the panel names the intent verdict once', () => {
    const r = review({ verdict: parseVerdict('{"summary":"s","intent":"match","findings":[],"unstated":[]}') })
    expect(reviewMarkdown(r, 0, 1, 'en')).toContain('**matches intent**')
    expect(reviewMarkdown(r, 0, 1, 'en')).not.toContain('Intent** matches')
    expect(reviewMarkdown(r, 0, 1, 'ko')).toContain('**의도 일치**')
    expect(reviewMarkdown(r, 0, 1, 'ko')).not.toContain('의도** 의도')
  })

  test('a band-aid with no principle shows in the chosen language, old Korean logs included', () => {
    const verdict = parseVerdict(
      '{"summary":"s","intent":"match","findings":[{"severity":"violation","file":"t.py","why":"loosened the assertion"},{"principle":"땜질","severity":"suspect","file":"u.py","why":"old log"}],"unstated":["b.py renamed"]}',
    )
    expect(verdict?.findings[0]?.principle).toBe('workaround')
    const r = review({ verdict })
    expect(reviewMarkdown(r, 0, 1, 'en')).toContain('[workaround violation]')
    expect(reviewMarkdown(r, 0, 1, 'en')).toContain('[workaround suspect]')
    expect(reviewMarkdown(r, 0, 1, 'ko')).toContain('[땜질 위반]')
    expect(fixPrompt(r, 'en')).toContain('Changed but not in the report: b.py renamed')
    expect(fixPrompt(r, 'ko')).toContain('보고에 없던 변경: b.py renamed')
  })
})

describe('panel', () => {
  test('with no reviews: the hint and the review-all button', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'motive-mem',
        surface,
        component: 'Pane',
        requestId: 'motive-mem',
        props: {
          title: 'Intent review',
          isFocused: false,
          bodyColumns: 60,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 30 },
          view: {},
        },
      })
      expect(await ui.find({ type: 'Text', text: /No reviews yet/ })).toBeDefined()
      expect(await ui.find({ key: 'all' })).toBeDefined()
      await ui.unmount()
    }
  })
})
