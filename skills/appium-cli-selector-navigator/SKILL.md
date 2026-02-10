---
name: appium-cli-selector-navigator
description: Navigate apps via appium-recorder CLI with minimal round-trips. Prefer deterministic paths (direct URL navigation) before selector discovery.
---

# Appium CLI Selector Navigator

Use this skill to perform Appium-based mobile automation from the terminal with the fewest possible LLM-to-CLI calls.

## Setup

1. **Appium server** must be running and reachable (default: `http://127.0.0.1:4723`).
2. **appium-recorder** must be installed.
3. **jq** must be available for JSON parsing.
4. Prepare a capabilities file (e.g., `caps.json`):

**iOS Safari:**
```json
{
  "platformName": "iOS",
  "appium:automationName": "XCUITest",
  "appium:deviceName": "iPhone 16",
  "appium:browserName": "Safari"
}
```

**iOS native app:**
```json
{
  "platformName": "iOS",
  "appium:automationName": "XCUITest",
  "appium:deviceName": "iPhone 16",
  "appium:bundleId": "com.apple.mobilesafari"
}
```

**Android Chrome:**
```json
{
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "emulator-5554",
  "appium:browserName": "Chrome"
}
```

**Android native app:**
```json
{
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "emulator-5554",
  "appium:appPackage": "com.example.app",
  "appium:appActivity": ".MainActivity"
}
```

Capabilities can also be passed inline with `--caps-json '{"platformName":"iOS", ...}'`.

## Execution Rules

1. Write command output to files with `--output /tmp/<step>.json`.
2. Never print raw XML source or base64 screenshots to stdout — always parse with `jq`.
3. Skip `screen elements` and `selectors best` when you can guess selectors from the task context.
4. Retry each failed action at most twice.
5. Always delete the session when finished, whether the task succeeded or failed.
6. **Chain commands in a single bash call** using `&&` to reduce round-trips.

## Session Lifecycle

```bash
APPIUM_URL="http://127.0.0.1:4723"
```

**Create session and capture ID (one bash call):**

```bash
appium-recorder session create \
  --appium-url "$APPIUM_URL" \
  --caps-file ./caps.json \
  --output /tmp/session.json \
&& SESSION_ID="$(jq -r '.result.sessionId' /tmp/session.json)"
```

**Delete session:**

```bash
appium-recorder session delete \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --output /tmp/session.delete.json
```

## Workflow Selection

Choose the simplest path that fits:

| Request type | Path |
|---|---|
| Native app with guessable labels | Direct Action Path |
| Open or navigate to a website | URL Fast Path |
| Unknown UI, no obvious selectors | Selector Discovery Path |

---

## Direct Action Path (Preferred, 3 Bash Calls)

Use when you can infer selectors from the task description. Most native app elements use `accessibility id` matching their visible label (e.g., "Save", "Cancel", "Search", "Done", "Delete"). Chain all actions into a single bash call with `&&`:

### Bash Call 1 — Create session

See Session Lifecycle above.

### Bash Call 2 — Chain all actions

```bash
appium-recorder drive tap \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "accessibility id" \
  --value "<BUTTON_LABEL>" \
  --output /tmp/drive.1.json \
&& appium-recorder drive type \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "accessibility id" \
  --value "<FIELD_LABEL>" \
  --text "<TEXT>" \
  --clear-first \
  --output /tmp/drive.2.json \
&& appium-recorder drive tap \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "accessibility id" \
  --value "<CONFIRM_LABEL>" \
  --output /tmp/drive.3.json
```

If any step returns `ok: false`, the chain stops. Check the last output file, then fall back to the Selector Discovery Path for that step.

### Bash Call 3 — Delete session

---

## URL Fast Path (3–5 CLI Commands, 2–3 Bash Calls)

Use for browser navigation. Do not run discovery commands if this path succeeds.

### Bash Call 1 — Create session

See Session Lifecycle above.

### Bash Call 2 — Type URL and verify

Try these address-field selectors in order until one succeeds:

| Priority | Strategy | Value | Platform |
|---|---|---|---|
| 1 | `id` | `URL` | iOS Safari |
| 2 | `accessibility id` | `Address` | iOS Safari |
| 3 | `accessibility id` | `TabBarItemTitle` | iOS Safari |
| 4 | `id` | `com.android.chrome:id/url_bar` | Android Chrome |
| 5 | `accessibility id` | `Search or type web address` | Android Chrome |

