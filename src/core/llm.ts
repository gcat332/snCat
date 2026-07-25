/**
 * LLM layer for "Java review" (handoff §7 decision 2 — pluggable provider).
 *
 * Builds the prompt and calls a configurable endpoint to return, for a given
 * ServiceNow script: an OPTIMIZED version and a TESTER script that runs against
 * the Layer 2 sandbox's mocked Glide APIs. Endpoint + key are provided later;
 * until configured, runJavaReview reports `configured:false` so the UI can
 * prompt for settings. Everything up to the network call is ready now.
 */
import type { BrTiming, ScriptKind } from './lint'

export type LlmFormat = 'anthropic' | 'openai' | 'agenthub'

export interface LlmConfig {
  endpoint: string
  apiKey: string
  model: string
  format: LlmFormat
}

export interface ReviewInput {
  script: string
  kind: ScriptKind
  timing?: BrTiming
  table: string
  intent?: string
  /** Trigger summary: BR when/actions/condition, or client-script type/field. */
  trigger?: string
  /** How the tester script should seed `current`. */
  seedMode?: 'blank' | 'record' | 'query'
  seedSysId?: string
  seedQuery?: string
}

export interface ReviewResult {
  optimizedScript: string
  testScript: string
  notes: string[]
}

const STORAGE_KEY = 'llmConfig'

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  try {
    const store = await chrome.storage.local.get(STORAGE_KEY)
    const cfg = store[STORAGE_KEY] as Partial<LlmConfig> | undefined
    if (cfg?.endpoint && cfg.apiKey) {
      return {
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        model: cfg.model || 'claude-opus-4-8',
        format: normalizeFormat(cfg.format),
      }
    }
  } catch {
    /* none */
  }
  return null
}

export async function saveLlmConfig(cfg: LlmConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg })
}

function normalizeFormat(f: unknown): LlmFormat {
  return f === 'openai' || f === 'agenthub' ? f : 'anthropic'
}

/**
 * handoff §2 decision 4 (T-104, security): customer script content leaves the
 * instance when we call the LLM. Before it does, mask obvious secrets so
 * proprietary credentials are never sent off-box. Redaction is deliberately
 * TARGETED — it only touches string literals that (a) are assigned to a
 * secret-named identifier/property, (b) are the argument of a secret-keyed
 * gs.getProperty(...) call, or (c) look like a hardcoded key (long hex/base64
 * or an sk-/pk- token). Ordinary code — GlideRecord queries, field names,
 * table names — is left byte-for-byte intact so the review stays useful.
 */
const REDACTED = '***REDACTED***'
/** Identifier/property/property-key names that imply a secret value. */
const SECRET_NAME = /password|passwd|pwd|pw|secret|token|api[_.\- ]?key|apikey|credential/i
/** A string literal that itself looks like a hardcoded key/credential. */
const KEY_LITERAL =
  /^(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}$|^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9+/]{32,}={0,2}$/

