import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { cards } from './cards'
import { cardTileSize, renderCardTiles } from './renderCard'
import { APP_VERSION, diagnosticReport, loadPosition, recordDiagnostic, recordStage, savePosition } from './diagnostics'

const SCREEN_WIDTH = 576
const SCREEN_HEIGHT = 288
const CARD_WIDTH = cardTileSize.width * 2
const CARD_HEIGHT = cardTileSize.height * 2
const CARD_X = (SCREEN_WIDTH - CARD_WIDTH) / 2
const CARD_Y = (SCREEN_HEIGHT - CARD_HEIGHT) / 2
const EVENT_LAYER_ID = 1
const TILE_IDS = [2, 3, 4, 5] as const
const STATUS_CONTAINER_ID = 6
// 実機ではcontainerNameが最大16文字。短い固定名にしてページ全体の拒否を防ぐ。
const TILE_NAMES = ['tile-tl', 'tile-tr', 'tile-bl', 'tile-br'] as const
const configuredInterval = Number(import.meta.env.VITE_CARD_INTERVAL_MS ?? 10_000)
const CARD_INTERVAL_MS = Number.isFinite(configuredInterval) ? Math.max(5_000, configuredInterval) : 10_000
const MOVE_DEBOUNCE_MS = 2_000

if (cards.length === 0) throw new Error('単語カードが登録されていません')

const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  app.innerHTML = `
    <main style="max-width:640px;margin:40px auto;padding:24px;font-family:sans-serif;text-align:center">
      <h1>Vocabulary Large</h1>
      <p id="phone-status"></p>
      <p>Version ${APP_VERSION}</p>
      <details id="diagnostics"><summary>停止したときの記録</summary>
        <p>止まった後に開いて、記録をコピーしてください。記録はこの端末内に保存されます。</p>
        <button id="refresh-diagnostics" type="button">記録を更新</button>
        <textarea id="diagnostic-report" readonly aria-label="停止したときの記録"
          style="width:100%;height:240px;margin-top:12px;font-size:12px"></textarea>
      </details>
    </main>
  `
}
function refreshDiagnostics(): void {
  const report = document.querySelector<HTMLTextAreaElement>('#diagnostic-report')
  if (report) report.value = diagnosticReport()
}
document.querySelector('#diagnostics')?.addEventListener('toggle', refreshDiagnostics)
document.querySelector('#refresh-diagnostics')?.addEventListener('click', refreshDiagnostics)

function setPhoneStatus(message: string, isError = false): void {
  const status = document.querySelector<HTMLElement>('#phone-status')
  if (!status) return
  status.textContent = message
  status.style.color = isError ? '#b00020' : '#222'
}

setPhoneStatus('Even Hub Bridgeに接続しています…')
window.addEventListener('error', event => {
  recordDiagnostic('error', { message: event.message })
  setPhoneStatus(`起動エラー: ${event.message}`, true)
})
window.addEventListener('unhandledrejection', event => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason)
  recordDiagnostic('unhandled-rejection', { message })
  setPhoneStatus(`起動エラー: ${message}`, true)
})

const bridge = await waitForEvenAppBridge()
recordDiagnostic('bridge-ready')
bridge.onLaunchSource(source => recordDiagnostic('launch-source', { source }))
setPhoneStatus('G2画面を作成しています…')

// 画像コンテナは入力を受け取れないため、透明なテキスト層を画面全体に重ねる。
const eventLayer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 4,
  containerID: EVENT_LAYER_ID,
  containerName: 'event-layer',
  content: ' ',
  isEventCapture: 1,
})

// 画像転送に失敗しても原因を実機上で確認できるよう、最前面に状態表示を置く。
const statusLine = new TextContainerProperty({
  xPosition: 0,
  yPosition: 248,
  width: SCREEN_WIDTH,
  height: 40,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 4,
  containerID: STATUS_CONTAINER_ID,
  containerName: 'status',
  content: '単語画像を準備しています…',
  textColor: 4,
  isEventCapture: 0,
})

const imageTiles = TILE_IDS.map((containerID, index) => new ImageContainerProperty({
  xPosition: CARD_X + (index % 2) * cardTileSize.width,
  yPosition: CARD_Y + Math.floor(index / 2) * cardTileSize.height,
  width: cardTileSize.width,
  height: cardTileSize.height,
  containerID,
  containerName: TILE_NAMES[index],
}))

recordStage('creating-page')
const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 6,
    textObject: [eventLayer, statusLine],
    imageObject: imageTiles,
  }),
)
recordDiagnostic('page-created', { result: created })

if (created !== 0) {
  setPhoneStatus(`G2ページ作成エラー: ${created}`, true)
  throw new Error(`ページを作成できませんでした: ${created}`)
}

let requestedIndex = loadPosition(cards.length)
let stopped = false
let autoTimer: number | undefined
let heartbeatTimer: number | undefined
let lastMoveRequestedAt = 0
let renderQueue: Promise<void> = Promise.resolve()

function normalizeIndex(index: number): number {
  return ((index % cards.length) + cards.length) % cards.length
}

