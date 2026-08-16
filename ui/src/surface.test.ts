import assert from "node:assert/strict"
import test from "node:test"

import { documentColorScheme } from "./surface.ts"

test("only the modal document stays color-scheme normal", () => {
  assert.equal(documentColorScheme("modal", "dark"), "normal")
  assert.equal(documentColorScheme("modal", "light"), "normal")
  assert.equal(documentColorScheme("workspace", "dark"), "dark")
  assert.equal(documentColorScheme("sidebar", "light"), "light")
  assert.equal(documentColorScheme("standalone", "dark"), "dark")
})
