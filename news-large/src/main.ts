import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  newsTileSize,
  paginateNewsBody,
  renderBodyTiles,
  renderHeadlineTiles,
} from './renderNews'

type NewsItem = {
  id: string
  headline: string
  summary: string
  body: string
  category: string
  sourceName: string
  sourceUrl: string
  publishedAt: string
  generatedAt: string
}

type NewsResponse = {
  item: NewsItem | null
  sequence: number
  nextUpdateAt: string | null
  provider: string
}

const SCREEN_WIDTH = 576
const SCREEN_HEIGHT = 288
const EVENT_LAYER_ID = 1
const HEADLINE_TILE_IDS = [2, 3] as const
const BODY_TILE_IDS = [4, 5] as const

const apiBaseUrl = (import.meta.env.VITE_NEWS_API_URL ?? 'http://localhost:8789').replace(/\/$/, '')
const bridge = await waitForEvenAppBridge()

let current: NewsResponse | null = null
let status = 'ニュースを取得しています…'
let stopped = false
let advancing = false
let pollTimer: number | undefined
let bodyPageIndex = 0

function headlineText(): string {
  return current?.item?.headline || 'NEWS FLOW'
}

function bodySourceText(): string {
  const item = current?.item
  if (!item || status) return status || 'ニュースを取得しています…'
  return item.body || item.summary || '本文を取得できませんでした。'
}

function bodyPages(): string[][] {
  return paginateNewsBody(bodySourceText())
}

// ImageContainerは入力イベントを受け取れないため、空のTextContainerを全面に置く。
const eventLayer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 0,
  containerID: EVENT_LAYER_ID,
  containerName: 'event-layer',
  content: ' ',
  isEventCapture: 1,
})

// 576x288の画面を、G2の上限サイズ288x144の画像4枚で覆う。
const imageTiles = [
  new ImageContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: newsTileSize.width,
    height: newsTileSize.height,
    containerID: HEADLINE_TILE_IDS[0],
    containerName: 'headline-left',
  }),
  new ImageContainerProperty({
    xPosition: newsTileSize.width,
    yPosition: 0,
    width: newsTileSize.width,
    height: newsTileSize.height,
    containerID: HEADLINE_TILE_IDS[1],
    containerName: 'headline-right',
  }),
  new ImageContainerProperty({
    xPosition: 0,
    yPosition: newsTileSize.height,
    width: newsTileSize.width,
    height: newsTileSize.height,
    containerID: BODY_TILE_IDS[0],
    containerName: 'body-left',
  }),
  new ImageContainerProperty({
    xPosition: newsTileSize.width,
    yPosition: newsTileSize.height,
    width: newsTileSize.width,
    height: newsTileSize.height,
    containerID: BODY_TILE_IDS[1],
    containerName: 'body-right',
  }),
]

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 5,
    textObject: [eventLayer],
    imageObject: imageTiles,
  }),
)

if (result !== 0) throw new Error(`Failed to create the startup page: ${result}`)

async function pushTile(containerID: number, containerName: string, imageData: Uint8Array): Promise<void> {
  const updateResult = await bridge.updateImageRawData(
    new ImageRawDataUpdate({ containerID, containerName, imageData }),
  )
  if (updateResult !== 'success') throw new Error(`${containerName}の画像転送に失敗しました: ${updateResult}`)
}

// BLE画像転送は同時実行せず、すべてこのPromiseキューで直列化する。
let renderQueue: Promise<void> = Promise.resolve()

function enqueueRender(operation: () => Promise<void>): Promise<void> {
  const queued = renderQueue.then(operation, operation)
  renderQueue = queued.catch(error => console.error('画面更新に失敗しました:', error))
  return queued
}

