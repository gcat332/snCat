# UC-3 Re-auth Message — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a REST call fails due to an expired/absent session, the listed side-panel flows show a clear, actionable, SSO-aware message instead of the raw technical error.

**Architecture:** A pure, unit-tested `src/core/auth-msg.ts` (`isAuthError`, `authExpiredMessage`) plus a small `showApiError(container, host, res)` wrapper in `src/sidepanel/main.ts` that replaces the raw `res.error` render at the listed REST error sites.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Pure logic in `src/core/*` with a colocated `*.test.ts`; no `chrome.*`/DOM in core.
- Message-only: no login button, no auto-retry.
- Message MUST name the host and include an SSO hint.
- Convert ONLY the enumerated sites (bounded); leave other error renders unchanged.
- Do not modify `sn-rest`/prod-guard.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Pure `auth-msg` core + tests

**Files:**
- Create: `src/core/auth-msg.ts`
- Create: `src/core/auth-msg.test.ts`

**Interfaces produced:**
- `isAuthError(status: number, error?: string): boolean`
- `authExpiredMessage(host: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/core/auth-msg.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isAuthError, authExpiredMessage } from './auth-msg'

describe('isAuthError', () => {
  it('is true for HTTP 401', () => {
    expect(isAuthError(401)).toBe(true)
  })
  it('is true when the error text signals an expired/absent session', () => {
    expect(isAuthError(0, 'Redirected to login — session expired.')).toBe(true)
    expect(isAuthError(500, 'Not authenticated — log in to the instance.')).toBe(true)
  })
  it('is false for non-auth failures', () => {
    expect(isAuthError(403, 'Forbidden')).toBe(false)
    expect(isAuthError(404, 'Not found')).toBe(false)
    expect(isAuthError(500, 'Internal error')).toBe(false)
    expect(isAuthError(0, 'Network error: timeout')).toBe(false)
    expect(isAuthError(0)).toBe(false)
  })
})

describe('authExpiredMessage', () => {
  it('names the host and includes an SSO hint', () => {
    const m = authExpiredMessage('dev.service-now.com')
    expect(m).toContain('dev.service-now.com')
    expect(m.toLowerCase()).toContain('sign in')
    expect(m.toUpperCase()).toContain('SSO')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/auth-msg.test.ts`
Expected: FAIL — cannot find module `./auth-msg`.

- [ ] **Step 3: Write the implementation**

Create `src/core/auth-msg.ts`:

```ts
/**
 * Session-expiry detection + a friendly, actionable message for the panel.
 * Pure (no chrome/DOM). sn-rest returns {ok:false, status:401, error:'…session
 * expired'} on expiry; this turns that into a user-facing prompt.
 */
const SESSION_EXPIRED_RE = /session expired|redirected to login|not authenticated/i

/** True when a REST result reflects an expired/absent ServiceNow session. */
export function isAuthError(status: number, error?: string): boolean {
  if (status === 401) return true
  return !!error && SESSION_EXPIRED_RE.test(error)
}

/** Actionable, SSO-aware message naming the instance host. */
export function authExpiredMessage(host: string): string {
  return (
    `Session expired on ${host}. Open the instance in your browser and sign in, ` +
    `then try this again. (If your organization uses SSO, open a ServiceNow tab ` +
    `and complete sign-in there first.)`
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/auth-msg.test.ts`
Expected: PASS. Then `npm test` — expect the prior 157 + these new tests, all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/auth-msg.ts src/core/auth-msg.test.ts
git commit -m "$(printf 'feat(auth): pure session-expiry detection + friendly message\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `showApiError` wrapper + convert the listed sites

**Files:**
- Modify: `src/sidepanel/main.ts` — add `import { isAuthError, authExpiredMessage } from '@core/auth-msg'`; add a `showApiError` helper; convert the enumerated error-render sites.

**Interfaces:**
- Consumes: Task 1's `isAuthError`, `authExpiredMessage`; existing `elText`, the various result containers.
- Produces: `showApiError(container: HTMLElement, host: string, res: { status?: number; error?: string }): void`.

- [ ] **Step 1: Add the import and the helper**

Add to the `@core/*` imports at the top of `main.ts`:
```ts
import { isAuthError, authExpiredMessage } from '@core/auth-msg'
```
Add this helper near the other small UI helpers (e.g. next to `elText` usages / after `copyText`):
```ts
/** Render a REST failure into `container`; show a friendly re-auth message on 401. */
function showApiError(container: HTMLElement, host: string, res: { status?: number; error?: string }): void {
  const msg = isAuthError(res.status ?? 0, res.error) ? authExpiredMessage(host) : (res.error ?? 'Request failed.')
  container.replaceChildren(elText('div', 'error', msg))
}
```

