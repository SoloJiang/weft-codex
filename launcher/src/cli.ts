#!/usr/bin/env node

import type { ChildProcess } from "node:child_process"

import { inspectCodexInstall } from "./codex-install.js"
import { CdpSession, listCdpTargets, selectRendererTarget } from "./cdp.js"
import { pickRepositoryDirectories } from "./native-dialogs.js"
import { readHostPreferences, writeHostPreferences } from "./preferences.js"
import {
  defaultProfileDir,
  ensureWeftd,
  reserveLoopbackPort,
  spawnCodex,
  stopProcess,
  waitForHttp,
  type SpawnedProcess,
} from "./processes.js"
import { probeRenderer } from "./probes.js"
import { RendererSupervisor, type RendererHostEvent, type RendererReadySnapshot } from "./renderer-host.js"
import type { HostMode } from "./renderer-agent.js"

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function positivePort(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return parsed
}

function selectedMode(value: string | undefined): HostMode | null {
  if (!value) return null
  if (value === "work" || value === "codex" || value === "weft") return value
  throw new Error(`Invalid mode: ${value}`)
}

async function inspectInstall(): Promise<void> {
  const install = await inspectCodexInstall(option("app-path"))
  process.stdout.write(`${JSON.stringify(install, null, 2)}\n`)
}

async function probe(): Promise<void> {
  const endpoint = option("endpoint") ?? "http://127.0.0.1:9222"
  const install = await inspectCodexInstall(option("app-path"))
  const targets = await listCdpTargets(endpoint)
  const target = selectRendererTarget(targets, option("target-url"))
  if (!target.webSocketDebuggerUrl) throw new Error("Selected renderer has no debugger URL")
  const session = await CdpSession.connect(target.webSocketDebuggerUrl)
  try {
    const report = await probeRenderer(session)
    process.stdout.write(`${JSON.stringify({ install, target: publicTarget(target), ...report }, null, 2)}\n`)
  } finally {
    session.close()
  }
}

function publicTarget(target: { id: string; title: string; url: string }) {
  return { id: target.id, title: target.title, url: target.url }
}

function eventLogger(event: RendererHostEvent): void {
  if (event.type === "mode.changed" || event.type === "thread.open.missing") {
    process.stderr.write(`[weft-codex-host] ${event.type} ${JSON.stringify(event)}\n`)
  }
}

function readyLogger(snapshot: RendererReadySnapshot): void {
  if (snapshot.safeMode) {
    process.stderr.write(`[weft-codex-host] safe mode: ${snapshot.reason ?? "unknown compatibility failure"}\n`)
    return
  }
  process.stderr.write(
    `[weft-codex-host] renderer ready: tier=${snapshot.probe.tier} mode=${snapshot.status?.mode ?? "unknown"} cspBypass=${snapshot.status?.cspBypass ?? false}\n`,
  )
}

async function runHost(endpoint: string, ownedCodex: SpawnedProcess | null): Promise<void> {
  const weftdUrl = option("weftd-url") ?? "http://127.0.0.1:47810"
  const webBaseUrl = option("web-url") ?? `${weftdUrl.replace(/\/$/, "")}/`
  const preferencesPath = option("preferences")
  const preferences = await readHostPreferences(preferencesPath)
  const initialMode = selectedMode(option("mode")) ?? preferences.mode
  let preferenceWrite = Promise.resolve()

  const supervisor = new RendererSupervisor({
    endpoint,
    targetUrl: option("target-url") ?? "app://-/index.html",
    webBaseUrl,
    initialMode,
    onEvent(event) {
      eventLogger(event)
      if (event.type !== "mode.changed" || !event.mode) return
      preferenceWrite = preferenceWrite
        .then(() => writeHostPreferences({ version: 1, mode: event.mode as HostMode }, preferencesPath))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[weft-codex-host] preference write failed: ${message}\n`)
        })
    },
    onReady: readyLogger,
    onWarning(message) {
      process.stderr.write(`[weft-codex-host] ${message}\n`)
    },
    pickRepositories: pickRepositoryDirectories,
  })

  const snapshot = await supervisor.start()
  process.stdout.write(`${JSON.stringify({ endpoint, webBaseUrl, ...snapshot }, null, 2)}\n`)
  if (flag("once")) {
    await supervisor.stop()
    return
  }

  try {
    await waitForShutdown(ownedCodex?.child)
  } finally {
    await supervisor.stop()
    await preferenceWrite
  }
}

async function attach(): Promise<void> {
  const endpoint = option("endpoint") ?? "http://127.0.0.1:9222"
  const daemon = await ensureWeftd({
    url: option("weftd-url"),
    executablePath: option("weftd-path"),
    webDir: option("web-dir"),
    homeDir: option("weft-home"),
  })
  try {
    await waitForHttp(new URL("/json/version", endpoint).href)
    await runHost(endpoint, null)
  } finally {
    await stopProcess(daemon)
  }
}

async function start(): Promise<void> {
  const install = await inspectCodexInstall(option("app-path"))
  const daemon = await ensureWeftd({
    url: option("weftd-url"),
    executablePath: option("weftd-path"),
    webDir: option("web-dir"),
    homeDir: option("weft-home"),
  })
  let codex: SpawnedProcess | null = null
  try {
    const debugPort = positivePort(option("debug-port")) ?? await reserveLoopbackPort()
    codex = await spawnCodex(install, option("profile-dir") ?? defaultProfileDir(), debugPort)
    const endpoint = `http://127.0.0.1:${debugPort}`
    await waitForHttp(new URL("/json/version", endpoint).href, 30_000)
    await runHost(endpoint, codex)
  } finally {
    await stopProcess(codex)
    await stopProcess(daemon)
  }
}

function waitForShutdown(child?: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      process.off("SIGINT", done)
      process.off("SIGTERM", done)
      child?.off("exit", done)
      resolve()
    }
    process.once("SIGINT", done)
    process.once("SIGTERM", done)
    child?.once("exit", done)
  })
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "inspect-install"
  if (command === "inspect-install") {
    await inspectInstall()
    return
  }
  if (command === "probe") {
    await probe()
    return
  }
  if (command === "attach") {
    await attach()
    return
  }
  if (command === "start") {
    await start()
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`weft-codex-host: ${message}\n`)
  process.exitCode = 1
})
