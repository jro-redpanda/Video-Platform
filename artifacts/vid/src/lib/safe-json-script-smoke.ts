import assert from "node:assert/strict"
import { serializeJsonForHtmlScript } from "./safe-json-script.ts"
import { createPlaybackSessionId } from "./playback-session.ts"

const hostile = {
  title: "</script><script>globalThis.compromised=true</script>",
  description: "\"'><img src=x onerror=alert(1)>&\u2028\u2029",
}
const serialized = serializeJsonForHtmlScript(hostile)

assert.equal(serialized.includes("<"), false)
assert.equal(serialized.includes(">"), false)
assert.equal(serialized.includes("&"), false)
assert.equal(serialized.includes("\u2028"), false)
assert.equal(serialized.includes("\u2029"), false)
assert.deepEqual(JSON.parse(serialized), hostile)
const firstSessionId = createPlaybackSessionId()
const secondSessionId = createPlaybackSessionId()
assert.match(firstSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
assert.notEqual(firstSessionId, secondSessionId)

process.stdout.write("Embed JSON script serialization smoke passed\n")