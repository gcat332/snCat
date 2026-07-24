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

const KIND_LABEL: Record<ScriptKind, string> = {
  business_rule: 'Business Rule',
  client_script: 'Client Script',
  script_include: 'Script Include',
  unknown: 'server-side script',
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
    `Review this ServiceNow ${kind}${when} on table "${input.table}".`,
    input.intent ? `Stated intent: ${input.intent}` : 'No intent was stated; infer it from the code.',
    '',
    'SCRIPT:',
    '```javascript',
    input.script,
    '```',
    '',
    'Return a JSON object with exactly these string/array keys:',
    '- "optimizedScript": a corrected, optimized version of the script following ServiceNow best practices (fix anti-patterns like current.update() in before rules, unconditioned GlideRecord queries, GlideRecord in client scripts, etc.). Keep it functionally equivalent to the intent.',
    '- "testScript": a self-contained script that exercises the logic in a sandbox where these globals are pre-defined as mocks: current, previous, gs, GlideRecord, GlideRecordSecure, g_form, g_user. Seed current via current.setValue(field, value), run the logic, and use gs.info(...) to log observable outcomes. Do NOT define these globals yourself.',
    '- "notes": an array of short strings, each one finding or suggestion.',
    '',
    'Respond with ONLY the JSON object.',
  ].join('\n')

  return { system, user }
}

/** Pull a JSON object out of a model reply (tolerates fences / stray prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  try {
    return JSON.parse(candidate.trim())
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1))
    }
    throw new Error('Model did not return valid JSON.')
  }
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

export interface GenerateResult {
  script: string
  notes: string[]
}

/** Prompt to generate a server-side background script from a plain requirement. */
export function buildGeneratePrompt(requirement: string, table?: string): { system: string; user: string } {
  const system = [
    'You are a senior ServiceNow developer.',
    'You write correct, safe server-side background scripts (run in Scripts - Background) using the Glide API (GlideRecord, gs, GlideAggregate, GlideDateTime).',
    'Follow best practices: filter GlideRecord queries, guard against large updates, use gs.info() to report progress, avoid hardcoded sys_ids.',
    'You always reply with a SINGLE valid JSON object and nothing else.',
  ].join(' ')
  const user = [
    'Write a ServiceNow background script for this requirement:',
    requirement,
    table ? `Primary table (if relevant): ${table}` : '',
    '',
    'Return a JSON object with exactly these keys:',
    '- "script": the complete background script (server-side, Rhino/ES5-safe).',
    '- "notes": an array of short strings — assumptions, safety warnings, and what to verify before running in production.',
    '',
    'Respond with ONLY the JSON object.',
  ]
    .filter(Boolean)
    .join('\n')
  return { system, user }
}

function coerceGenerate(raw: unknown): GenerateResult {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    script: typeof o.script === 'string' ? o.script : '',
    notes: Array.isArray(o.notes) ? o.notes.map((n) => String(n)) : [],
  }
}

export type GenerateOutcome =
  | { configured: false }
  | { configured: true; ok: true; result: GenerateResult }
  | { configured: true; ok: false; error: string }

export async function runGenerateScript(
  requirement: string,
  table?: string,
  config?: LlmConfig | null,
): Promise<GenerateOutcome> {
  const cfg = config ?? (await loadLlmConfig())
  if (!cfg) return { configured: false }
  const { system, user } = buildGeneratePrompt(requirement, table)
  try {
    const text = await callProvider(cfg, system, user)
    return { configured: true, ok: true, result: coerceGenerate(extractJson(text)) }
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
