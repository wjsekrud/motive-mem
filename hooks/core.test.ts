import { describe, expect, test } from 'claude-code/testing'

import type { Review } from '../types'
import {
  budgetDiff,
  buildPrompt,
  forReviewer,
  globToRegExp,
  hasIssues,
  levelOf,
  parseDiff,
  parsePrinciples,
  parseVerdict,
  scopeHits,
  statusLine,
  untrackedChunk,
} from './core'

const PRINCIPLES = `# 대원칙

머리말.

## P01 코어는 바깥을 모른다
- 범위: app/core/**
- 규칙: Qt 를 import 하지 않는다.

## P06 쓰기 뒤 동기화는 한 길
- 범위: app/ui/**, \`app/web/**\`
- 규칙: changed 신호 하나.

## 허용된 예외
- 범위: 이건 원칙이 아니다

## 열린 질문 (리뷰어에게는 가지 않는다)
- Q01 meta 쓰기 셋은 예외인가
### 더 물을 것
- 아직 모름

## 반복된 땜질
- setData 직접 호출 → P06
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
-# 권위 순서
+# 권위 순서 (canon 이 가장 높다)

diff --git a/사용 안내.md b/사용 안내.md
index 1111111..2222222 100644
--- a/사용 안내.md\t
+++ b/사용 안내.md\t
@@ -1 +1 @@
-옛 문장
+새 문장
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
+# CLAUDE.md (고침)
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

describe('원칙 문서', () => {
  test('ID 붙은 제목만 원칙으로 읽고 범위를 쉼표로 나눈다', () => {
    const list = parsePrinciples(PRINCIPLES)
    expect(list.map(p => p.id)).toEqual(['P01', 'P06'])
    expect(list[1]?.scope).toEqual(['app/ui/**', 'app/web/**'])
  })

  test('glob: ** 는 폴더를 건너고 * 는 한 칸 안에서만', () => {
    expect(globToRegExp('app/core/**').test('app/core/render/tiler.py')).toBe(true)
    expect(globToRegExp('app/core/**').test('app/cli/main.py')).toBe(false)
    expect(globToRegExp('app/*.py').test('app/a/b.py')).toBe(false)
    expect(globToRegExp('**/test_*.py').test('tests/test_cli.py')).toBe(true)
  })

  test('열린 질문 절은 리뷰어에게 주는 글에서 빠지고 그 다음 절은 남는다', () => {
    const text = forReviewer(PRINCIPLES)
    expect(text).not.toContain('meta 쓰기 셋')
    expect(text).not.toContain('아직 모름')
    expect(text).toContain('## P06')
    expect(text).toContain('setData 직접 호출 → P06')
    expect(parsePrinciples(PRINCIPLES).map(p => p.id)).toEqual(['P01', 'P06'])
    const blocks = buildPrompt({
      principles: PRINCIPLES,
      decisions: [],
      intent: { prompts: [], answer: '' },
      files: [],
      diff: '',
      hits: {},
      maxDiffChars: 1000,
    })
    expect(blocks[0]?.text).not.toContain('열린 질문')
  })

  test('바뀐 파일이 어느 원칙 범위에 드는지', () => {
    const hits = scopeHits(parsePrinciples(PRINCIPLES), [
      'app/core/commands.py',
      'app/web/commands.js',
    ])
    expect(hits).toEqual({
      P01: ['app/core/commands.py'],
      P06: ['app/web/commands.js'],
    })
  })
})

describe('diff 나누기', () => {
  test('코드 · 주석만 · 문서(한글 · 띄어쓰기 이름) · 바이너리 · 테스트 · 원칙 문서', () => {
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

  test('추적 안 되는 새 파일은 전부 + 줄인 새 파일로', () => {
    const [file] = parseDiff(untrackedChunk('app/core/new.py', 'a = 1\r\nb = 2\r\n'))
    expect(file).toMatchObject({ path: 'app/core/new.py', status: 'added', added: 2, kind: 'code' })
  })

  test('분량이 넘치면 코드부터 넣고 나머지는 이름만', () => {
    const files = parseDiff(DIFF)
    const code = DIFF.slice(0, DIFF.indexOf('diff --git a/app/core/model.py'))
    const out = budgetDiff(files, DIFF, code.length + 10)
    expect(out.startsWith('diff --git a/app/core/commands.py')).toBe(true)
    expect(out).toContain('분량 때문에 diff 를 뺀 파일')
    expect(out).toContain('tests/test_cli.py')
    expect(out).not.toContain('map.png (')
  })

  test('요청 블록: 원칙이 먼저이고 캐시 표시, 파일마다 원칙 범위', () => {
    const files = parseDiff(DIFF)
    const blocks = buildPrompt({
      principles: PRINCIPLES,
      decisions: [{ at: 0, principle: 'P06', file: 'x.js', why: '방향 뒤집기는 예외' }],
      intent: { prompts: ['쓰기 버그 고쳐줘'], answer: '쓰기 경로를 고쳤습니다.' },
      files,
      diff: DIFF,
      hits: { P01: ['app/core/commands.py'] },
      maxDiffChars: 100_000,
    })
    expect(blocks[0]?.cache).toBe(true)
    expect(blocks[0]?.text).toContain('## P01')
    expect(blocks[1]?.text).toContain('app/core/commands.py (코드, modified, +2 -1) [원칙 범위: P01]')
    expect(blocks[1]?.text).toContain('P06 x.js: 방향 뒤집기는 예외')
  })
})

describe('답 읽기', () => {
  test('코드 블록에 싸인 JSON 도 읽고, 모르는 심각도는 의심으로 낮춘다', () => {
    const v = parseVerdict(
      '```json\n{"summary":"쓰기를 우회","intent":"partial","intent_note":"보고와 다름","findings":[{"principle":"P03","severity":"critical","file":"a.py","line":12.4,"why":"apply_changeset 을 건너뜀","evidence":"store.raw_write(cs)"},{"principle":"P01","why":""}],"unstated":["b.py 이름 바꿈",""],"attention":["a","b","c","d"]}\n```',
    )
    expect(v?.intent).toBe('partial')
    expect(v?.findings).toEqual([
      { principle: 'P03', severity: 'suspect', file: 'a.py', line: 12, why: 'apply_changeset 을 건너뜀', evidence: 'store.raw_write(cs)' },
    ])
    expect(v?.unstated).toEqual(['b.py 이름 바꿈'])
    expect(v?.attention.length).toBe(3)
  })

  test('JSON 이 아니면 undefined', () => {
    expect(parseVerdict('잘 모르겠습니다')).toBeUndefined()
    expect(parseVerdict('{ 깨진')).toBeUndefined()
  })

  test('예외로 승인한 지적은 상태 줄에서 빠진다', () => {
    const verdict = parseVerdict(
      '{"summary":"s","intent":"match","findings":[{"principle":"P03","severity":"violation","file":"a.py","why":"우회"}],"unstated":[]}',
    )
    const open = review({ verdict })
    expect(hasIssues(open)).toBe(true)
    expect(statusLine(open)).toContain('위반 1')
    const excepted = review({ verdict, excepted: [0] })
    expect(hasIssues(excepted)).toBe(false)
    expect(statusLine(excepted)).toContain('지적 없음')
  })
})

describe('패널', () => {
  test('리뷰가 없으면 안내 문장과 전체 검토 단추', async $ => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'motive-mem',
        surface,
        component: 'Pane',
        requestId: 'motive-mem',
        props: {
          title: '의도 리뷰',
          isFocused: false,
          bodyColumns: 60,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 30 },
          view: {},
        },
      })
      expect(await ui.find({ type: 'Text', text: /아직 리뷰가 없습니다/ })).toBeDefined()
      expect(await ui.find({ key: 'all' })).toBeDefined()
      await ui.unmount()
    }
  })
})
