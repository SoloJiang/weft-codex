import assert from "node:assert/strict"
import test from "node:test"

import { codexLaunchArgs, reserveLoopbackPort } from "./processes.js"

test("Codex launch arguments isolate the profile and bind CDP to loopback", () => {
  assert.deepEqual(codexLaunchArgs("/tmp/weft profile", 9412), [
    "--user-data-dir=/tmp/weft profile",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9412",
  ])
})

test("Codex launch arguments reject an invalid port", () => {
  assert.throws(() => codexLaunchArgs("/tmp/profile", 0), /port is invalid/)
  assert.throws(() => codexLaunchArgs("/tmp/profile", 70000), /port is invalid/)
})

test("reserves a usable loopback port", async () => {
  const port = await reserveLoopbackPort()
  assert.ok(port > 0 && port < 65536)
})
