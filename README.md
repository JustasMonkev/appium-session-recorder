# Appium Session Recorder

A modern, interactive CLI tool that records Appium sessions with real-time UI visualization and element inspection. Built with Bun, Solid.js, and Kobalte.

![Workflow Demo](workflow.gif)

## ✨ Features

- 🎬 **Session Recording**: Intercepts and logs Appium commands (currently focused on `POST /session/:sessionId/*`)
- 📸 **Screenshot Capture**: Automatically captures screenshots after actions
- 🔍 **Element Inspector**: Interactive element inspection with multiple locator strategies
- 🎯 **Query Tester**: Test locators in real-time on captured screenshots
- 📊 **Real-time Updates**: Live dashboard with Server-Sent Events
- 🎨 **Modern UI**: Beautiful dark theme with vibrant accents using Solid.js + Kobalte
- ⚡ **Fast**: Built with Bun for optimal performance
- 🛠️ **Interactive CLI**: Beautiful prompts for easy configuration

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime installed
- [Appium](https://appium.io/) server installed

### Start Appium Server

Start the Appium server (CORS is only needed if you plan to call Appium directly from a browser):

```bash
appium --port 4723 --allow-cors
```

The recorder proxy itself does not require `--allow-cors` for normal usage.

### Installation

```bash
cd appium-session-recorder # (or your cloned folder name)
bun install
```

### Run the CLI

```bash
bun run cli
```

The CLI will interactively prompt you for:
- **Proxy port** (default: 4724)
- **Proxy host** (default: 127.0.0.1)
- **Appium server URL** (default: http://127.0.0.1:4723)

Alternatively, use command-line arguments:

```bash
bun run cli --port 8080 --appium-url http://192.168.1.100:4723
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

### CLI Options

```bash
bun run cli [options]

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

bun run cli
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