function renderAll(): Promise<void> {
  return enqueueRender(async () => {
    const pages = bodyPages()
    bodyPageIndex = Math.min(bodyPageIndex, pages.length - 1)
    const [headlineTiles, bodyTiles] = await Promise.all([
      renderHeadlineTiles(headlineText()),
      renderBodyTiles(pages[bodyPageIndex], bodyPageIndex, pages.length),
    ])

    await pushTile(HEADLINE_TILE_IDS[0], 'headline-left', headlineTiles[0])
    await pushTile(HEADLINE_TILE_IDS[1], 'headline-right', headlineTiles[1])
    await pushTile(BODY_TILE_IDS[0], 'body-left', bodyTiles[0])
    await pushTile(BODY_TILE_IDS[1], 'body-right', bodyTiles[1])
  })
}

function renderBody(): Promise<void> {
  return enqueueRender(async () => {
    const pages = bodyPages()
    bodyPageIndex = Math.min(bodyPageIndex, pages.length - 1)
    const tiles = await renderBodyTiles(pages[bodyPageIndex], bodyPageIndex, pages.length)

    // スクロール時は見出し側を触らず、下半分の2枚だけ差し替える。
    await pushTile(BODY_TILE_IDS[0], 'body-left', tiles[0])
    await pushTile(BODY_TILE_IDS[1], 'body-right', tiles[1])
  })
}

async function fetchCurrent(): Promise<void> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/news/current`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const incoming = (await response.json()) as NewsResponse
    const changed = incoming.sequence !== current?.sequence
    const previousStatus = status
    if (changed) bodyPageIndex = 0
    current = incoming
    status = incoming.item ? '' : '最初のニュースを準備しています…'
    if (changed) {
      await renderAll()
    } else if (status !== previousStatus) {
      await renderBody()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const nextStatus = `配信サーバーに接続できません (${message})`
    if (nextStatus !== status) {
      status = nextStatus
      await renderBody()
    }
  }
}

function nextPollDelay(): number {
  if (!current?.nextUpdateAt) return 5_000
  const untilNextUpdate = new Date(current.nextUpdateAt).getTime() - Date.now()
  if (!Number.isFinite(untilNextUpdate)) return 5_000
  return Math.min(60_000, Math.max(1_500, untilNextUpdate + 750))
}

function schedulePoll(delay = nextPollDelay()): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  if (stopped) return
  pollTimer = window.setTimeout(async () => {
    await fetchCurrent()
    schedulePoll()
  }, delay)
}

async function advance(): Promise<void> {
  if (advancing) return
  advancing = true
  status = '次のニュースを取得しています…'
  bodyPageIndex = 0
  await renderBody()
  try {
    const response = await fetch(`${apiBaseUrl}/api/news/advance`, { method: 'POST' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    current = (await response.json()) as NewsResponse
    status = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status = `更新に失敗しました (${message})`
  } finally {
    advancing = false
    await renderAll()
    schedulePoll()
  }
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null

  // CLICK_EVENTはenum値0なので、protobufでeventTypeが省略される場合を補う。
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  const eventTypes = [
    eventTypeOf(event.listEvent),
    eventTypeOf(event.textEvent),
    eventTypeOf(event.sysEvent),
  ]

  if (eventTypes.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    stopped = true
    if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    void bridge.shutDownPageContainer(1)
    return
  }

  if (eventTypes.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    const lastPage = bodyPages().length - 1
    const nextPage = Math.min(lastPage, bodyPageIndex + 1)
    if (nextPage !== bodyPageIndex) {
      bodyPageIndex = nextPage
      void renderBody()
    }
    return
  }

  if (eventTypes.includes(OsEventTypeList.SCROLL_TOP_EVENT)) {
    const previousPage = Math.max(0, bodyPageIndex - 1)
    if (previousPage !== bodyPageIndex) {
      bodyPageIndex = previousPage
      void renderBody()
    }
    return
  }

  if (eventTypes.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) {
    void fetchCurrent().finally(() => schedulePoll())
    return
  }

  if (eventTypes.includes(OsEventTypeList.CLICK_EVENT)) void advance()
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void fetchCurrent().finally(() => schedulePoll())
})

// まず画像コンテナへ初期表示を送り、その後ニュース取得と定期確認を始める。
await renderAll()
void fetchCurrent().finally(() => schedulePoll())
