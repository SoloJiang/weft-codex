#!/usr/bin/env node

import { inspectCodexInstall } from "./codex-install.js"
import { CdpSession, listCdpTargets, selectRendererTarget } from "./cdp.js"
import { probeRenderer } from "./probes.js"

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
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
    process.stdout.write(`${JSON.stringify({ install, target: { id: target.id, title: target.title, url: target.url }, ...report }, null, 2)}\n`)
  } finally {
    session.close()
  }
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
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`weft-codex-host: ${message}\n`)
  process.exitCode = 1
})
