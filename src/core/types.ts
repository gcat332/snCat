/** Which ServiceNow UI shell the page is rendered in. */
export type UiKind = 'classic' | 'polaris' | 'workspace' | 'unknown'

/** What the user is looking at. */
export type ViewKind = 'form' | 'list' | 'home' | 'unknown'

/**
 * The identity of the record/table the user is currently on.
 * DOM is only used for identity (handoff §2 decision 1) — actual record data is
 * fetched via REST elsewhere. This object is that identity.
 */
export interface PageContext {
  /** Instance hostname, e.g. "mfecplcdemo10.service-now.com". */
  host: string
  /** Table name, e.g. "incident", "sys_script". Null if not determinable. */
  table: string | null
  /** sys_id of the record on a form view. Null on list/home views. */
  sysId: string | null
  /** Form / list / home. */
  view: ViewKind
  /** Which UI shell parsed this. */
  ui: UiKind
  /** The URL this was parsed from. */
  url: string
  /** How the identity was resolved — useful for debugging/telemetry. */
  source: 'url' | 'g_form'
}

/** Message from the MAIN-world bridge → isolated content script. */
export interface GFormSnapshot {
  kind: 'sncat:g_form'
  table: string | null
  sysId: string | null
  /** X-UserToken (g_ck) for authenticated REST endpoints, if present. */
  gCk: string | null
}

/** Messages exchanged between content script / side panel / background. */
export type RuntimeMessage =
  | { kind: 'sncat:get-context' }
  | { kind: 'sncat:context'; context: PageContext | null }
