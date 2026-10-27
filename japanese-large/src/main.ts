import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { messages } from './messages'
import { japaneseImageSize, renderJapanesePng } from './renderJapanese'

const SCREEN_WIDTH = 576
const SCREEN_HEIGHT = 288
const EVENT_LAYER_ID = 1
const STATUS_CONTAINER_ID = 2
const IMAGE_CONTAINER_ID = 3

const bridge = await waitForEvenAppBridge()

// 画像コンテナはイベントを受け取れないため、透明なテキストコンテナを全面に置く。
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

// 転送失敗や現在位置は、小さなネイティブ文字で画面下に表示する。
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
  content: '日本語画像を準備しています…',
  textColor: 4,
  isEventCapture: 0,
})

// G2が1枚で扱える最大画像を画面中央へ配置する。
const image = new ImageContainerProperty({
  xPosition: (SCREEN_WIDTH - japaneseImageSize.width) / 2,
  yPosition: (SCREEN_HEIGHT - japaneseImageSize.height) / 2 - 10,
  width: japaneseImageSize.width,
  height: japaneseImageSize.height,
  containerID: IMAGE_CONTAINER_ID,
  containerName: 'large-japanese',
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [eventLayer, statusLine],
    imageObject: [image],
  }),
)

if (created !== 0) throw new Error(`ページを作成できませんでした: ${created}`)

async function setStatus(content: string): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: STATUS_CONTAINER_ID,
      containerName: 'status',
      content,
      textColor: 4,
    }),
  )
}

let currentIndex = 0
let stopped = false

// BLE画像転送を同時実行すると失敗しやすいため、Promiseの列にして必ず直列化する。
let renderQueue: Promise<void> = Promise.resolve()

function showMessage(index: number): Promise<void> {
  const operation = async () => {
    if (stopped) return
    currentIndex = ((index % messages.length) + messages.length) % messages.length
    await setStatus('転送中…')

    const png = await renderJapanesePng(messages[currentIndex])
    const result = await bridge.updateImageRawData(
      new ImageRawDataUpdate({
        containerID: IMAGE_CONTAINER_ID,
        containerName: 'large-japanese',
        imageData: png,
      }),
    )

    if (result !== 'success') throw new Error(`画像転送に失敗しました: ${result}`)
    await setStatus(`${currentIndex + 1}/${messages.length}  クリックで次へ`)
  }

  renderQueue = renderQueue.then(operation, operation).catch(async error => {
    console.error(error)
    await setStatus(error instanceof Error ? error.message : String(error))
  })
  return renderQueue
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  // CLICK_EVENTは値が0なので、protobufでフィールドが省略された場合を補う。
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  const systemType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (systemType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    stopped = true
    void bridge.shutDownPageContainer(1)
    return
  }

  if (systemType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    void showMessage(currentIndex + 1)
    return
  }

  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) void showMessage(currentIndex - 1)
})

// スマホ上には操作説明だけを置き、実際の大きな文字はグラスへ送る。
const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  app.innerHTML = `
    <main style="max-width:640px;margin:40px auto;padding:24px;font-family:sans-serif;text-align:center">
      <h1>Japanese Large</h1>
      <p>メガネをクリックすると次へ、上下スクロールで前後移動、ダブルクリックで終了します。</p>
    </main>
  `
}

void showMessage(0)
