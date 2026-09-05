import assert from "node:assert/strict"
import {
  ApiError,
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
} from "../src/custom-fetch.ts"

const originalFetch = globalThis.fetch
const calls = []

try {
  setBaseUrl("https://api.example.test/")
  setAuthTokenGetter(() => "test-token")

  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const result = await customFetch("/api/check", {
    responseType: "json",
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.input, "https://api.example.test/api/check")
  const headers = new Headers(calls[0]?.init?.headers)
  assert.equal(headers.get("accept"), "application/json, application/problem+json")
  assert.equal(headers.get("authorization"), "Bearer test-token")

  setAuthTokenGetter(null)
  await assert.rejects(
    customFetch("/api/check", { method: "GET", body: "{}" }),
    /GET requests cannot have a body/,
  )

  globalThis.fetch = async () => new Response(
    JSON.stringify({ title: "Forbidden", detail: "Access denied" }),
    {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/problem+json" },
    },
  )

  await assert.rejects(
    customFetch("/api/denied", { responseType: "json" }),
    (error) => (
      error instanceof ApiError
      && error.status === 403
      && error.message.includes("Access denied")
    ),
  )

  console.log("Custom fetch smoke passed.")
} finally {
  setAuthTokenGetter(null)
  setBaseUrl(null)
  globalThis.fetch = originalFetch
}