import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { CodexInstall } from "./codex-install.js"

const DEFAULT_WEFTD_URL = "http://127.0.0.1:47810"

export interface SpawnedProcess {
  child: ChildProcess
  owned: boolean
  label: string
}

export interface WeftdOptions {
  url?: string | undefined
  executablePath?: string | undefined
  webDir?: string | undefined
  homeDir?: string | undefined
}

export function defaultProfileDir(): string {
  return path.join(homedir(), ".weft-codex", "desktop-profile")
}

export function defaultWeftdPath(): string {
  return fileURLToPath(new URL("../../target/debug/weftd", import.meta.url))
}

export function defaultWebDir(): string {
  return fileURLToPath(new URL("../../crates/daemon/web", import.meta.url))
}

export function codexLaunchArgs(profileDir: string, debugPort: number): string[] {
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new Error("CDP port is invalid")
  }
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
  ]
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not allocate a loopback port"))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

function loopbackHttpUrl(value: string): URL {
  const url = new URL(value)
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
  if (url.protocol !== "http:" || !loopback || !url.port) {
    throw new Error("weftd URL must be loopback HTTP with an explicit port")
  }
  return url
}

export async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = "endpoint unavailable"
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`)
}

export async function spawnCodex(
  install: CodexInstall,
  profileDir: string,
  debugPort: number,
): Promise<SpawnedProcess> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const child = spawn(install.executablePath, codexLaunchArgs(profileDir, debugPort), {
    stdio: "ignore",
    windowsHide: true,
  })
  await waitForSpawn(child, "Codex Desktop")
  return { child, owned: true, label: "Codex Desktop" }
}

export async function ensureWeftd(options: WeftdOptions = {}): Promise<SpawnedProcess | null> {
  const url = loopbackHttpUrl(options.url ?? DEFAULT_WEFTD_URL)
  try {
    await waitForHttp(new URL("/healthz", url).href, 800)
    return null
  } catch {
    // Start an owned daemon below.
  }

  const executablePath = options.executablePath ?? defaultWeftdPath()
  const webDir = options.webDir ?? defaultWebDir()
  await Promise.all([access(executablePath), access(path.join(webDir, "index.html"))])
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEFTD_ADDR: `${url.hostname}:${url.port}`,
    WEFT_WEB_DIR: webDir,
  }
  if (options.homeDir) env.WEFT_CODEX_HOME = options.homeDir
  const child = spawn(executablePath, [], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trimEnd()
    if (text) process.stderr.write(`${text}\n`)
  })
  await waitForSpawn(child, "weftd")
  try {
    await waitForHttp(new URL("/healthz", url).href)
  } catch (error) {
    await stopProcess({ child, owned: true, label: "weftd" })
    throw error
  }
  return { child, owned: true, label: "weftd" }
}

export async function stopProcess(processInfo: SpawnedProcess | null): Promise<void> {
  if (!processInfo?.owned || processInfo.child.exitCode !== null) return
  const child = processInfo.child
  child.kill("SIGTERM")
  const exited = await waitForExit(child, 5000)
  if (exited || child.exitCode !== null) return
  child.kill("SIGKILL")
  await waitForExit(child, 2000)
}

function waitForSpawn(child: ChildProcess, label: string): Promise<void> {
  if (child.pid) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(new Error(`${label} failed to start: ${error.message}`))
    }
    const cleanup = () => {
      child.off("spawn", onSpawn)
      child.off("error", onError)
    }
    child.once("spawn", onSpawn)
    child.once("error", onError)
  })
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}
