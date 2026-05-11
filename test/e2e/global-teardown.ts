import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getServers } from './global-setup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default async function globalTeardown() {
  const { apiServer, harnessServer } = getServers()
  if (apiServer && apiServer.pid) {
    try {
      // Detached child — kill the whole process group to take down npx tsx + node.
      process.kill(-apiServer.pid, 'SIGTERM')
    } catch {
      // Already dead.
    }
    await new Promise((r) => setTimeout(r, 500))
    try {
      process.kill(-apiServer.pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
  if (harnessServer) {
    await new Promise<void>((r) => harnessServer.close(() => r()))
  }
  try {
    fs.unlinkSync(path.join(__dirname, '.e2e-env.json'))
  } catch {
    // ignore
  }
}
