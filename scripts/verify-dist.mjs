// Verify the production build produced a loadable MV3 extension.
// Reads dist/manifest.json and confirms every referenced artifact exists and
// the manifest keeps its MV3 shape. Emitted filenames are hashed by @crxjs, so
// we resolve them from the manifest rather than hardcoding names.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const fail = (msg) => {
  console.error(`verify-dist: FAIL — ${msg}`)
  process.exit(1)
}
const need = (rel, label) => {
  if (!rel || !existsSync(join(DIST, rel))) fail(`missing ${label}: dist/${rel ?? '(unset)'}`)
}

const manifestPath = join(DIST, 'manifest.json')
if (!existsSync(manifestPath)) fail('dist/manifest.json not found — did `npm run build` run?')

let m
try {
  m = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  fail(`manifest.json is not valid JSON: ${e.message}`)
}

// MV3 shape
if (m.manifest_version !== 3) fail(`manifest_version must be 3 (got ${m.manifest_version})`)
for (const key of ['side_panel', 'background', 'content_scripts', 'action', 'icons']) {
  if (!m[key]) fail(`manifest missing MV3 key: ${key}`)
}
if (!m.background.service_worker) fail('manifest missing background.service_worker')
if (!Array.isArray(m.content_scripts) || m.content_scripts.length === 0) {
  fail('manifest content_scripts must be a non-empty array')
}

// Referenced artifacts exist on disk
need(m.side_panel.default_path, 'side panel html')
need(m.background.service_worker, 'background service worker')
let csCount = 0
for (const cs of m.content_scripts) {
  for (const js of cs.js ?? []) {
    need(js, 'content script js')
    csCount++
  }
}
if (csCount < 2) fail(`expected >=2 content scripts (isolated + MAIN world), found ${csCount}`)
for (const [size, path] of Object.entries(m.icons ?? {})) need(path, `icon ${size}`)

console.log('verify-dist: OK — all required MV3 artifacts present')
