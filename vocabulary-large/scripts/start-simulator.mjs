import { spawn } from 'node:child_process'

const HOST = '127.0.0.1'
const PORT = 5177
const APP_URL = `http://${HOST}:${PORT}`
const VITE_ENTRY = 'node_modules/vite/bin/vite.js'
const SIMULATOR_ENTRY = 'node_modules/@evenrealities/evenhub-simulator/bin/index.js'

async function serverIsReady() {
  try {
    const response = await fetch(APP_URL, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Viteの起動に失敗しました')
    if (await serverIsReady()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Viteの起動を待機中にタイムアウトしました: ${APP_URL}`)
}

let devServer = null
let simulator = null

function stopChildren(signal = 'SIGTERM') {
  if (simulator?.exitCode === null) simulator.kill(signal)
  if (devServer?.exitCode === null) devServer.kill(signal)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => stopChildren(signal))
}

try {
  if (!(await serverIsReady())) {
    console.log(`開発サーバーを起動します: ${APP_URL}`)
    devServer = spawn(
      process.execPath,
      [VITE_ENTRY, '--host', HOST, '--port', String(PORT), '--strictPort'],
      { stdio: 'inherit' },
    )
    await waitForServer(devServer)
  } else {
    console.log(`起動済みの開発サーバーを使用します: ${APP_URL}`)
  }

  simulator = spawn(
    process.execPath,
    [SIMULATOR_ENTRY, APP_URL, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )

  const exitCode = await new Promise((resolve, reject) => {
    simulator.once('error', reject)
    simulator.once('exit', code => resolve(code ?? 1))
  })
  process.exitCode = exitCode
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  stopChildren()
}

