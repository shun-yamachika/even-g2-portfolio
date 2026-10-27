import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

// このファイルは自宅PCではなく、スマホ上の Even Hub アプリ内で実行される。
// スマートグラスは、ここで作った画面を表示し、クリックなどの入力を返す役割を持つ。
type StudyCard = {
  id: string
  english: string
  japanese: string
  explanation: string
}

type StudyResponse = {
  item: StudyCard | null
  sequence: number
  nextUpdateAt: string | null
  index: number
  total: number
  setId: string
  setName: string
  setIndex: number
  setTotal: number
  nextSetUpdateAt: string | null
}

// VITE_ で始まる値はビルド時にアプリへ埋め込まれる。
// iPhone の Tailscale が、この通常の HTTPS 通信を自宅PCまで運ぶ。
const apiBaseUrl = (import.meta.env.VITE_STUDY_API_URL ?? 'http://localhost:8788').replace(/\/$/, '')

// Even Hub SDK を呼ぶ前に、スマホアプリとの通信経路が準備されるのを待つ。
const bridge = await waitForEvenAppBridge()

// 通信中の状態とタイマーを、画面更新をまたいで保持する。
let current: StudyResponse | null = null
let status = '自宅PCから学習カードを取得しています…'
let stopped = false
let advancing = false
let pollTimer: number | undefined

function pageText(): string {
  // 1枚のカードを、グラス上に表示する単純なテキストへ変換する。
  const item = current?.item
  if (!item || status) return status || '学習カードを取得しています…'

  return [
    item.english,
    '',
    `和訳  ${item.japanese}`,
    '',
    `ポイント  ${item.explanation}`,
  ].join('\n')
}

// Even G2 の表示領域は 576 x 288。今回は全面を1個の TextContainer として使う。
// isEventCapture を有効にしたコンテナが、クリックイベントを受け取る。
const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 12,
  containerID: 1,
  containerName: 'study-card',
  content: pageText(),
  textColor: 4,
  isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)

if (result !== 0) throw new Error(`Failed to create the startup page: ${result}`)

async function render(): Promise<void> {
  // ページ全体を作り直さず、同じコンテナの文字列だけを差し替える。
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'study-card',
      content: pageText(),
      textColor: 4,
    }),
  )
}

async function fetchCurrent(): Promise<void> {
  // sequence はサーバーでカードが進むたびに変わる更新番号。
  // 同じ番号なら再描画を省略し、グラスへの不要な更新を減らす。
  try {
    const response = await fetch(`${apiBaseUrl}/api/cards/current`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const incoming = (await response.json()) as StudyResponse
    const changed = incoming.sequence !== current?.sequence
    const previousStatus = status
    current = incoming
    status = incoming.item ? '' : '自宅PCでカードを準備しています…'
    if (changed || status !== previousStatus) await render()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const nextStatus = `自宅PCに接続できません (${message})`
    if (nextStatus !== status) {
      status = nextStatus
      await render()
    }
  }
}

function nextPollDelay(): number {
  // 次回更新予定の直後に取得する。ただし最大15秒ごとに確認し、
  // 手動クリックやスリープ復帰による変更も長く待たずに検出する。
  if (!current?.nextUpdateAt) return 2_000
  const untilNextUpdate = new Date(current.nextUpdateAt).getTime() - Date.now()
  if (!Number.isFinite(untilNextUpdate)) return 2_000
  return Math.min(15_000, Math.max(500, untilNextUpdate + 250))
}

function schedulePoll(delay = nextPollDelay()): void {
  // setInterval ではなく再帰的な setTimeout を使い、毎回予定時刻へ合わせ直す。
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  if (stopped) return
  pollTimer = window.setTimeout(async () => {
    await fetchCurrent()
    schedulePoll()
  }, delay)
}

async function advance(): Promise<void> {
  // グラスのクリックをサーバーへ伝え、返された最新カードをすぐ描画する。
  if (advancing) return
  advancing = true
  try {
    const response = await fetch(`${apiBaseUrl}/api/cards/advance`, { method: 'POST' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    current = (await response.json()) as StudyResponse
    status = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status = `更新に失敗しました (${message})`
  } finally {
    advancing = false
    await render()
    schedulePoll()
  }
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  // CLICK は enum の 0 なので、protobuf では eventType 自体が省略される場合がある。
  // イベント本体が存在して型が無ければ、クリックとして補完する。
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent((event) => {
  // list/text/sys のいずれから通知されても同じ操作として処理する。
  const eventTypes = [
    eventTypeOf(event.listEvent),
    eventTypeOf(event.textEvent),
    eventTypeOf(event.sysEvent),
  ]

  if (eventTypes.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    // ダブルクリックはアプリ終了。以後の定期通信も止める。
    stopped = true
    if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    void bridge.shutDownPageContainer(1)
    return
  }

  if (eventTypes.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) {
    // アプリへ戻ったときは、待たずに自宅PCの現在値へ同期する。
    void fetchCurrent().finally(() => schedulePoll())
    return
  }

  if (eventTypes.includes(OsEventTypeList.CLICK_EVENT)) void advance()
})

// iOSがWebViewを一時停止した場合にも、表示再開直後に現在値を取り直す。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void fetchCurrent().finally(() => schedulePoll())
})

// 初回カードを取得し、成功・失敗にかかわらず次回取得を予約する。
void fetchCurrent().finally(() => schedulePoll())
