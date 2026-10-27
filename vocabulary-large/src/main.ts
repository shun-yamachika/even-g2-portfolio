import {
  CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate,
  OsEventTypeList, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { cardTileSize, renderCardTiles } from './renderCard'
import type { VocabularyCard } from './cards'

type CardResponse = {
  item: VocabularyCard
  index: number
  total: number
  sequence: number
  session: string
  intervalMs: number
  nextUpdateAt: string
}
const apiUrl = import.meta.env.DEV
  ? '/vocabulary-api'
  : (import.meta.env.VITE_VOCABULARY_API_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '')
const TILE_IDS = [2, 3, 4, 5] as const
const TILE_NAMES = ['tile-tl', 'tile-tr', 'tile-bl', 'tile-br'] as const
const app = document.querySelector<HTMLDivElement>('#app')
if (app) app.innerHTML = `<main style="padding:24px;font-family:sans-serif;text-align:center">
  <h1>Vocabulary Large</h1><p>Version 0.2.0 / PC配信</p><p id="status">自宅PCに接続しています…</p>
</main>`
function phoneStatus(message: string): void {
  const node = document.querySelector('#status')
  if (node) node.textContent = message
}
window.addEventListener('error', event => phoneStatus(`起動エラー: ${event.message}`))
window.addEventListener('unhandledrejection', event => {
  phoneStatus(`処理エラー: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`)
})
async function waitStage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  phoneStatus(label)
  // 待機を表示するだけで、進行中の画像転送を再送・重複実行しない。
  const warning = window.setTimeout(() => phoneStatus(`${label}（12秒以上応答待ち）`), 12_000)
  try { return await operation() }
  finally { window.clearTimeout(warning) }
}
const bridge = await waitStage('Evenアプリとの接続待ち…', waitForEvenAppBridge)
const result = await waitStage('G2画面を作成しています…', () => bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 6,
  textObject: [
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 288,
      borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: 1, containerName: 'event-layer', content: ' ', isEventCapture: 1,
    }),
    new TextContainerProperty({
      xPosition: 0, yPosition: 248, width: 576, height: 40,
      borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: 6, containerName: 'status', content: '自宅PCに接続しています…', textColor: 4, isEventCapture: 0,
    }),
  ],
  imageObject: TILE_IDS.map((containerID, index) => new ImageContainerProperty({
    xPosition: (576 - cardTileSize.width * 2) / 2 + (index % 2) * cardTileSize.width,
    yPosition: (288 - cardTileSize.height * 2) / 2 + Math.floor(index / 2) * cardTileSize.height,
    width: cardTileSize.width, height: cardTileSize.height,
    containerID, containerName: TILE_NAMES[index],
  })),
})))
if (result !== 0) throw new Error(`G2ページ作成エラー: ${result}`)

let current: CardResponse | null = null
let renderedKey = ''
let lastError = ''
let stopped = false
let timer: number | undefined
let queue: Promise<void> = Promise.resolve()
let controller: AbortController | undefined
let lastManualAt = 0
let refreshPending = false
let manualPending = false

async function setStatus(message: string): Promise<void> {
  if (stopped) return
  phoneStatus(message || (current ? `動作中：${current.index + 1}/${current.total}（PC配信）` : '接続中…'))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 6, containerName: 'status', content: message || ' ', textColor: 4,
  }))
}
function parseCard(value: unknown): CardResponse {
  const card = value as CardResponse | null
  if (!card || !card.item || ['word', 'meaning', 'example'].some(key => typeof card.item[key as keyof VocabularyCard] !== 'string')
    || !Number.isInteger(card.index) || !Number.isInteger(card.total) || card.index < 0 || card.index >= card.total
    || !Number.isSafeInteger(card.sequence) || typeof card.session !== 'string'
    || !Number.isFinite(Date.parse(card.nextUpdateAt))) throw new Error('カードの応答が不正です')
  return card
}
async function sync(path = '/api/cards/current', method = 'GET'): Promise<void> {
  if (stopped) return
  controller = new AbortController()
  const requestController = controller
  const timeout = window.setTimeout(() => requestController.abort(), 10_000)
  let incoming: CardResponse
  try {
    phoneStatus('PCから単語を取得しています…')
    const response = await fetch(`${apiUrl}${path}`, { method, cache: 'no-store', signal: requestController.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    incoming = parseCard(await response.json())
  } finally {
    window.clearTimeout(timeout)
    controller = undefined
  }
  if (stopped) return
  current = incoming
  const key = `${incoming.session}:${incoming.sequence}`
  if (key !== renderedKey) {
    const tiles = await waitStage('単語画像を作成しています…', () => renderCardTiles(incoming.item, incoming.index, incoming.total))
    for (let i = 0; i < tiles.length; i++) {
      if (stopped) return
      const sent = await waitStage(`G2へ画像を転送しています（${i + 1}/4）…`, () => bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: TILE_IDS[i], containerName: TILE_NAMES[i], imageData: tiles[i],
      })))
      if (sent !== 'success') throw new Error(`${TILE_NAMES[i]}の画像転送: ${sent}`)
    }
    if (stopped) return
    renderedKey = key
    await setStatus('')
  } else if (lastError) await setStatus('')
  else phoneStatus(`動作中：${current.index + 1}/${current.total}（PC配信）`)
  lastError = ''
}
function schedulePoll(): void {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  if (stopped) return
  const untilNext = current && !lastError ? Date.parse(current.nextUpdateAt) - Date.now() + 250 : 2_000
  timer = window.setTimeout(() => {
    timer = undefined
    refresh()
  }, Math.min(15_000, Math.max(500, untilNext)))
}
function enqueue(path?: string, method?: string): Promise<void> {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  const operation = async () => {
    if (stopped) return
    try { await sync(path, method) }
    catch (error) {
      if (stopped) return
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) {
        lastError = message
        await setStatus(`更新できません: ${message}`)
      }
    }
  }
  queue = queue.then(operation, operation).catch(error => console.error('表示更新エラー:', error))
  return queue.finally(schedulePoll)
}
function refresh(): void {
  if (stopped || refreshPending) return
  refreshPending = true
  void enqueue().finally(() => { refreshPending = false })
}
function move(offset: number): void {
  if (stopped || manualPending || Date.now() - lastManualAt < 2_000) return
  lastManualAt = Date.now()
  manualPending = true
  void enqueue(offset > 0 ? '/api/cards/advance' : '/api/cards/previous', 'POST')
    .finally(() => { manualPending = false })
}
function stop(): void {
  stopped = true
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  controller?.abort()
}
function eventType(event?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  return event ? event.eventType ?? OsEventTypeList.CLICK_EVENT : null
}
bridge.onEvenHubEvent(event => {
  const types = [eventType(event.sysEvent), eventType(event.textEvent), eventType(event.listEvent)]
  if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
    stop()
    return
  }
  if (stopped) return
  if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    void bridge.shutDownPageContainer(1)
    return
  }
  if (types.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) { refresh(); return }
  if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) move(-1)
  else if (types.includes(OsEventTypeList.CLICK_EVENT) || types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) move(1)
})
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })
refresh()
