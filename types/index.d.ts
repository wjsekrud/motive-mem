export type FileKind = 'code' | 'test' | 'comment' | 'docs' | 'binary' | 'principles'

export type Level = 'logic' | 'tests' | 'trivial'

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export type FileSummary = {
  path: string
  status: FileStatus
  added: number
  removed: number
  kind: FileKind
}

export type FileChange = FileSummary & { lines: string[] }

export type Principle = { id: string; title: string; scope: string[] }

export type Finding = {
  principle: string
  severity: 'violation' | 'suspect'
  file: string
  line?: number
  why: string
  evidence: string
}

export type Verdict = {
  summary: string
  intent: 'match' | 'partial' | 'mismatch'
  intentNote: string
  findings: Finding[]
  unstated: string[]
  attention: string[]
}

export type Decision = { at: number; principle: string; file: string; why: string }

export type Intent = { prompts: string[]; answer: string }

export type Review = {
  id: string
  at: number
  origin: 'turn' | 'all' | 'retry'
  status: 'running' | 'done' | 'skipped' | 'error'
  level: Level
  range: { from: string; to: string; fresh: string[] }
  files: FileSummary[]
  principleDocs: string[]
  hits: Record<string, string[]>
  intent: Intent
  model: string
  verdict?: Verdict
  error?: string
  excepted: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'motive-mem': { reviews: Review[]; cursor: number; isPaused: boolean }
  }
}
