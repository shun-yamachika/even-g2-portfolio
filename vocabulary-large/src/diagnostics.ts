export const APP_VERSION = '0.1.8'
const LOG_KEY = 'vocabulary-large.diagnostics.v1'
const POSITION_KEY = 'vocabulary-large.position.v1'
const MAX_RECORDS = 400
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const startedAt = Date.now()
let stage = 'startup'
let records: string[] = []

try {
  const saved: unknown = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]')
  if (Array.isArray(saved)) records = saved.filter((line): line is string => typeof line === 'string').slice(-MAX_RECORDS)
} catch { /* 保存領域を使えなくても単語帳は動かす。 */ }

export function recordDiagnostic(event: string, detail: unknown = {}): void {
  const entry = JSON.stringify({
    time: new Date().toISOString(), session, version: APP_VERSION,
    uptimeMs: Date.now() - startedAt, hidden: document.hidden, stage, event, detail,
  })
  records.push(entry)
  records = records.slice(-MAX_RECORDS)
  try { localStorage.setItem(LOG_KEY, JSON.stringify(records)) } catch { /* メモリ上のログは残す。 */ }
  console.info(`[Vocabulary Large] ${entry}`)
}

export function recordStage(nextStage: string, detail: unknown = {}): void {
  stage = nextStage
  recordDiagnostic('stage', detail)
}

export function diagnosticReport(): string {
  return records.join('\n')
}

export function loadPosition(total: number): number {
  try {
    const saved = localStorage.getItem(POSITION_KEY)
    if (saved === null) return 0
    const index = Number(saved)
    return Number.isInteger(index) && index >= 0 && index < total ? index : 0
  } catch { return 0 }
}

export function savePosition(index: number): void {
  try { localStorage.setItem(POSITION_KEY, String(index)) } catch { /* 保存失敗で表示を止めない。 */ }
}

recordDiagnostic('boot', { userAgent: navigator.userAgent })
