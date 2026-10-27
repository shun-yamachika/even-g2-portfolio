import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { cards } from './cards'

// english-flowとの比較用。教材は内蔵し、通信・Canvas・画像転送は行わない。
const configuredInterval = Number(import.meta.env.VITE_CARD_INTERVAL_MS ?? 10_000)
const interval = Number.isFinite(configuredInterval) ? Math.max(5_000, configuredInterval) : 10_000
if (!cards.length) throw new Error('単語カードが登録されていません')
const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  app.innerHTML = `<main style="padding:24px;font-family:sans-serif">
    <h1>Vocabulary Large — 文字表示の比較版</h1>
    <p>Version 0.1.9 / Text</p>
    <p>単語は内蔵しています。PC接続は不要です。</p>
    <p>標準サイズの文字で表示します。スマホをロックして継続動作を比較してください。</p>
    <p id="text-status">接続しています…</p>
  </main>`
}
function status(message: string): void {
  const node = document.querySelector('#text-status')
  if (node) node.textContent = message
}
const bridge = await waitForEvenAppBridge()
let index = 0
let stopped = false
let updating = false
let timer: number | undefined

function content(): string {
  const card = cards[index]
  return [card.word, '', card.meaning, '', card.example, '', `${index + 1}/${cards.length}`].join('\n')
}
const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 0, paddingLength: 12,
    containerID: 1, containerName: 'study-card', content: content(),
    textColor: 4, isEventCapture: 1,
  })],
}))
if (result !== 0) throw new Error(`ページを作成できませんでした: ${result}`)

function stop(): void {
  stopped = true
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
}
function schedule(): void {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  if (stopped) return
  timer = window.setTimeout(() => {
    timer = undefined
    void move(1)
  }, interval)
}
async function move(offset: number): Promise<void> {
  if (stopped || updating) return
  updating = true
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  const previous = index
  index = (index + offset + cards.length) % cards.length
  try {
    const updated = await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 1, containerName: 'study-card', content: content(), textColor: 4,
    }))
    if (!updated) throw new Error('文字の更新が拒否されました')
    status(`動作中：${index + 1}/${cards.length}`)
  } catch (error) {
    index = previous
    status(error instanceof Error ? error.message : String(error))
  } finally {
    updating = false
    schedule()
  }
}
function typeOf(event?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  return event ? event.eventType ?? OsEventTypeList.CLICK_EVENT : null
}
bridge.onEvenHubEvent(event => {
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)]
  if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
    stop()
    return
  }
  if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    // english-flowと同じ、システムの終了確認を利用する。
    void bridge.shutDownPageContainer(1)
    return
  }
  if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) void move(-1)
  else if (types.includes(OsEventTypeList.CLICK_EVENT) || types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) void move(1)
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !updating && timer === undefined) schedule()
})
status(`動作中：1/${cards.length}`)
schedule()