- [ ] **Step 2: Convert the enumerated sites**

Replace each raw error render below with a `showApiError` call. Use the host already in scope at that site (noted per line). Line numbers are approximate — match on the surrounding code.

1. `fetchRecordXml` (~465), container `xmlOut`, host `current.host`:
   - from: `xmlOut.replaceChildren(elText('div', 'error', res.error))`
   - to: `showApiError(xmlOut, current.host, res)`
2. `saveXml` list path (~485), comma-expression, host `current.host`:
   - from: `xml = res.ok ? res.data : (xmlOut.replaceChildren(elText('div', 'error', res.error)), null)`
   - to: `xml = res.ok ? res.data : (showApiError(xmlOut, current.host, res), null)`
3. `pasteXmlInner` import failure (~621), container `xmlOut`, host `host` (pinned local):
   - from: `xmlOut.append(elText('div', 'error', res.error))`
   - to: `showApiError(xmlOut, host, res)`
4. `undoLastImport` failure (~720), container `xmlOut`, host `host` (param):
   - from: `xmlOut.replaceChildren(elText('div', 'error', res.error))`
   - to: `showApiError(xmlOut, host, res)`
5. `runCondition` (~853), container `condResults`, host `current.host` (Condition Tester runs against the current instance — confirm `current` is in scope; if a local host exists, use it):
   - from: `condResults.replaceChildren(elText('div', 'error', countRes.error))`
   - to: `showApiError(condResults, current!.host, countRes)`
   (Use whatever non-null host expression the surrounding code already relies on; if the function guards `current` earlier, `current.host` without `!` is fine.)
6. `fetchDictionaryInto` (~895), container `schemaResults`, host `host` (param):
   - from: `schemaResults.replaceChildren(elText('div', 'error', res.error))`
   - to: `showApiError(schemaResults, host, res)`
7. `findScripts` (~1423, F2 script picker/load), container `pickerResults`, host `current.host`:
   - from: `pickerResults.replaceChildren(elText('div', 'error', res.error))`
   - to: `showApiError(pickerResults, current!.host, res)` (match the file's existing non-null convention)
8. `runOnInstance` (~1841, Layer 3 run), container `simResults`, host `current.host`:
   - from: `simResults.replaceChildren(elText('div', 'error', res.error))`
   - to: `showApiError(simResults, current!.host, res)` (match the file's existing non-null convention)

- [ ] **Step 3: Check the F1 spec-discovery path for a raw error render**

The spec lists "F1 spec discovery". Run:
```bash
grep -nE "elText\('div', ?'error', ?[a-zA-Z].*error|error', ?`[^`]*\\\$\\{[a-zA-Z]+\\.error" src/sidepanel/main.ts | grep -viE "465|485|621|720|853|895|1423|1841"
```
If a REST-result error render exists in the spec-generation/discovery flow (a `res.error`/`.error` render with a host in scope), convert it with `showApiError(<its container>, <its host>, <its res>)`. If none exists (the F1 walk degrades gracefully and does not render `res.error` directly), note that in your report and skip — do not invent a site.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. Fix any type error your changes introduce (e.g. a container that is `HTMLElement | null` — assert/guard as the surrounding code already does).

- [ ] **Step 5: Full suite + CI smoke**

Run: `npm test && npm run build && npm run test:smoke`
Expected: unit tests green (Task 1 included); smoke still boots the panel.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/main.ts
git commit -m "$(printf 'feat(auth): friendly session-expired message in REST-driven flows\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Friendly SSO-aware message on 401 in listed flows (AC #1) → Task 1 (`authExpiredMessage` with host + SSO hint) + Task 2 site conversions. ✓
- Non-auth failures keep raw text (AC #2) → `showApiError` falls back to `res.error`; `isAuthError` false for 403/404/500/0. ✓
- Helpers unit-tested (AC #3) → Task 1 tests. ✓
- Flows outside the set unchanged; sn-rest/prod-guard untouched; smoke boots (AC #4) → Task 2 converts only the enumerated sites; Step 5 smoke. ✓

**Placeholder scan:** No TBD/TODO. Step 3 is a guarded conditional conversion with a concrete grep, not an open placeholder.

**Type/name consistency:** `isAuthError(status, error?)`, `authExpiredMessage(host)`, `showApiError(container, host, res)` used identically across tasks. Sites 5/7/8 use the file's existing non-null host convention (`current!.host` or a guarded `current.host`) — the implementer matches whichever the surrounding code already uses.

**Note (in-scope extension):** Site 4 (`undoLastImport`) is part of the F3 import family though not named separately in the spec's flow list; converting it is consistent with "F3 preview + import" and avoids an inconsistent raw error on the sibling Undo action.
