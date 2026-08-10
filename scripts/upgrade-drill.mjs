#!/usr/bin/env node
// Codex upgrade regression drill (N0-05).
//
// Renames a semantic anchor on a live Codex renderer and asserts the
// compatibility tier degrades the way spec §7.5 promises, then reverts. This
// covers what the unit fixtures cannot: that the anchors we classify actually
// exist in the shipping DOM, and that losing one fails open instead of hiding
// the host UI.
//
// It drives the shipped probe pipeline (buildProbeExpression +
// reportFromSnapshot), so a classification change is picked up automatically.
//
// Usage — against a dedicated, non-injecting instance:
//   node launcher/dist/cli.js start --safe-mode --debug-port=9227 \
//     --profile-dir=/tmp/weft-codex-drill
//   node scripts/upgrade-drill.mjs 9227
//
// Never point this at your everyday Codex: it mutates DOM attributes. It
// reverts every rename, and re-asserts the baseline tier at the end to prove
// the revert worked, but a crash mid-run would leave the renderer altered.
// Reloading the window restores it.

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { buildProbeExpression, reportFromSnapshot } = await import(
  join(HERE, "..", "launcher", "dist", "probes.js")
)

const PORT = process.argv[2] || "9227"

/** Each case renames one anchor and states the tier it must produce. */
const CASES = [
  {
    name: "subtractive anchor renamed",
    attribute: "data-app-action-sidebar-thread-id",
    expect: "additive",
    why: "losing a subtractive anchor must fail open to Tier 1, not hide native UI",
  },
  {
    name: "base anchor renamed",
    attribute: "data-app-action-sidebar-scroll",
    expect: "safe-mode",
    why: "losing a base anchor must stop injection entirely",
  },
]

let nextId = 1
function send(ws, method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener("message", onMessage)
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    }
    ws.addEventListener("message", onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result.result?.value
}

const renameExpression = (from, to) => `(() => {
  const nodes = [...document.querySelectorAll('[' + ${JSON.stringify(from)} + ']')];
  for (const node of nodes) {
    node.setAttribute(${JSON.stringify(to)}, node.getAttribute(${JSON.stringify(from)}) || "");
    node.removeAttribute(${JSON.stringify(from)});
  }
  return nodes.length;
})()`

async function currentTier(ws) {
  const report = reportFromSnapshot(await evaluate(ws, buildProbeExpression()))
  return {
    tier: report.tier,
    failed: report.probes.filter((probe) => !probe.ok).map((probe) => `${probe.id}(${probe.requiredFor})`),
  }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = targets.find((entry) => entry.type === "page" && entry.url === "app://-/index.html")
  if (!target) throw new Error(`no renderer target on port ${PORT}; is the instance running?`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => { ws.onopen = resolve })
  await send(ws, "Runtime.enable")

  const failures = []
  try {
    const baseline = await currentTier(ws)
    console.log(`baseline: ${baseline.tier}`)
    if (baseline.tier !== "weft-mode") {
      failures.push(`baseline tier is ${baseline.tier}, expected weft-mode — fix that before trusting the drill`)
    }

    for (const drill of CASES) {
      const shadow = `${drill.attribute}-drill`
      const moved = await evaluate(ws, renameExpression(drill.attribute, shadow))
      try {
        const degraded = await currentTier(ws)
        const ok = degraded.tier === drill.expect
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${drill.name}: renamed ${moved} node(s) -> tier=${degraded.tier}` +
          ` (expected ${drill.expect})  failed=[${degraded.failed.join(", ")}]`,
        )
        if (!ok) failures.push(`${drill.name}: got ${degraded.tier}, expected ${drill.expect} — ${drill.why}`)
      } finally {
        await evaluate(ws, renameExpression(shadow, drill.attribute))
      }
    }

    const restored = await currentTier(ws)
    console.log(`restored: ${restored.tier}`)
    if (restored.tier !== baseline.tier) {
      failures.push(`revert failed: tier is ${restored.tier}, baseline was ${baseline.tier}`)
    }
  } finally {
    ws.close()
  }

  if (failures.length) {
    console.error("\ndrill failed:")
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log("\ndrill passed")
}

main().catch((error) => {
  console.error(String(error))
  process.exit(1)
})
