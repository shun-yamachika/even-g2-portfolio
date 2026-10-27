import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

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

const apiBaseUrl = (import.meta.env.VITE_NEWS_API_URL ?? 'http://localhost:8787').replace(/\/$/, '')
const bridge = await waitForEvenAppBridge()

let current: NewsResponse | null = null
let status = 'ニュースを取得しています…'
let stopped = false
let advancing = false
let pollTimer: number | undefined
let bodyPageIndex = 0

// ネイティブTextContainerの固定フォントで、本文を約150文字ずつ表示する。
const bodyPageSize = 150

function headlineText(): string {
  return current?.item?.headline || 'NEWS FLOW'
}

function bodyText(): string {
  const item = current?.item
  if (!item || status) return status || 'ニュースを取得しています…'

  const bodyCharacters = Array.from(item.body || item.summary || '本文を取得できませんでした。')
  const pageTotal = Math.max(1, Math.ceil(bodyCharacters.length / bodyPageSize))
  const safePageIndex = Math.min(bodyPageIndex, pageTotal - 1)
  return bodyCharacters.slice(safePageIndex * bodyPageSize, (safePageIndex + 1) * bodyPageSize).join('')
}

const headlineContainer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 88,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 12,
  containerID: 1,
  containerName: 'headline',
  content: headlineText(),
  textColor: 4,
  isEventCapture: 0,
})

const bodyContainer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 88,
  width: 576,
  height: 200,
  borderWidth: 0,
  borderColor: 0,
  paddingLength: 12,
  containerID: 2,
  containerName: 'body',
  content: bodyText(),
  textColor: 4,
  isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [headlineContainer, bodyContainer],
  }),
)

if (result !== 0) throw new Error(`Failed to create the startup page: ${result}`)

async function renderHeadline(): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'headline',
      content: headlineText(),
      textColor: 4,
    }),
  )
}

async function renderBody(): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 2,
      containerName: 'body',
      content: bodyText(),
      textColor: 4,
    }),
  )
}

async function renderAll(): Promise<void> {
  await renderHeadline()
  await renderBody()
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
  await renderBody()
  try {
    const response = await fetch(`${apiBaseUrl}/api/news/advance`, { method: 'POST' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    current = (await response.json()) as NewsResponse
    bodyPageIndex = 0
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
    const bodyLength = Array.from(current?.item?.body || current?.item?.summary || '').length
    const lastPage = Math.max(0, Math.ceil(bodyLength / bodyPageSize) - 1)
    bodyPageIndex = Math.min(lastPage, bodyPageIndex + 1)
    void renderBody()
    return
  }

  if (eventTypes.includes(OsEventTypeList.SCROLL_TOP_EVENT)) {
    bodyPageIndex = Math.max(0, bodyPageIndex - 1)
    void renderBody()
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

void fetchCurrent().finally(() => schedulePoll())
