const SECTION_WIDTH = 576
const SECTION_HEIGHT = 144
const TILE_WIDTH = 288
const TILE_HEIGHT = 144
const HORIZONTAL_PADDING = 14
const FONT_FAMILY = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif'
const BODY_FONT_SIZE = 26
const BODY_LINE_HEIGHT = 29
const BODY_LINES_PER_PAGE = 4

function createCanvas(width = SECTION_WIDTH, height = SECTION_HEIGHT): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2Dを利用できません')
  return context
}

function font(size: number): string {
  return `700 ${size}px ${FONT_FAMILY}`
}

function normalizeText(text: string): string {
  return String(text).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
}

// 日本語は単語間の空白がないため、Unicode文字単位で幅を測って折り返す。
function wrapByCharacter(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []

  for (const paragraph of normalizeText(text).split('\n')) {
    let line = ''
    for (const character of Array.from(paragraph)) {
      const candidate = line + character
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = character
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)
  }

  return lines.length > 0 ? lines : ['']
}

function paintBackground(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#000000'
  context.fillRect(0, 0, SECTION_WIDTH, SECTION_HEIGHT)
  context.fillStyle = '#ffffff'
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => {
      if (value) resolve(value)
      else reject(new Error('PNGを生成できません'))
    }, 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

// 横長の576x144画像を、G2が受け取れる288x144画像2枚へ分割する。
async function splitIntoTiles(source: HTMLCanvasElement): Promise<[Uint8Array, Uint8Array]> {
  const tiles = [0, 1].map(index => {
    const tile = createCanvas(TILE_WIDTH, TILE_HEIGHT)
    contextOf(tile).drawImage(
      source,
      index * TILE_WIDTH,
      0,
      TILE_WIDTH,
      TILE_HEIGHT,
      0,
      0,
      TILE_WIDTH,
      TILE_HEIGHT,
    )
    return canvasToPng(tile)
  })
  return Promise.all(tiles) as Promise<[Uint8Array, Uint8Array]>
}

export function paginateNewsBody(text: string): string[][] {
  const canvas = createCanvas()
  const context = contextOf(canvas)
  context.font = font(BODY_FONT_SIZE)
  const lines = wrapByCharacter(context, text, SECTION_WIDTH - HORIZONTAL_PADDING * 2)
  const pages: string[][] = []

  for (let index = 0; index < lines.length; index += BODY_LINES_PER_PAGE) {
    pages.push(lines.slice(index, index + BODY_LINES_PER_PAGE))
  }
  return pages.length > 0 ? pages : [['本文を取得できませんでした。']]
}

export async function renderHeadlineTiles(text: string): Promise<[Uint8Array, Uint8Array]> {
  const canvas = createCanvas()
  const context = contextOf(canvas)
  paintBackground(context)

  const maxWidth = SECTION_WIDTH - HORIZONTAL_PADDING * 2
  let fontSize = 40
  let lineHeight = 46
  let lines: string[] = []

  // 見出しが3行に収まるまで、40pxから少しずつ縮小する。
  for (; fontSize >= 24; fontSize -= 2) {
    context.font = font(fontSize)
    lineHeight = Math.ceil(fontSize * 1.14)
    lines = wrapByCharacter(context, text, maxWidth)
    if (lines.length <= 3 && lines.length * lineHeight <= SECTION_HEIGHT - 8) break
  }

  context.font = font(Math.max(fontSize, 24))
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  const blockHeight = lines.length * lineHeight
  const firstLineY = (SECTION_HEIGHT - blockHeight) / 2 + lineHeight / 2
  lines.forEach((line, index) => {
    context.fillText(line, HORIZONTAL_PADDING, firstLineY + index * lineHeight)
  })

  // 見出しと本文の境界を細い線で示す。
  context.fillRect(0, SECTION_HEIGHT - 2, SECTION_WIDTH, 2)
  return splitIntoTiles(canvas)
}

export async function renderBodyTiles(
  lines: string[],
  pageIndex: number,
  pageTotal: number,
): Promise<[Uint8Array, Uint8Array]> {
  const canvas = createCanvas()
  const context = contextOf(canvas)
  paintBackground(context)

  context.font = font(BODY_FONT_SIZE)
  context.textAlign = 'left'
  context.textBaseline = 'top'
  lines.forEach((line, index) => {
    context.fillText(line, HORIZONTAL_PADDING, 5 + index * BODY_LINE_HEIGHT)
  })

  // 本文を小さくせずに済むよう、ページ番号だけは控えめなサイズで右下へ置く。
  context.font = `14px ${FONT_FAMILY}`
  context.textAlign = 'right'
  context.textBaseline = 'bottom'
  context.fillText(`${pageIndex + 1}/${pageTotal}`, SECTION_WIDTH - 8, SECTION_HEIGHT - 3)

  return splitIntoTiles(canvas)
}

export const newsTileSize = {
  width: TILE_WIDTH,
  height: TILE_HEIGHT,
}
