# Appium Session Recorder

A modern, interactive CLI tool that records Appium sessions with real-time UI visualization and element inspection. Built with Bun, Solid.js, and Kobalte.

## ✨ Features

- 🎬 **Session Recording**: Intercepts and logs all Appium requests
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

Start the Appium server with CORS enabled:

```bash
appium --port 4723 --allow-cors
```

The `--allow-cors` flag is required for the session recorder to work correctly.

### Installation

```bash
cd appium-session-recorder
bun install
```

### Run the CLI

```bash
bun run cli
```

The CLI will interactively prompt you for:
- **Proxy port** (default: 4724)
- **Appium server URL** (default: http://127.0.0.1:4723)
- **Save configuration** option

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

### Configuration File

Create a `.appiumrc.json` file in your project directory:

```json
{
  "appiumUrl": "http://127.0.0.1:4723",
  "host": "127.0.0.1",
  "port": 4724
}
```

Configuration priority (highest to lowest):
1. Command-line arguments
2. Interactive prompts
3. `.appiumrc.json` file
4. Environment variables
5. Default values

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
- Color-coded by HTTP method (POST, GET, DELETE)
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

### Controls

- **Refresh**: Manually refresh the timeline
- **Clear History**: Remove all recorded interactions

## 🏗️ Project Structure

```
appium-session-recorder/
├── src/
│   ├── server/              # Backend modules
│   │   ├── types.ts         # Type definitions
│   │   ├── appium-client.ts # Appium communication
│   │   ├── interaction-recorder.ts  # Recording logic
│   │   ├── proxy-middleware.ts      # HTTP proxy
│   │   ├── routes.ts        # API routes
│   │   ├── server.ts        # Express server
│   │   └── index.ts         # Public API
│   ├── cli/                 # CLI implementation
│   │   ├── config.ts        # Configuration management
│   │   ├── prompts.ts       # Interactive prompts
│   │   └── index.ts         # CLI entry point
│   ├── ui/                  # Solid.js frontend
│   │   ├── src/
│   │   │   ├── components/  # UI components
│   │   │   ├── hooks/       # Solid.js hooks
│   │   │   ├── services/    # API client
│   │   │   ├── utils/       # Utilities
│   │   │   ├── styles/      # Design tokens
│   │   │   ├── App.tsx      # Main app
│   │   │   └── index.tsx    # Entry point
│   │   ├── index.html       # HTML template
│   │   ├── vite.config.ts   # Vite configuration
│   │   └── package.json     # UI dependencies
│   └── index.ts             # Main executable
├── dist/                    # Build output
│   └── ui/                  # Compiled frontend
├── .appiumrc.json.example   # Example config
├── package.json
└── README.md
```

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
- **Documentation**: Export session history for documentation
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

## 📝 License

MIT

## 🙏 Credits

Built with:
- [Bun](https://bun.sh/) - Fast all-in-one JavaScript runtime
- [Solid.js](https://www.solidjs.com/) - Reactive UI framework
- [Kobalte](https://kobalte.dev/) - Accessible UI primitives
- [@clack/prompts](https://github.com/natemoo-re/clack) - Beautiful CLI prompts
- [Express](https://expressjs.com/) - Web framework
- [Vite](https://vitejs.dev/) - Build tool
