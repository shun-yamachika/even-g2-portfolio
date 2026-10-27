const IMAGE_WIDTH = 288
const IMAGE_HEIGHT = 144
const PADDING = 10
const MAX_FONT_SIZE = 52
const MIN_FONT_SIZE = 20
const FONT_FAMILY = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif'

type TextLayout = {
  fontSize: number
  lineHeight: number
  lines: string[]
}

function wrapByCharacter(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('')
      continue
    }

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
    lines.push(line)
  }

  return lines
}

function clipWithEllipsis(
  context: CanvasRenderingContext2D,
  lines: string[],
  maxLines: number,
  maxWidth: number,
): string[] {
  if (lines.length <= maxLines) return lines

  const clipped = lines.slice(0, maxLines)
  let lastLine = clipped[maxLines - 1] ?? ''
  while (lastLine && context.measureText(`${lastLine}…`).width > maxWidth) {
    lastLine = Array.from(lastLine).slice(0, -1).join('')
  }
  clipped[maxLines - 1] = `${lastLine}…`
  return clipped
}

function findLargestLayout(context: CanvasRenderingContext2D, text: string): TextLayout {
  const maxWidth = IMAGE_WIDTH - PADDING * 2
  const maxHeight = IMAGE_HEIGHT - PADDING * 2

  for (let fontSize = MAX_FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize -= 2) {
    context.font = `700 ${fontSize}px ${FONT_FAMILY}`
    const lineHeight = Math.ceil(fontSize * 1.16)
    const lines = wrapByCharacter(context, text, maxWidth)
    if (lines.length * lineHeight <= maxHeight) return { fontSize, lineHeight, lines }
  }

  context.font = `700 ${MIN_FONT_SIZE}px ${FONT_FAMILY}`
  const lineHeight = Math.ceil(MIN_FONT_SIZE * 1.16)
  const lines = wrapByCharacter(context, text, maxWidth)
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight))
  return {
    fontSize: MIN_FONT_SIZE,
    lineHeight,
    lines: clipWithEllipsis(context, lines, maxLines, maxWidth),
  }
}

// TextContainerはフォントサイズを変更できないため、Canvas上で文字をPNGにする。
// SDKがPNGをG2用の4-bitグレースケールへ変換して転送する。
export async function renderJapanesePng(text: string): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_WIDTH
  canvas.height = IMAGE_HEIGHT

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2Dを利用できません')

  context.fillStyle = '#000000'
  context.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT)

  const layout = findLargestLayout(context, text)
  context.font = `700 ${layout.fontSize}px ${FONT_FAMILY}`
  context.fillStyle = '#ffffff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  const blockHeight = layout.lines.length * layout.lineHeight
  const firstLineY = (IMAGE_HEIGHT - blockHeight) / 2 + layout.lineHeight / 2
  layout.lines.forEach((line, index) => {
    context.fillText(line, IMAGE_WIDTH / 2, firstLineY + index * layout.lineHeight)
  })

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => {
      if (value) resolve(value)
      else reject(new Error('PNGを生成できません'))
    }, 'image/png')
  })

  return new Uint8Array(await blob.arrayBuffer())
}

export const japaneseImageSize = {
  width: IMAGE_WIDTH,
  height: IMAGE_HEIGHT,
}
