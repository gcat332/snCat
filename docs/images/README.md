# Screenshots for `docs/ONBOARDING.md`

Real screenshots only — no mockups. Capture on the dev instance
(`mfecplcdemo10.service-now.com`) with `dist/` loaded in Chrome, then save each
file here under the exact name below and the onboarding page picks it up.

**How to capture on macOS:** `⌘⇧4` then drag (or `⌘⇧4` + Space to grab a whole
window). The side panel is narrow — crop tight so text stays readable in the doc.

| File | What to capture |
|---|---|
| `01-install.png` | `chrome://extensions` with Developer mode on and the snJava card loaded. |
| `02-inspect.png` | Side panel, **Inspect** tab: the Page context card filled in (instance / table / sys_id / view / UI), with the tab bar visible. |
| `03-settings.png` | **Settings** tab, AI Settings section, filled in — **blur or clear the API key field before capturing.** |
| `04-javahelp.png` | A ServiceNow form with a script field, showing the blue **javaHelp** chip next to the field label. Crop to the label + chip area. |
| `05-review.png` | **Tester** tab after **Java review**: the findings list (and Optimized script if present). |
| `06-generate.png` | **Generate** tab: a generated plan with artifact rows, ideally with one artifact's detail modal open showing its fields. |
| `07-spec.png` | **Spec** tab: the discovered-artifact checklist plus the HTML / PDF / Word export buttons. |
| `08-xml.png` | **Inspect** tab after a Paste import: the "Imported 1/1" banner, a result row with **Copy sys_id / Open**, and **Open N record(s) as list**. |

## Before committing

- No real customer data, credentials, or API keys in frame.
- Prefer the current UI — these features were restyled recently (toast, XML
  result rows, artifact detail, Script kind), so older screenshots will look
  wrong.
- PNG, keep each file under ~300 KB if you can.