Append `\n` to the text to submit the URL automatically:

```bash
appium-recorder drive type \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "id" \
  --value "URL" \
  --text "https://example.com\n" \
  --clear-first \
  --output /tmp/drive.type.json
```

If `ok: false`, retry with the next selector from the table. If the URL field remains active after typing, tap the Go button:

```bash
appium-recorder drive tap \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "accessibility id" \
  --value "Go" \
  --output /tmp/drive.tap.go.json
```

To verify navigation, take a snapshot and check for the expected domain:

```bash
appium-recorder screen snapshot \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --output /tmp/screen.snapshot.json \
&& jq -r '.result.source' /tmp/screen.snapshot.json | grep -c "example.com"
```

Skip verification if the `drive type` command already returned `ok: true` and the task does not require confirmation.

### Bash Call 3 — Delete session

---

## Selector Discovery Path (Fallback)

Use when the fast path does not apply or has failed.

### Step 1 — Create session

See Session Lifecycle above.

### Step 2 — Get actionable elements and inspect them (one bash call)

```bash
appium-recorder screen elements \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --only-actionable \
  --limit 80 \
  --output /tmp/screen.elements.json \
&& jq -r '.result.elements[] | [.elementRef, .type, .name, .label, .resourceId] | @tsv' \
  /tmp/screen.elements.json
```

### Step 3 — Get the best selector for the target element (one bash call)

Pick the `elementRef` that matches your target from Step 2, then:

```bash
appium-recorder selectors best \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --element-ref "<ELEMENT_REF>" \
  --output /tmp/selectors.best.json \
&& jq -r '.result.topSelectors[] | select(.matchCount == 1) | [.strategy, .value] | @tsv' \
  /tmp/selectors.best.json
```

Use the first selector where `matchCount` equals 1.

### Step 4 — Perform the action

**Tap:**

```bash
appium-recorder drive tap \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "<STRATEGY>" \
  --value "<SELECTOR>" \
  --output /tmp/drive.tap.json
```

**Type:**

```bash
appium-recorder drive type \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "<STRATEGY>" \
  --value "<SELECTOR>" \
  --text "<TEXT>" \
  --clear-first \
  --output /tmp/drive.type.json
```

**Back:**

```bash
appium-recorder drive back \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --output /tmp/drive.back.json
```

**Swipe:**

```bash
appium-recorder drive swipe \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --from 500,1800 \
  --to 500,400 \
  --duration-ms 350 \
  --output /tmp/drive.swipe.json
```

**Scroll:**

```bash
appium-recorder drive scroll \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --direction down \
  --output /tmp/drive.scroll.json
```

Directions: `up`, `down`, `left`, `right`. Optional `--duration-ms` (default 300).

### Scrolling to find elements

If an action fails with `no such element`, the target may be off-screen. Scroll down and retry:

```bash
appium-recorder drive scroll \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --direction down \
  --output /tmp/drive.scroll.json \
&& appium-recorder drive tap \
  --appium-url "$APPIUM_URL" \
  --session-id "$SESSION_ID" \
  --using "<STRATEGY>" \
  --value "<SELECTOR>" \
  --output /tmp/drive.tap.json
```

Try scrolling up to 3 times before giving up. After each scroll, retry the original action.

### Step 5 — On failure, retry once

1. Take one snapshot to refresh state.
2. Try the next selector from `selectors best`.
3. Stop after two retries and report the blocker.

### Step 6 — Delete session

---

## Error Handling

- `ok: false` means the command failed. Branch on `error.code`.
- `no such element` or `stale element reference`: take a fresh snapshot and retry with the next selector.
- Connection errors: verify Appium is reachable, then retry the command once.
- After the retry budget is exhausted, stop and report:
  1. Last successful step.
  2. Last failed command and `error.code`.
  3. Last selector attempted.
  4. Whether session cleanup succeeded.

## Call Budget

| Path | Max CLI commands | Target bash calls |
|---|---|---|
| Direct action (chained) | N actions | 3 (create, all actions, delete) |
| URL fast path | 5 (create, type, [tap Go], [verify], delete) | 3 |
| Discovery per interaction | 4 (elements, selectors, action, [verify]) | 3 |
| Max retries per task | 2 | — |
