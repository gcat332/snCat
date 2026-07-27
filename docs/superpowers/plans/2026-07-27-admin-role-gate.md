# Admin Role Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every snJava feature runs only when the logged-in user holds the `admin` role; when the role cannot be determined, features stay usable behind a warning banner.

**Architecture:** The MAIN-world bridge already reads `g_form` and `g_ck`; it gains a `g_user` snapshot. That flows through the existing content-script message into `PageContext`. A pure core module maps the snapshot to a verdict, and one `applyGate()` in the side panel sets a `data-gate` attribute on `<body>` — panel-level CSS and a single button sweep key off that, so no per-feature enforcement code is scattered around.

**Tech Stack:** TypeScript, Vitest, Chrome MV3 content scripts.

## Global Constraints

- New pure logic goes in `src/core/` with a colocated `*.test.ts`; no `chrome.*` in core.
- Every core file starts with a block comment explaining the module's role.
- **This gate is UX, not security.** The instance's own ACLs are the real authority and reject anything the user is not entitled to with or without it. Its value is failing fast with a clear message instead of a wall of 403s. Say so in the code comments — a future reader must not mistake it for an access control.
- `not-admin` → block everything. `unknown` → allow, with a persistent amber banner. Failing open on `unknown` is deliberate: a detection gap must not brick the extension.
- `g_user.hasRole()` reflects the **effective** user, so impersonating a non-admin correctly blocks. Do not bypass this.
- Land this last, after the other four features, so it wraps finished surfaces.
- Commands: `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Core module — the gate verdict

**Files:**
- Create: `src/core/admin-gate.ts`
- Test: `src/core/admin-gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RoleState = 'admin' | 'not-admin' | 'unknown'`, `RoleStatus { state, userName?, roles? }`,
  `GateVerdict { allowed, banner, message }`, `evaluateGate(status: RoleStatus): GateVerdict`,
  `roleStatusFrom(snapshot: { hasAdmin: boolean | null; userName?: string | null; roles?: string | null }): RoleStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/admin-gate.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateGate, roleStatusFrom } from './admin-gate'

describe('evaluateGate', () => {
  it('allows an admin with no banner', () => {
    expect(evaluateGate({ state: 'admin', userName: 'admin' })).toEqual({
      allowed: true,
      banner: 'none',
      message: '',
    })
  })

  it('blocks a non-admin', () => {
    const v = evaluateGate({ state: 'not-admin', userName: 'j.somchai', roles: ['itil'] })
    expect(v.allowed).toBe(false)
    expect(v.banner).toBe('blocked')
    expect(v.message).toContain('admin role')
  })

  it('names the user and roles in the blocked message', () => {
    const v = evaluateGate({ state: 'not-admin', userName: 'j.somchai', roles: ['itil', 'catalog_admin'] })
    expect(v.message).toContain('j.somchai')
    expect(v.message).toContain('itil, catalog_admin')
  })

  it('says so when a blocked user has no roles at all', () => {
    const v = evaluateGate({ state: 'not-admin', userName: 'guest', roles: [] })
    expect(v.message).toContain('none')
  })

  it('fails OPEN on unknown, with a warning banner', () => {
    const v = evaluateGate({ state: 'unknown' })
    expect(v.allowed).toBe(true)
    expect(v.banner).toBe('unverified')
    expect(v.message).toContain('ACLs')
  })
})

