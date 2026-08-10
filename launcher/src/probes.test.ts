import assert from "node:assert/strict"
import test from "node:test"

import {
  buildProbeExpression,
  classifyCompatibility,
  type CapabilityProbe,
} from "./probes.js"

function probe(
  id: string,
  ok: boolean,
  requiredFor: CapabilityProbe["requiredFor"],
): CapabilityProbe {
  return { id, ok, detail: id, requiredFor }
}

test("base failure enters safe mode", () => {
  const probes = [probe("renderer", false, "base"), probe("mode", true, "subtractive")]
  assert.equal(classifyCompatibility(probes), "safe-mode")
})

test("subtractive failure keeps additive mode", () => {
  const probes = [
    probe("renderer", true, "base"),
    probe("sidebar", true, "additive"),
    probe("mode", false, "subtractive"),
  ]
  assert.equal(classifyCompatibility(probes), "additive")
})

test("all capabilities enable Weft mode", () => {
  const probes = [
    probe("renderer", true, "base"),
    probe("sidebar", true, "additive"),
    probe("mode", true, "subtractive"),
  ]
  assert.equal(classifyCompatibility(probes), "weft-mode")
})

test("renderer probe requires an interactive visible main route", () => {
  const expression = buildProbeExpression()
  assert.match(expression, /visibleMainRoute\(\)/)
  assert.match(expression, /closest\('\[inert\], \[aria-hidden="true"\], \[hidden\]'\)/)
  assert.match(expression, /style\.visibility === "hidden"/)
  assert.match(expression, /style\.pointerEvents === "none"/)
  assert.match(expression, /id === "renderer\.main" \? Boolean\(mainRoute\)/)
})
