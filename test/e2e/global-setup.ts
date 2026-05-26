import { spawn, ChildProcess } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const API_SERVER_DIR = resolveApiServerDir()

// Ports the harness server / API server bind to. Override via env to avoid
// collisions with locally-running dev services.
const API_PORT = Number(process.env.VF_E2E_API_PORT ?? 18766)
const HARNESS_PORT = Number(process.env.VF_E2E_HARNESS_PORT ?? 14173)
const API_BASE = `http://localhost:${API_PORT}`
const HARNESS_BASE = `http://localhost:${HARNESS_PORT}`

let apiServer: ChildProcess | null = null
let harnessServer: http.Server | null = null

async function buildSdk() {
  // Ensure dist/ is fresh before serving it.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath(ROOT, 'tsup', 'dist/cli-default.js')], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tsup exited ${code}`))))
    child.on('error', reject)
  })
}

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function startHarnessServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const harnessDir = path.join(__dirname, 'harness')
    const distDir = path.join(ROOT, 'dist/umd')
    const server = http.createServer((req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0]
      let filePath: string
      if (urlPath === '/' || urlPath === '/index.html') {
        filePath = path.join(harnessDir, 'index.html')
      } else if (urlPath?.startsWith('/dist/')) {
        filePath = path.join(distDir, urlPath.replace('/dist/', ''))
      } else {
        filePath = path.join(harnessDir, urlPath ?? '')
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const ext = path.extname(filePath)
        const type =
          ext === '.html' ? 'text/html'
          : ext === '.js' ? 'application/javascript'
          : ext === '.map' ? 'application/json'
          : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type })
        res.end(data)
      })
    })
    server.listen(HARNESS_PORT, '127.0.0.1', () => {
      harnessServer = server
      resolve()
    })
    server.on('error', reject)
  })
}

async function ensureApiKey(): Promise<string> {
  // The E2E suite stamps a sandbox customer + write key directly in Postgres.
  // We use the same DB the Vouchflow server tests use. Cleans devices/verifications
  // first so leftover bad-state rows from prior failed runs don't poison the new run.
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dev:dev@localhost:5432/vouchflow_test'
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/4'

  const { PrismaClient } = await import(
    path.join(API_SERVER_DIR, 'node_modules/@prisma/client/index.js') as any
  )
  const prisma = new PrismaClient()
  // Flush the test Redis DB so per-email/per-IP fallback rate-limit counters
  // from prior runs don't accumulate and fail subsequent runs at 429.
  const Redis = (await import(
    path.join(API_SERVER_DIR, 'node_modules/ioredis/built/index.js') as any
  )).default
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  redis.on('error', () => {
    // Redis is only flushed to avoid stale rate-limit counters. The API
    // health check below is the authoritative readiness gate.
  })
  try {
    await redis.connect()
    await redis.flushdb()
  } catch {
    // best-effort
  } finally {
    redis.disconnect()
  }
  try {
    // signing_keys is encrypted with VOUCHFLOW_SIGNING_KEY_ENCRYPTION_KEY which
    // we randomise per run — so leftover rows decrypt-fail. Always start fresh.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "verifications", "devices", "api_keys", "apps", "customers", "signing_keys" RESTART IDENTITY CASCADE',
    )
    const crypto = await import('node:crypto')
    const id = `cust_e2e_${crypto.randomBytes(4).toString('hex')}`
    const key = `vsk_sandbox_${crypto.randomBytes(16).toString('hex')}`
    const readKey = `vsk_sandbox_read_${crypto.randomBytes(16).toString('hex')}`
    await prisma.customer.create({
      data: {
        id,
        email: `${id}@test.local`,
        apps: {
          create: {
            name: 'E2E Harness',
            slug: 'e2e-harness',
            sandboxWriteKey: key,
            sandboxReadKey: readKey,
            webSdkEnabled: true,
            webRpId: 'localhost',
            webAllowedOrigins: [HARNESS_BASE],
            signPayloadMinConfidence: 'high',
          },
        },
      },
    })
    process.env.VF_E2E_API_KEY = key
    process.env.VF_E2E_CUSTOMER_ID = id
    return key
  } finally {
    await prisma.$disconnect()
  }
}

function startApiServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    apiServer = spawn(process.execPath, [binPath(API_SERVER_DIR, 'tsx', 'dist/cli.mjs'), 'src/index.ts'], {
      cwd: API_SERVER_DIR,
      env: {
        ...process.env,
        API_PORT: String(API_PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://dev:dev@localhost:5432/vouchflow_test',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/4',
        INTERNAL_HMAC_SECRET: '0'.repeat(64),
        WEBHOOK_SECRET_ENCRYPTION_KEY: '0'.repeat(64),
        VOUCHFLOW_SIGNING_KEY_ENCRYPTION_KEY: process.env.VOUCHFLOW_SIGNING_KEY_ENCRYPTION_KEY ?? '0'.repeat(64),
        SESSION_SECRET: '0'.repeat(64),
        ADMIN_KEY: '0'.repeat(64),
        NODE_ENV: 'test',
      },
      // Detach so the API server doesn't inherit the bash pipe — otherwise
      // `npx playwright test | tail` hangs after playwright exits because
      // the API child still holds the write end. Stdout/stderr go to a log
      // file so debugging is still possible.
      stdio: ['ignore', fs.openSync(path.join(__dirname, '.api.log'), 'w'), fs.openSync(path.join(__dirname, '.api.log'), 'a')],
      detached: true,
    })
    apiServer.unref()
    apiServer.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`API server exited with ${code} signal=${signal}`))
      }
    })
    // poll
    waitForUrl(`${API_BASE}/health`)
      .then(() => resolve())
      .catch(reject)
  })
}

function resolveApiServerDir(): string {
  const candidates = [
    path.join(ROOT, '..', 'api-server/api'),
    path.join(ROOT, '..', 'server/api'),
  ]
  const serverDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')))
  if (!serverDir) {
    throw new Error(`Could not find Vouchflow API server. Checked: ${candidates.join(', ')}`)
  }
  return serverDir
}

function binPath(packageRoot: string, packageName: string, relativeBinPath: string): string {
  const resolved = path.join(packageRoot, 'node_modules', packageName, relativeBinPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Missing ${packageName} dependency at ${resolved}. Run npm install in ${packageRoot} before e2e tests.`,
    )
  }
  return resolved
}

export default async function globalSetup() {
  const apiKey = await ensureApiKey()
  await buildSdk()
  await startHarnessServer()
  await startApiServer()
  process.env.VF_E2E_API_BASE = API_BASE
  process.env.VF_E2E_HARNESS_BASE = HARNESS_BASE
  process.env.VF_E2E_API_KEY = apiKey

  // expose for tests via filesystem so workers can pick it up
  fs.writeFileSync(
    path.join(__dirname, '.e2e-env.json'),
    JSON.stringify({
      apiBase: API_BASE,
      harnessBase: HARNESS_BASE,
      apiKey,
      customerId: process.env.VF_E2E_CUSTOMER_ID,
    }),
  )
}

export function getServers() {
  return { apiServer, harnessServer }
}
