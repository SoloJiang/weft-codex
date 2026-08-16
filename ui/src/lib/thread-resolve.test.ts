import assert from "node:assert/strict"
import test from "node:test"

import { sidebarFooter, threadLinkStatus } from "./thread-resolve.ts"

test("a workspace view does not talk about linking", () => {
  assert.equal(threadLinkStatus("workspace", false), "idle")
  assert.equal(threadLinkStatus("workspace", true), "idle")
})

test("a bound thread is silent", () => {
  assert.equal(threadLinkStatus("bound-thread", false), "idle")
})

test("an unknown thread is linking until resolve gives up", () => {
  assert.equal(threadLinkStatus("unbound-thread", false), "linking")
  assert.equal(threadLinkStatus("unbound-thread", true), "unbound")
})

test("an open failure outranks a linking status", () => {
  assert.deepEqual(sidebarFooter("thr_1", "linking"), { kind: "retry", threadId: "thr_1" })
})

test("the footer is silent when nothing is pending", () => {
  assert.deepEqual(sidebarFooter(null, "idle"), { kind: "none" })
})
