import type { VocabularyCard } from './cards'

// 実機で安全に扱える200x100を1タイルの上限として使い、400x200を4分割する。
const SCREEN_WIDTH = 400
const SCREEN_HEIGHT = 200
const TILE_WIDTH = 200
const TILE_HEIGHT = 100
const PADDING = 10
const FONT_FAMILY = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", Arial, sans-serif'

function createCanvas(width = SCREEN_WIDTH, height = SCREEN_HEIGHT): HTMLCanvasElement {
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

function fitSingleLine(context: CanvasRenderingContext2D, text: string, maximum: number, minimum: number): number {
  const maxWidth = SCREEN_WIDTH - PADDING * 2
  for (let size = maximum; size >= minimum; size -= 2) {
    context.font = font(size)
    if (context.measureText(text).width <= maxWidth) return size
  }
  return minimum
}

function wrapByCharacter(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const character of Array.from(text.trim())) {
    const candidate = line + character
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line.trim())
      line = character.trimStart()
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line.trim())
  return lines.length > 0 ? lines : ['']
}

function wrapByWord(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function clipped(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines
  const result = lines.slice(0, limit)
  result[limit - 1] = `${result[limit - 1].replace(/[.。]?$/, '')}…`
  return result
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

async function splitIntoTiles(source: HTMLCanvasElement): Promise<[Uint8Array, Uint8Array, Uint8Array, Uint8Array]> {
  const tiles: Promise<Uint8Array>[] = []
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const tile = createCanvas(TILE_WIDTH, TILE_HEIGHT)
      contextOf(tile).drawImage(
        source,
        column * TILE_WIDTH,
        row * TILE_HEIGHT,
        TILE_WIDTH,
        TILE_HEIGHT,
        0,
        0,
        TILE_WIDTH,
        TILE_HEIGHT,
      )
      tiles.push(canvasToPng(tile))
    }
  }
  return Promise.all(tiles) as Promise<[Uint8Array, Uint8Array, Uint8Array, Uint8Array]>
}

export async function renderCardTiles(
  card: VocabularyCard,
  index: number,
  total: number,
): Promise<[Uint8Array, Uint8Array, Uint8Array, Uint8Array]> {
  const canvas = createCanvas()
  const context = contextOf(canvas)

  context.fillStyle = '#000000'
  context.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT)
  context.fillStyle = '#ffffff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  const wordSize = fitSingleLine(context, card.word, 52, 28)
  context.font = font(wordSize)
  context.fillText(card.word, SCREEN_WIDTH / 2, 36)

  context.fillRect(PADDING, 72, SCREEN_WIDTH - PADDING * 2, 2)

  context.font = font(26)
  const meaningLines = clipped(wrapByCharacter(context, card.meaning, SCREEN_WIDTH - PADDING * 2), 2)
  const meaningLineHeight = 29
  const meaningFirstY = 98 - ((meaningLines.length - 1) * meaningLineHeight) / 2
  meaningLines.forEach((line, lineIndex) => {
    context.fillText(line, SCREEN_WIDTH / 2, meaningFirstY + lineIndex * meaningLineHeight)
  })

  context.fillRect(PADDING, 126, SCREEN_WIDTH - PADDING * 2, 1)

  let exampleSize = 20
  let exampleLines: string[] = []
  for (; exampleSize >= 16; exampleSize -= 1) {
    context.font = font(exampleSize)
    exampleLines = wrapByWord(context, card.example, SCREEN_WIDTH - PADDING * 2)
    if (exampleLines.length <= 3) break
  }
  exampleLines = clipped(exampleLines, 3)
  const exampleLineHeight = Math.ceil(Math.max(exampleSize, 16) * 1.16)
  const exampleBlockHeight = exampleLines.length * exampleLineHeight
  const exampleFirstY = 130 + (61 - exampleBlockHeight) / 2 + exampleLineHeight / 2
  context.font = font(Math.max(exampleSize, 16))
  exampleLines.forEach((line, lineIndex) => {
    context.fillText(line, SCREEN_WIDTH / 2, exampleFirstY + lineIndex * exampleLineHeight)
  })

  context.font = `12px ${FONT_FAMILY}`
  context.textAlign = 'right'
  context.textBaseline = 'bottom'
  context.fillText(`${index + 1}/${total}`, SCREEN_WIDTH - 7, SCREEN_HEIGHT - 3)

  return splitIntoTiles(canvas)
}

export const cardTileSize = {
  width: TILE_WIDTH,
  height: TILE_HEIGHT,
}