describe('roleStatusFrom', () => {
  it('maps hasAdmin true to admin', () => {
    expect(roleStatusFrom({ hasAdmin: true, userName: 'admin' }).state).toBe('admin')
  })

  it('maps hasAdmin false to not-admin', () => {
    expect(roleStatusFrom({ hasAdmin: false, userName: 'x' }).state).toBe('not-admin')
  })

  it('maps a null hasAdmin to unknown — g_user was unavailable', () => {
    expect(roleStatusFrom({ hasAdmin: null }).state).toBe('unknown')
  })

  it('splits the comma-separated role string', () => {
    expect(roleStatusFrom({ hasAdmin: false, roles: 'itil, catalog_admin ,,' }).roles).toEqual([
      'itil',
      'catalog_admin',
    ])
  })

  it('tolerates a missing role string', () => {
    expect(roleStatusFrom({ hasAdmin: false }).roles).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/admin-gate.test.ts`
Expected: FAIL — `Failed to resolve import "./admin-gate"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/admin-gate.ts
/**
 * Admin-role gate for the side panel.
 *
 * IMPORTANT: this is UX, not security. The instance's own ACLs are the real
 * authority and will reject anything the user is not entitled to whether or not
 * this check runs. The gate exists so a non-admin gets one clear message instead
 * of a wall of 403s. Never treat it as an access control, and never move a
 * genuine permission decision behind it.
 *
 * The verdict is deliberately asymmetric. A confirmed non-admin is blocked; a
 * user whose roles we could not READ is allowed through behind a warning,
 * because a detection gap (Next Experience, a frame we cannot inject into) must
 * not brick the extension for someone who is in fact an admin.
 */

export type RoleState = 'admin' | 'not-admin' | 'unknown'

export interface RoleStatus {
  state: RoleState
  userName?: string
  roles?: string[]
}

export interface GateVerdict {
  allowed: boolean
  banner: 'none' | 'blocked' | 'unverified'
  /** Text for the banner; empty when there is no banner. */
  message: string
}

export function evaluateGate(status: RoleStatus): GateVerdict {
  if (status.state === 'admin') {
    return { allowed: true, banner: 'none', message: '' }
  }
  if (status.state === 'not-admin') {
    const roles = status.roles?.length ? status.roles.join(', ') : 'none'
    return {
      allowed: false,
      banner: 'blocked',
      message:
        `snJava requires the admin role on this instance.\n` +
        `Signed in as: ${status.userName || 'unknown'}\n` +
        `Roles detected: ${roles}\n` +
        `All features are disabled.`,
    }
  }
  return {
    allowed: true,
    banner: 'unverified',
    message:
      'Role unverified — snJava could not read your roles on this page. ' +
      'Features are enabled; the instance will still enforce its own ACLs.',
  }
}

/**
 * Normalize a raw g_user reading. `hasAdmin: null` means g_user was absent or
 * threw — not that the user lacks the role.
 */
export function roleStatusFrom(snapshot: {
  hasAdmin: boolean | null
  userName?: string | null
  roles?: string | null
}): RoleStatus {
  const roles = (snapshot.roles ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  if (snapshot.hasAdmin === null || snapshot.hasAdmin === undefined) {
    return { state: 'unknown', userName: snapshot.userName ?? undefined, roles }
  }
  return {
    state: snapshot.hasAdmin ? 'admin' : 'not-admin',
    userName: snapshot.userName ?? undefined,
    roles,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/admin-gate.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/admin-gate.ts src/core/admin-gate.test.ts
git commit -m "feat(admin-gate): map a g_user reading to a gate verdict"
```

---

### Task 2: Read `g_user` in the MAIN world

**Files:**
- Modify: `src/core/types.ts` (`GFormSnapshot`, `PageContext`)
- Modify: `src/content/mainworld.ts` (`declare global`, `snapshot()`, `mainworld.ts:17-44`)

**Interfaces:**
- Consumes: nothing.
- Produces: `UserSnapshot { hasAdmin: boolean | null; userName: string | null; roles: string | null }`;
  `GFormSnapshot.user: UserSnapshot`; `PageContext.user?: UserSnapshot`.

- [ ] **Step 1: Add the shared type**

In `src/core/types.ts`, before `GFormSnapshot`, add:

```ts
/**
 * The effective user's role reading, taken from the page's g_user. `hasAdmin`
 * is null when g_user was unavailable — which is NOT the same as "not an admin"
 * (see admin-gate.ts). Reflects impersonation, because g_user does.
 */
export interface UserSnapshot {
  hasAdmin: boolean | null
  userName: string | null
  /** Comma-separated role list as g_user reports it, or null. */
  roles: string | null
}
```

Add to `GFormSnapshot`:

```ts
  /** Effective user's roles, for the admin gate. */
  user: UserSnapshot
```

Add to `PageContext`, after `source`:

```ts
  /** Role reading from the page, when one was available. */
  user?: UserSnapshot
```

- [ ] **Step 2: Read g_user in the bridge**

In `src/content/mainworld.ts`, extend the `declare global` block's `Window`
interface with:

```ts
    g_user?: {
      hasRole?: (role: string) => boolean
      userName?: string
      roles?: string
    }
```

Add the import:

```ts
import type { GFormSnapshot, UserSnapshot } from '@core/types'
```

(replace the existing `GFormSnapshot`-only import).

Add above `snapshot()`:

```ts
/**
 * Read the effective user's admin status. g_user.hasRole reflects IMPERSONATION,
 * so impersonating a non-admin correctly reports false — that is wanted, not a
 * bug. A missing or throwing g_user yields hasAdmin: null ("could not tell"),
 * which the gate treats as allow-with-warning rather than deny.
 */
function userSnapshot(): UserSnapshot {
  const gu = window.g_user
  if (!gu || typeof gu.hasRole !== 'function') {
    return { hasAdmin: null, userName: gu?.userName ?? null, roles: gu?.roles ?? null }
  }
  try {
    return {
      hasAdmin: !!gu.hasRole('admin'),
      userName: gu.userName ?? null,
      roles: gu.roles ?? null,
    }
  } catch {
    return { hasAdmin: null, userName: gu.userName ?? null, roles: gu.roles ?? null }
  }
}
```

and add `user: userSnapshot(),` to the object `snapshot()` returns.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails only where `GFormSnapshot` objects are constructed without `user`
(the content script, fixed in Task 3, and any test helper). Fix test helpers by
adding `user: { hasAdmin: null, userName: null, roles: null }`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/content/mainworld.ts
git commit -m "feat(admin-gate): snapshot g_user roles in the MAIN-world bridge"
```

---

### Task 3: Carry the reading into PageContext

**Files:**
- Modify: `src/content/index.ts` (`resolveContext`, `content/index.ts:61-83`)

**Interfaces:**
- Consumes: `UserSnapshot`, `GFormSnapshot.user` (Task 2).
- Produces: `PageContext.user` populated on both resolution paths.

- [ ] **Step 1: Attach the user snapshot to both branches**

In `src/content/index.ts`, replace `resolveContext()` with:

```ts
function resolveContext(): PageContext | null {
  const fromUrl = parseServiceNowContext(location.href)
  // The role reading comes from the MAIN world regardless of which source
  // identified the record, so attach it to whichever context we return.
  const user = lastGForm?.user

  // If the URL already identified a record, trust it (it's the most specific).
  if (fromUrl && fromUrl.table && (fromUrl.sysId || fromUrl.view !== 'form')) {
    return { ...fromUrl, user }
  }

  // Otherwise, let g_form fill in the identity if it has one.
  if (lastGForm?.table) {
    return {
      host: location.host,
      table: lastGForm.table,
      sysId: lastGForm.sysId,
      view: lastGForm.sysId ? 'form' : 'unknown',
      ui: fromUrl?.ui ?? 'unknown',
      url: location.href,
      source: 'g_form',
      user,
    }
  }

  return fromUrl ? { ...fromUrl, user } : null
}
```

- [ ] **Step 2: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 3: Commit**

```bash
git add src/content/index.ts
git commit -m "feat(admin-gate): carry the g_user reading into PageContext"
```

---

### Task 4: Side panel — enforce the gate

**Files:**
- Modify: `src/sidepanel/index.html` (banner element, directly inside `.app-main`)
- Modify: `src/sidepanel/styles.css`
- Modify: `src/sidepanel/main.ts` (`detect()`, `main.ts:3064`)

**Interfaces:**
- Consumes: `evaluateGate`, `roleStatusFrom` (Task 1); `PageContext.user` (Task 3).
- Produces: `applyGate()`; `document.body.dataset.gate` set to `'blocked'`, `'unverified'` or removed.

`main.ts` has no unit-test harness; verification is `npm run typecheck`,
`npm run build` and the manual smoke steps.

- [ ] **Step 1: Add the banner to the markup**

In `src/sidepanel/index.html`, as the first child of `<main class="app-main">`,
before the Inspect panel:

```html
      <div class="gate-banner" id="gate-banner" hidden>
        <p class="gate-title" id="gate-title"></p>
        <pre class="gate-detail" id="gate-detail"></pre>
      </div>
```

- [ ] **Step 2: Add the styles**

In `src/sidepanel/styles.css`:

```css
.gate-banner {
  margin: 8px;
  padding: 10px 12px;
  border-radius: 4px;
  font-size: 12px;
}
.gate-detail {
  margin: 6px 0 0;
  white-space: pre-wrap;
  font-family: inherit;
}
.gate-title {
  margin: 0;
  font-weight: 600;
}

body[data-gate='blocked'] .gate-banner {
  background: #fdecea;
  border-left: 3px solid #c0392b;
  color: #7d241a;
}
body[data-gate='unverified'] .gate-banner {
  background: #fff6e5;
  border-left: 3px solid #e0a300;
  color: #8a5a00;
}

/* A blocked user sees the banner and nothing else. */
body[data-gate='blocked'] .panel,
body[data-gate='blocked'] .tabs,
body[data-gate='blocked'] .scopebar {
  display: none;
}
```

- [ ] **Step 3: Implement applyGate**

In `src/sidepanel/main.ts`, add the import:

```ts
import { evaluateGate, roleStatusFrom } from '@core/admin-gate'
```

and the handles next to the other top-level element lookups:

```ts
const gateBanner = el('gate-banner')
const gateTitle = el('gate-title')
const gateDetail = el('gate-detail')
```

Then add:

```ts
/**
 * Apply the admin gate to the whole panel. UX only — the instance's ACLs remain
 * the real authority (see admin-gate.ts). Sets a single data attribute so panel
 * visibility is CSS's job, not a per-feature check sprinkled through this file.
 */
function applyGate() {
  const status = current?.user
    ? roleStatusFrom(current.user)
    : { state: 'unknown' as const }
  const verdict = evaluateGate(status)

  if (verdict.banner === 'none') {
    delete document.body.dataset.gate
    gateBanner.hidden = true
    gateTitle.textContent = ''
    gateDetail.textContent = ''
    return
  }

  document.body.dataset.gate = verdict.banner
  gateBanner.hidden = false
  const [first, ...rest] = verdict.message.split('\n')
  gateTitle.textContent = verdict.banner === 'blocked' ? `⚠ ${first}` : `⚠ ${verdict.message}`
  gateDetail.textContent = verdict.banner === 'blocked' ? rest.join('\n') : ''
}
```

- [ ] **Step 4: Call it wherever context changes**

In `detect()` (`main.ts:3064`), add `applyGate()` immediately after `current` is
assigned its final value, and also in the early-return path where no ServiceNow
page is present — replace:

```ts
  if (!tab?.id || !isServiceNow(tab.url)) {
    renderStatus('Open a ServiceNow page to detect context.')
    return
  }
```

with:

```ts
  if (!tab?.id || !isServiceNow(tab.url)) {
    renderStatus('Open a ServiceNow page to detect context.')
    applyGate()
    return
  }
```

Add `applyGate()` as the last statement of `updateEnabledState()` (`main.ts:854`)
so every context refresh re-evaluates it.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 6: Manual smoke — admin**

1. Reload the unpacked extension from `dist/`.
2. Open a classic form page (e.g. `incident.do`) as an admin.
3. Expected: no banner, all four tabs usable, `document.body.dataset.gate` is
   undefined in the side panel console.

- [ ] **Step 7: Manual smoke — non-admin via impersonation**

1. Impersonate a user with `itil` but not `admin`.
2. Refresh the side panel.
3. Expected: the red banner reads `⚠ snJava requires the admin role on this
   instance.` with the impersonated username and role list; tabs, panels and the
   scope bar are hidden.
4. End impersonation, press Refresh — the panel comes back fully.

- [ ] **Step 8: Manual smoke — unknown**

1. Open a Next Experience / workspace page where `g_user` is not on `window`.
2. Expected: the amber banner reads `Role unverified — …`, and **features still
   work**. Run a condition count to confirm the panel is not blocked.

- [ ] **Step 9: Commit**

```bash
git add src/sidepanel/index.html src/sidepanel/styles.css src/sidepanel/main.ts
git commit -m "feat(admin-gate): block non-admins, warn when roles are unreadable"
```

---

### Task 5: Document the requirement

**Files:**
- Modify: `README.md` (a new subsection under `## Configure (first run)`)

- [ ] **Step 1: Add the entry**

```markdown
### Requires the `admin` role

snJava checks the effective user's roles via `g_user.hasRole('admin')` and
disables every feature for a confirmed non-admin, showing one clear message
instead of a wall of 403s. Impersonation is honoured — impersonating a non-admin
blocks the panel.

When the roles cannot be read (a Next Experience page where `g_user` is absent,
say), snJava **fails open**: features stay enabled behind an amber
"Role unverified" banner. That is deliberate — a detection gap must not brick the
extension, and the check is a UX convenience, not an access control. The
instance's own ACLs are the real authority either way.
```

- [ ] **Step 2: Verify the whole suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the admin-role requirement and fail-open behaviour"
```

---

## Smoke-test checklist (not covered by unit tests)

- [ ] Admin on classic UI: no banner, everything usable
- [ ] Non-admin (real account): blocked, correct username and roles shown
- [ ] Impersonating a non-admin: blocked; ending impersonation restores access
- [ ] Next Experience / workspace page: amber banner, features still work
- [ ] Non-ServiceNow tab: amber banner rather than a hard block