async function showNativeError(message: string): Promise<void> {
  setPhoneStatus(`画像表示エラー: ${message}`, true)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: STATUS_CONTAINER_ID,
    containerName: 'status',
    content: message,
    textColor: 4,
  }))
}

async function clearNativeError(): Promise<void> {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: STATUS_CONTAINER_ID,
    containerName: 'status',
    content: ' ',
    textColor: 4,
  }))
}

async function pushTile(index: number, imageData: Uint8Array): Promise<void> {
  const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
    containerID: TILE_IDS[index],
    containerName: TILE_NAMES[index],
    imageData,
  }))
  if (result !== 'success') throw new Error(`${TILE_NAMES[index]}の画像転送に失敗しました: ${result}`)
}

function showCard(index: number): Promise<void> {
  const targetIndex = normalizeIndex(index)
  requestedIndex = targetIndex

  const operation = async () => {
    if (stopped) return
    recordStage('rendering', { card: targetIndex + 1 })
    const tiles = await renderCardTiles(cards[targetIndex], targetIndex, cards.length)
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      if (stopped) return
      recordStage('sending-image', { card: targetIndex + 1, tile: tileIndex + 1 })
      await pushTile(tileIndex, tiles[tileIndex])
    }
    if (stopped) return
    recordStage('clearing-status')
    await clearNativeError()
    savePosition(targetIndex)
    recordStage('waiting', { card: targetIndex + 1 })
    setPhoneStatus(`動作中：${targetIndex + 1}/${cards.length}（${CARD_INTERVAL_MS / 1000}秒ごとに更新）`)
  }

  const queued = renderQueue.then(operation, operation)
  renderQueue = queued.catch(async error => {
    console.error(error)
    const message = error instanceof Error ? error.message : String(error)
    recordDiagnostic('display-error', { message })
    if (!stopped) await showNativeError(`表示エラー: ${message}`)
  })
  return renderQueue
}

function scheduleAutoAdvance(): void {
  if (autoTimer !== undefined) window.clearTimeout(autoTimer)
  autoTimer = undefined
  if (stopped) return
  autoTimer = window.setTimeout(() => {
    autoTimer = undefined
    recordDiagnostic('auto-tick')
    moveBy(1)
  }, CARD_INTERVAL_MS)
}

function moveBy(offset: number): void {
  if (stopped) return
  const now = Date.now()
  if (now - lastMoveRequestedAt < MOVE_DEBOUNCE_MS) {
    scheduleAutoAdvance()
    return
  }
  lastMoveRequestedAt = now
  if (autoTimer !== undefined) window.clearTimeout(autoTimer)
  autoTimer = undefined
  void showCard(requestedIndex + offset).finally(scheduleAutoAdvance)
}

function stopUpdates(reason: string): void {
  stopped = true
  if (autoTimer !== undefined) window.clearTimeout(autoTimer)
  if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer)
  autoTimer = undefined
  heartbeatTimer = undefined
  recordStage('stopped', { reason })
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  // CLICK_EVENTはenum値0なので、protobufでeventTypeが省略される場合を補う。
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  if (event.sysEvent) recordDiagnostic('system-event', event.sysEvent)
  if (event.textEvent) recordDiagnostic('text-event', event.textEvent)
  if (event.listEvent) recordDiagnostic('list-event', event.listEvent)
  const eventTypes = [
    eventTypeOf(event.listEvent),
    eventTypeOf(event.textEvent),
    eventTypeOf(event.sysEvent),
  ]

  if (eventTypes.includes(OsEventTypeList.SYSTEM_EXIT_EVENT)
    || eventTypes.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
    stopUpdates('host-exit')
    return
  }

  if (eventTypes.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    stopUpdates('double-click')
    recordDiagnostic('shutdown-request', { mode: 0 })
    void bridge.shutDownPageContainer(0)
    return
  }

  if (eventTypes.includes(OsEventTypeList.SCROLL_TOP_EVENT)) {
    moveBy(-1)
    return
  }

  if (
    eventTypes.includes(OsEventTypeList.CLICK_EVENT)
    || eventTypes.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)
  ) {
    moveBy(1)
    return
  }

  if (eventTypes.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) ensureAutoAdvance()
})

function ensureAutoAdvance(): void {
  // 復帰イベントで動作中のタイマーを延ばさない。
  if (autoTimer === undefined) scheduleAutoAdvance()
}

document.addEventListener('visibilitychange', () => {
  recordDiagnostic('visibility-change')
  // Beta版は非表示のWebViewでも動作する。ロック時もタイマーを維持する。
  // OSによるWebViewの停止・Evenアプリの強制終了はここでは防げない。
  if (!document.hidden) ensureAutoAdvance()
})
window.addEventListener('pagehide', event => recordDiagnostic('pagehide', { persisted: event.persisted }))
window.addEventListener('pageshow', event => recordDiagnostic('pageshow', { persisted: event.persisted }))

let lastHeartbeat = Date.now()
heartbeatTimer = window.setInterval(() => {
  const now = Date.now()
  recordDiagnostic('heartbeat', { gapMs: now - lastHeartbeat })
  lastHeartbeat = now
}, 15_000)

await showCard(requestedIndex)
scheduleAutoAdvance()
