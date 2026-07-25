# UC-3 — Re-auth: friendlier session-expired message (Design)

- Date: 2026-07-25
- Status: Approved (design)
- Feature area: side panel error handling for REST-driven flows

## Problem / Use Case

**Actor:** a user whose ServiceNow session expires mid-use (common with SSO/MFA timeouts).
**Pain:** the hardening work made `sn-rest` return a clean `{ok:false, status:401, error:'…session expired'}` on expiry, but the panel just prints that raw error inline — it doesn't tell the user what to *do*.
**Goal:** when a REST call fails due to an expired/absent session, show a clear, consistent, actionable message (open the instance, log in, retry), with an SSO hint — no button, no auto-retry (per the approved decision).

## Locked decisions

- Message only — no "Log in" button, no auto-retry.
- Include an SSO hint in the message.
- Apply only to the listed REST-driven flows (bounded), not every possible error render.
- Do not change `sn-rest`/prod-guard — they already return 401.

## Components

- **Pure helper** `src/core/auth-msg.ts` (no chrome/DOM, unit-tested):
  - `isAuthError(status: number, error?: string): boolean` — `true` when `status === 401` or `error` matches `/session expired|redirected to login|not authenticated/i`.
  - `authExpiredMessage(host: string): string` — returns, e.g.:
    `Session expired on <host>. Open the instance in your browser and sign in (if your org uses SSO, open a ServiceNow tab and complete sign-in there), then try this again.`
- **Panel helper** in `src/sidepanel/main.ts`: `showApiError(container: HTMLElement, host: string, res: { status?: number; error?: string })` — if `isAuthError(res.status ?? 0, res.error)`, render `authExpiredMessage(host)`; otherwise render `res.error` (current behavior). Renders into `container` the same way the existing error paths do (an `elText('div','error', …)`), so callers swap one call.

## Scope — call sites to convert (the listed REST-driven flows)

Replace the inline `elText('div','error', res.error)` error render with `showApiError(container, host, res)` in exactly these flows:
- F3 preview + import (`pasteXmlInner`) and F3 `saveXml` (Copy) fetch failure.
- F1 spec discovery (the walk/REST failure path).
- F2 script load (loading a Business Rule / Client Script / Script Include).
- Condition Tester (query/count failure).
- Table schema load (dictionary fetch failure).
- Layer 3 guarded create/read-back/delete failures.

Each uses the host already in scope (the pinned `host` local or `current.host`). Flows NOT in this list are left unchanged.

## Error handling / edge cases

- `isAuthError` treats a missing status (`undefined`) as non-auth (returns raw error) unless the error text matches the session-expired patterns.
- Network errors (`status:0`) are NOT auth errors — they keep their raw message.

## Testing

- **Unit (Vitest):** `isAuthError` (401 → true; matching error text → true; 403/500/0 → false; undefined status + non-matching text → false) and `authExpiredMessage` (contains the host and the SSO hint).
- **Not unit-testable:** the `main.ts` wiring (chrome/DOM) — verified via `npm run typecheck` + `npm run build` + `npm run test:smoke` (panel still boots).

## Acceptance criteria

1. A REST failure with `status:401` (or a session-expired error string) in any listed flow shows the friendly message naming the host and including an SSO hint — not the raw technical error.
2. Non-auth failures (403, 404, 500, network `status:0`) in those flows still show their existing error text.
3. `isAuthError` and `authExpiredMessage` are unit-tested.
4. Flows outside the listed set are unchanged; `sn-rest`/prod-guard untouched; CI smoke still boots the panel.
