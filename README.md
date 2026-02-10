# Appium Session Recorder

A modern Appium recorder and automation CLI with real-time UI visualization, session navigation commands, and selector ranking. Built with Bun, Solid.js, and Kobalte.

![Workflow Demo](workflow.gif)

## ✨ Features

- 🎬 **Session Recording**: Intercepts and logs Appium commands (currently focused on `POST /session/:sessionId/*`)
- 📸 **Screenshot Capture**: Automatically captures screenshots after actions
- 🤖 **JSON-First Command Mode**: Scriptable subcommands for agent workflows (`session`, `screen`, `selectors`, `drive`)
- 🧭 **CLI App Navigation**: Drive taps, typing, back navigation, and swipe gestures via Appium
- 🏆 **Best Selector Ranking**: Heuristic ranking with strategy scoring + match counts + reason codes
- 🔍 **Element Inspector**: Interactive element inspection with multiple locator strategies
- 🎯 **Query Tester**: Test locators in real-time on captured screenshots
- 📊 **Real-time Updates**: Live dashboard with Server-Sent Events
- 🎨 **Modern UI**: Beautiful dark theme with vibrant accents using Solid.js + Kobalte
- ⚡ **Fast**: Built with Bun for optimal performance
- 🛠️ **Interactive CLI**: Beautiful prompts for easy configuration

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18 or [Bun](https://bun.sh/) runtime
- [Appium](https://appium.io/) server installed

### Start Appium Server

Start the Appium server (CORS is only needed if you plan to call Appium directly from a browser):

```bash
appium --port 4723 --allow-cors
```

The recorder proxy itself does not require `--allow-cors` for normal usage.

### Installation

```bash
npm i -g appium-session-recorder
```

### Run the CLI

```bash
appium-recorder
```

The CLI will interactively prompt you for:
- **Proxy port** (default: 4724)
- **Proxy host** (default: 127.0.0.1)
- **Appium server URL** (default: http://127.0.0.1:4723)

Alternatively, use command-line arguments:

```bash
appium-recorder --port 8080 --appium-url http://192.168.1.100:4723
```

Or run command mode (JSON output by default):

```bash
appium-recorder session create --appium-url http://127.0.0.1:4723 --caps-file ./caps.json --pretty
```

### Configure Appium Inspector

Point Appium Inspector to the recorder proxy:

| Setting | Value |
|---------|-------|
| Remote Host | `127.0.0.1` |
| Remote Port | `4724` (or your configured port) |
| Remote Path | `/` |

### Access the UI

Open your browser to:
```
http://localhost:4724/_recorder
```

## 📖 Usage

## Security (Local-Only Tool)

This project is intended for **local testing and development**. It runs an unauthenticated proxy/UI that can forward commands to Appium. For normal usage, keep it bound to localhost and do not expose it to untrusted networks.

**Current known gaps (will be addressed in future updates):**
- Missing validation for `sessionId`
- Missing validation for `appiumUrl`
- Rate limiting for API endpoints
- Authentication/authorization (likely optional, since local-by-default is intentional)

**Practical guidance:**
- Run the recorder on `127.0.0.1` only (default) and avoid port-forwarding/sharing the port.
- Be cautious with `appium --allow-cors`; treat the recorder + Appium as a local dev surface while running.
- Page source is untrusted input; XML is rendered as text (not HTML) to mitigate XSS.

### Command Mode (JSON)

```bash
appium-recorder <group> <command> [flags]
```

Available command groups:

- `proxy start`
- `session create|delete`
- `screen snapshot|elements`
- `selectors best`
- `drive tap|type|back|swipe`

Global command flags:

- `--pretty` pretty-print JSON
- `--output <path>` persist JSON output to a file
- Legacy mode (`appium-recorder [legacy-options]`) does not accept `--pretty` or `--output`

### Agent Skill

This repo includes a reusable Codex skill at:

- `skills/appium-cli-selector-navigator/SKILL.md`

The skill is designed for CLI-only navigation + selector discovery loops.

### Skill Runbook (What To Run)

Use this when you want to drive the app and find selectors with `$appium-cli-selector-navigator`.

1. Start Appium:

```bash
appium --port 4723 --allow-cors
```

2. (Optional) Install skill globally for Codex:

```bash
mkdir -p ~/.claude/skills
cp -R ./skills/appium-cli-selector-navigator ~/.claude/skills/appium-cli-selector-navigator
```

Restart Claude after installing the global skill.

3. Create a capabilities file (example iOS Safari):

```bash
cat > /tmp/caps.json <<'JSON'
{
  "platformName": "iOS",
  "appium:deviceName": "iPhone 17",
  "appium:platformVersion": "26.2",
  "appium:automationName": "XCUITest",
  "appium:bundleId": "com.apple.mobilesafari",
  "appium:newCommandTimeout": 3600,
  "appium:connectHardwareKeyboard": true,
  "appium:includeSafariInWebviews": true
}
JSON
```

4. Create session and capture `SESSION_ID`:

```bash
appium-recorder session create \
  --appium-url http://127.0.0.1:4723 \
  --caps-file /tmp/caps.json \
  --output /tmp/session.json \
  --pretty \
&& SESSION_ID="$(jq -r '.result.sessionId' /tmp/session.json)" \
&& echo "$SESSION_ID"
```

5. Fetch current elements and save JSON:

```bash
appium-recorder screen elements \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" \
  --only-actionable \
  --limit 80 \
  --output /tmp/elements.json \
  --pretty \
&& jq -r '.result.elements[] | [.elementRef, .type, .name, .label, .resourceId] | @tsv' /tmp/elements.json
```

6. Pick element and get best selectors:

```bash
appium-recorder selectors best \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" \
  --element-ref "<ELEMENT_REF>" \
  --pretty
```

7. Drive actions (examples):

```bash
# Tap an element
appium-recorder drive tap \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" \
  --using "accessibility id" --value "Accept all" --pretty

# Type into a field
appium-recorder drive type \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" \
  --using "accessibility id" --value "Address" \
  --text "example.com\n" --clear-first --pretty

# Navigate back
appium-recorder drive back \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" --pretty

# Swipe gesture
appium-recorder drive swipe \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" \
  --from 900,1800 --to 900,400 --duration-ms 350 --pretty
```

8. Cleanup session:

```bash
appium-recorder session delete \
  --appium-url http://127.0.0.1:4723 \
  --session-id "$SESSION_ID" --pretty
```

### Legacy CLI Options (Backwards Compatible)

```bash
appium-recorder [options]

OPTIONS:
  -p, --port <number>        Proxy server port (default: 4724)
  -u, --appium-url <url>     Appium server URL (default: http://127.0.0.1:4723)
  --host <host>              Proxy server host (default: 127.0.0.1)
  -h, --help                 Show help message
  -v, --version              Show version
```

Configuration priority (highest to lowest):
1. Command-line arguments
2. Interactive prompts
3. Environment variables
4. Default values

### Environment Variables

```bash
APPIUM_URL=http://192.168.1.100:4723
PROXY_PORT=8080
PROXY_HOST=127.0.0.1

appium-recorder
```

## 🎨 UI Features

### Dashboard

- **Total Requests**: Count of all intercepted requests
- **Actions**: Requests with screenshots (clicks, inputs, etc.)
- **Real-time Updates**: Automatically refreshes as you interact

### Timeline

- View all interactions in chronological order
- Color-coded by HTTP method (mostly `POST`)
- **Action markers** for requests with screenshots
- Click screenshots to open inspector

### Element Inspector

- **Query Tester**: Test different locator strategies
  - accessibility id
  - xpath
  - class name
  - iOS predicate string
  - iOS class chain
- **Element Details**: View element properties (name, label, value, bounds)
- **Locators**: Auto-generated locators ready to copy
- **Click to copy**: One-click locator copying

## 🔧 Development

### Setup

```bash
git clone https://github.com/JustasMonkev/appium-session-recorder.git
cd appium-session-recorder
bun install
```

### Run from Source

```bash
bun run cli
```

This is equivalent to `appium-recorder` but runs directly from source. All examples in this README that use `appium-recorder` can be replaced with `bun run cli` during development.

### Build the UI

```bash
cd src/ui
bun run build
```

### Run in Development Mode

```bash
# Terminal 1: Build UI in watch mode
cd src/ui
bun run dev

# Terminal 2: Run CLI
bun run cli
```

### Run Tests

```bash
bun run test           # Run all tests
bun run test:watch     # Watch mode
bun run test:coverage  # With coverage
```

### Build for Production

```bash
bun run build
```

This builds both the UI and the CLI executable.

## 📦 What's Recorded

The recorder captures:
- Element clicks
- Text input (value)
- Element clear
- Find element/elements
- Touch actions
- Navigation (back, forward, refresh)

For each action:
- ✅ Request details (method, path, body)
- ✅ Screenshot (base64)
- ✅ Page source (XML)
- ✅ Timestamp

## 🎯 Use Cases

- **Test Debugging**: Review session history to debug failing tests
- **Element Discovery**: Find reliable locators for automation
- **Training**: Show team members how to interact with the app
- **Test Recording**: Generate test scripts from recorded interactions

## 🤝 Architecture

```
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│  Appium Inspector   │ ──── │  Session Recorder   │ ──── │   Appium Server     │
│  (localhost:4724)   │      │   (Bun + Express)   │      │  (localhost:4723)   │
└─────────────────────┘      └─────────────────────┘      └─────────────────────┘
                                        │
                                        ▼
                              ┌─────────────────────┐
                              │   Web UI (Solid.js) │
                              │  Real-time Updates  │
                              └─────────────────────┘
```
