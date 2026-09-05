import assert from "node:assert/strict"
import {
  getHttpStatus,
  getSafeMediaUrl,
  getSafePosterUrl,
  getSafeStripeUrl,
  shouldRetryQuery,
} from "./frontend-safety.ts"

const base = "https://app.example.test/workspace/"

assert.equal(
  getSafeMediaUrl("/api/video/source", base),
  "https://app.example.test/api/video/source",
)
assert.equal(
  getSafeMediaUrl("https://cdn.example.test/video.mp4", base),
  "https://cdn.example.test/video.mp4",
)
assert.equal(
  getSafeMediaUrl("http://app.example.test/video.mp4", "http://app.example.test/"),
  "http://app.example.test/video.mp4",
)
assert.equal(getSafeMediaUrl("http://cdn.example.test/video.mp4", base), null)
assert.equal(getSafeMediaUrl("javascript:alert(1)", base), null)
assert.equal(getSafeMediaUrl("data:text/html,unsafe", base), null)
assert.equal(getSafeMediaUrl("https://user:secret@cdn.example.test/video.mp4", base), null)

assert.equal(
  getSafePosterUrl("data:image/png;base64,AAAA", base),
  "data:image/png;base64,AAAA",
)
assert.equal(getSafePosterUrl("data:text/html,unsafe", base), null)

assert.equal(
  getSafeStripeUrl("https://checkout.stripe.com/c/pay/cs_test"),
  "https://checkout.stripe.com/c/pay/cs_test",
)
assert.equal(getSafeStripeUrl("https://stripe.com.evil.test/checkout"), null)
assert.equal(getSafeStripeUrl("http://checkout.stripe.com/checkout"), null)
assert.equal(getSafeStripeUrl("https://user:secret@stripe.com/checkout"), null)

assert.equal(getHttpStatus({ status: 403 }), 403)
assert.equal(getHttpStatus({ status: "403" }), undefined)
assert.equal(shouldRetryQuery(0, { status: 401 }), false)
assert.equal(shouldRetryQuery(0, { status: 403 }), false)
assert.equal(shouldRetryQuery(0, { status: 404 }), false)
assert.equal(shouldRetryQuery(0, { status: 500 }), true)
assert.equal(shouldRetryQuery(2, { status: 500 }), false)

console.log("Frontend safety smoke passed.")