export function redactScript(script: string): string {
  if (!script) return script
  const mask = (q: string): string => `${q}${REDACTED}${q}`
  let out = script
  // (a) assignment / property to a secret-named identifier: name = "..." | name: "..."
  out = out.replace(
    /([A-Za-z_$][\w$]*)(\s*[:=]\s*)(["'])((?:\\.|(?!\3).)*)\3/g,
    (full, name: string, op: string, q: string) => (SECRET_NAME.test(name) ? `${name}${op}${mask(q)}` : full),
  )
  // (b) gs.getProperty('...secret.key...') — mask the property-key argument
  out = out.replace(
    /(getProperty\s*\(\s*)(["'])((?:\\.|(?!\2).)*)\2/g,
    (full, pre: string, q: string, content: string) => (SECRET_NAME.test(content) ? `${pre}${mask(q)}` : full),
  )
  // (c) standalone hardcoded-key-looking literals
  out = out.replace(/(["'])((?:\\.|(?!\1).)*)\1/g, (full, q: string, content: string) =>
    KEY_LITERAL.test(content) ? mask(q) : full,
  )
  return out
}

/**
 * handoff §2 decision 4 (T-104, security): the endpoint is user-configured, so
 * a typo'd or tampered value could silently exfiltrate script content anywhere.
 * Only known-good provider hosts (over https) are permitted; everything else is
 * refused before any fetch. Hosts mirror manifest.config.ts host_permissions
 * plus the two hosted-provider APIs the format adapters target.
 */
const ALLOWED_ENDPOINT_HOSTS = new Set(['api.anthropic.com', 'api.openai.com', 'dev-agenthub.mfec.co.th'])

export function isAllowedEndpoint(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && ALLOWED_ENDPOINT_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

const KIND_LABEL: Record<ScriptKind, string> = {
  business_rule: 'Business Rule',
  client_script: 'Client Script',
  script_include: 'Script Include',
  unknown: 'server-side script',
}

/** How the tester should obtain `current`, per the chosen seed mode. */
function seedInstruction(input: ReviewInput): string {
  const t = JSON.stringify(input.table)
  if (input.seedMode === 'record' && input.seedSysId) {
    return `  * Seed from the REAL record: "var current = new GlideRecord(${t}); current.get(${JSON.stringify(input.seedSysId)}); var previous = new GlideRecord(${t}); previous.get(${JSON.stringify(input.seedSysId)});" then mutate copies of field values as needed. Do NOT invent field values — read them from this record.`
  }
  if (input.seedMode === 'query' && input.seedQuery) {
    return `  * Seed from a QUERY: "var current = new GlideRecord(${t}); current.addEncodedQuery(${JSON.stringify(input.seedQuery)}); current.query(); current.next(); var previous = new GlideRecord(${t}); previous.get(current.getUniqueValue());".`
  }
  return `  * Seed with representative values: "var current = new GlideRecord(${t}); current.initialize(); current.setValue('field', 'value');" and a "previous" the same way when needed.`
}

/** System + user prompt for the review. The model must reply with strict JSON. */
export function buildReviewPrompt(input: ReviewInput): { system: string; user: string } {
  const kind = KIND_LABEL[input.kind]
  const when = input.kind === 'business_rule' && input.timing ? ` (when: ${input.timing})` : ''

  const system = [
    'You are a senior ServiceNow developer and Glide API expert.',
    'You review server-side and client scripts for correctness, performance, security, and ServiceNow best practices.',
    'You always reply with a SINGLE valid JSON object and nothing else — no prose, no markdown fences.',
  ].join(' ')

  const user = [
    `Review this ServiceNow ${kind}${when} on table "${input.table}". Be concise.`,
    input.trigger ? `Trigger: ${input.trigger}` : '',
    input.intent
      ? `Intent and requested changes (apply these): ${input.intent}`
      : 'No intent stated; infer it from the code.',
    '',
    'SCRIPT:',
    '```javascript',
    redactScript(input.script),
    '```',
    '',
    'Reply with a JSON object with these keys:',
    '- "optimizedScript": corrected/optimized version following ServiceNow best practices (fix anti-patterns: current.update() in before rules, unconditioned GlideRecord queries, GlideRecord in client scripts, etc.). Apply the requested changes; keep behavior consistent with intent + trigger. Brief comments only.',
    '- "testScript": a COMPLETE self-contained background script (server-side, Rhino/ES5) runnable as-is. gs/GlideRecord exist; current/previous do NOT — build them yourself.',
    seedInstruction(input),
    '  Wrap the logic in a function, cover up to 2 cases, print outcomes with gs.info(...). MUST NOT persist: no insert()/update()/deleteRecord() on real data; drop current.update() in the test.',
    '- "notes": up to 5 short findings.',
    '',
    'Respond with ONLY the JSON object.',
  ]
    .filter(Boolean)
    .join('\n')

  return { system, user }
}

/** Pull a JSON object out of a model reply (tolerates fences / stray prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  try {
    return JSON.parse(candidate.trim())
  } catch {
    const slice = firstBalancedObject(candidate)
    if (slice !== null) {
      return JSON.parse(slice)
    }
    throw new Error('Model did not return valid JSON.')
  }
}

/**
 * Scan from the first `{` and return the substring through its true matching
 * `}`, tracking brace depth. Braces inside string literals are ignored, and
 * `\` escapes inside strings are respected, so trailing prose (or a JSON value
 * that is itself a script full of `{`/`}`) cannot fool the end detection.
 * Returns null if no balanced object is present.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function coerceResult(raw: unknown): ReviewResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const notes = Array.isArray(o.notes) ? o.notes.map((n) => String(n)) : []
  return {
    optimizedScript: typeof o.optimizedScript === 'string' ? o.optimizedScript : '',
    testScript: typeof o.testScript === 'string' ? o.testScript : '',
    notes,
  }
}

async function callAnthropic(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(135000),
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { content?: { text?: string }[] }
  return body.content?.[0]?.text ?? ''
}

async function callOpenai(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(135000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return body.choices?.[0]?.message?.content ?? ''
}

/** One thing the AI proposes building to satisfy a requirement. */
export interface PlanArtifact {
  /** Human label, e.g. "Field", "ACL", "Script Include", "Business Rule", "Fix Script". */
  kind: string
  title: string
  /** 'create' = insert a customization record; 'background' = run a script. */
  action: 'create' | 'background'
  /** For action=create: the metadata table to insert into (e.g. sys_dictionary). */
  targetTable?: string
  /** For action=create: the record's column values. */
  fields?: Record<string, string>
  /** For action=background: the server-side script to run / open. */
  script?: string
  notes?: string
}

export interface PlanResult {
  summary: string
  artifacts: PlanArtifact[]
}

export interface PlanContext {
  table?: string
  sysId?: string
  /** Existing field names on the table, for grounding. */
  fields?: string[]
  /** The scope/application the user selected in the UI; artifacts target this. */
  scope?: string
}

/** Prompt: turn a requirement + current context into a plan of artifacts. */
export function buildPlanPrompt(requirement: string, ctx: PlanContext): { system: string; user: string } {
  const system = [
    'You are a senior ServiceNow solution engineer and platform developer.',
    'Given a requirement and the current table context, you decide the concrete ServiceNow artifacts needed and return them as a build plan.',
    'Prefer configuration/customization records (dictionary fields, ACLs, Script Includes, UI Policies, Business Rules, Client Scripts, Choices) over one-off data changes.',
    'You always reply with a SINGLE valid JSON object and nothing else.',
  ].join(' ')

  const user = [
    'Requirement:',
    redactScript(requirement),
    '',
    ctx.table ? `Current table: ${ctx.table}` : 'No specific table.',
    `Target application scope: ${ctx.scope || 'Global'}. All artifacts are created in THIS scope, which the user already selected in the UI.`,
    'SCOPE RULES (hard): Never propose creating an application or scope (no sys_scope / sys_app / sys_store_app / sys_update_set artifacts). Never set a "sys_scope" or "sys_package" field on any artifact — the platform places it in the selected scope automatically.',
    ctx.fields?.length
      ? [
          `EXISTING fields on ${ctx.table} (already on the table — treat as READ-ONLY inventory):`,
          ctx.fields.slice(0, 400).join(', '),
          '',
          'HARD RULE: Never propose a "Field" artifact whose column already exists above, in ANY form — not the exact name, not a scope-prefixed variant (u_x / x_app_x), not a re-labeled duplicate. If the requirement is already satisfiable with an existing field, REUSE it and add NO field artifact for it. Only propose a Field for a column that is genuinely absent from the list above.',
        ].join('\n')
      : '',
    '',
    'Return a JSON object with:',
    '- "summary": one sentence describing the approach.',
    '- "artifacts": an array. Each item has:',
    '   - "kind": short label (Field, ACL, Script Include, UI Policy, Business Rule, Client Script, Choice, Fix Script, Background Script, Data Change).',
    '   - "title": a concise name.',
    '   - "action": "create" for a customization record to insert, or "background" for a script to run.',
    '   - For action="create": "targetTable" (the ServiceNow metadata table to insert into, e.g. sys_dictionary for a field, sys_security_acl for an ACL, sys_script_include, sys_ui_policy, sys_script, sys_script_client, sys_choice) and "fields" (an object of that record\'s column names → values; include name/table/element/script/etc. as appropriate).',
    '   - For action="background": "script" (a complete, safe server-side background script).',
    '   - "notes": optional short caveat.',
    '',
    'Order artifacts by dependency (create fields before rules that use them). Respond with ONLY the JSON object.',
  ]
    .filter(Boolean)
    .join('\n')
  return { system, user }
}

function coercePlan(raw: unknown): PlanResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const arr = Array.isArray(o.artifacts) ? o.artifacts : []
  const artifacts: PlanArtifact[] = arr.map((a) => {
    const r = (a ?? {}) as Record<string, unknown>
    const fields: Record<string, string> = {}
    if (r.fields && typeof r.fields === 'object') {
      for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) fields[k] = String(v ?? '')
    }
    return {
      kind: String(r.kind ?? 'Artifact'),
      title: String(r.title ?? '(untitled)'),
      action: r.action === 'create' ? 'create' : 'background',
      targetTable: r.targetTable ? String(r.targetTable) : undefined,
      fields: Object.keys(fields).length ? fields : undefined,
      script: typeof r.script === 'string' ? r.script : undefined,
      notes: r.notes ? String(r.notes) : undefined,
    }
  })
  return { summary: String(o.summary ?? ''), artifacts }
}

export type PlanOutcome =
  | { configured: false }
  | { configured: true; ok: true; result: PlanResult }
  | { configured: true; ok: false; error: string }

export async function runGeneratePlan(
  requirement: string,
  ctx: PlanContext,
  config?: LlmConfig | null,
): Promise<PlanOutcome> {
  const cfg = config ?? (await loadLlmConfig())
  if (!cfg) return { configured: false }
  const { system, user } = buildPlanPrompt(requirement, ctx)
  try {
    const text = await callProvider(cfg, system, user)
    return { configured: true, ok: true, result: coercePlan(extractJson(text)) }
  } catch (err) {
    return { configured: true, ok: false, error: (err as Error).message }
  }
}

/**
 * MFEC AgentHub (browser-ingest): single `prompt`, Bearer auth, returns
 * `{ response }`. System + user are concatenated into one prompt.
 */
async function callAgentHub(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(135000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      prompt: `${system}\n\n${user}`,
      model: cfg.model || 'claude-opus-4-8',
      timeoutMs: 120000,
    }),
  })
  if (!res.ok) throw new Error(`AgentHub HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { response?: string; status?: string }
  return body.response ?? ''
}

/** Dispatch a system+user prompt to the configured provider, returning raw text. */
async function callProvider(cfg: LlmConfig, system: string, user: string): Promise<string> {
  // T-104 security gate: never send script content to an unrecognised endpoint.
  if (!isAllowedEndpoint(cfg.endpoint)) {
    throw new Error(
      `Refusing to send: endpoint "${cfg.endpoint}" is not on the allowlist (${[...ALLOWED_ENDPOINT_HOSTS].join(', ')}). Check the configured LLM endpoint.`,
    )
  }
  if (cfg.format === 'openai') return callOpenai(cfg, system, user)
  if (cfg.format === 'agenthub') return callAgentHub(cfg, system, user)
  return callAnthropic(cfg, system, user)
}

export type ReviewOutcome =
  | { configured: false }
  | { configured: true; ok: true; result: ReviewResult }
  | { configured: true; ok: false; error: string }

export async function runJavaReview(
  input: ReviewInput,
  config?: LlmConfig | null,
): Promise<ReviewOutcome> {
  const cfg = config ?? (await loadLlmConfig())
  if (!cfg) return { configured: false }

  const { system, user } = buildReviewPrompt(input)
  try {
    const text = await callProvider(cfg, system, user)
    return { configured: true, ok: true, result: coerceResult(extractJson(text)) }
  } catch (err) {
    return { configured: true, ok: false, error: (err as Error).message }
  }
}
