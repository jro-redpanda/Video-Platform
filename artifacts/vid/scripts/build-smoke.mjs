import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const html = await readFile(new URL("../dist/public/index.html", import.meta.url), "utf8")
const rawBasePath = process.env.BASE_PATH ?? "/"
const basePath = rawBasePath.endsWith("/") ? rawBasePath : `${rawBasePath}/`

assert.doesNotMatch(html, /\/src\/main\.tsx/)
assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/)
assert.match(html, new RegExp(`href=[\"']${escapeRegExp(basePath)}favicon\\.svg[\"']`))
assert.match(html, new RegExp(`src=[\"']${escapeRegExp(basePath)}assets/`))

console.log(`Frontend build smoke passed for BASE_PATH=${basePath}`)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}