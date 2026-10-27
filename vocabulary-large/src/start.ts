// 比較版では画像描画モジュール自体を起動しない。
if (import.meta.env.VITE_DISPLAY_MODE === 'offline') {
  await import('./mainOffline')
} else if (import.meta.env.VITE_DISPLAY_MODE === 'text') {
  await import('./mainText')
} else {
  await import('./main')
}
export {}
