# Appium Session Recorder

A proxy server that sits between Appium Inspector and your Appium server to record all interactions, capture screenshots, and provide element inspection capabilities.

## How It Works

```
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│   Appium Inspector  │ ──── │   Session Recorder  │ ──── │    Appium Server    │
│   (localhost:4724)  │      │   (localhost:4724)  │      │   (localhost:4723)  │
└─────────────────────┘      └─────────────────────┘      └─────────────────────┘
```

1. **Appium Inspector** connects to the proxy (port 4724)
2. **Session Recorder** intercepts all requests and logs them
3. For action commands (click, type, etc.), it captures screenshots and page source
4. All requests are forwarded to the **Appium Server** (port 4723)
5. View recorded interactions at `http://localhost:4724/_recorder`

## Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime installed
- Appium server running (default: `http://127.0.0.1:4723`)

### Installation

```bash
bun install
```

### Start the Recorder

```bash
bun start
```

This starts the proxy on `http://127.0.0.1:4724`

### Configure Appium Inspector

In Appium Inspector, change the **Remote Host** and **Remote Port** settings:

| Setting | Value |
|---------|-------|
| Remote Host | `127.0.0.1` |
| Remote Port | `4724` |
| Remote Path | `/` |

**Important:** Point Appium Inspector to the proxy port (`4724`), not the Appium server port (`4723`).

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `APPIUM_URL` | `http://127.0.0.1:4723` | URL of your Appium server |
| `PROXY_HOST` | `127.0.0.1` | Host for the proxy server |
| `PROXY_PORT` | `4724` | Port for the proxy server |

Example:

```bash
APPIUM_URL=http://192.168.1.100:4723 PROXY_PORT=8080 bun start
```

## Features

### Web Viewer (`/_recorder`)

Access `http://localhost:4724/_recorder` to:

- View all recorded interactions in real-time
- See screenshots captured after each action
- Inspect XML page source
- Export session history as JSON

### Element Inspector

Click on any screenshot in the viewer to open the element inspector:

- Test locator queries (accessibility id, xpath, class name, iOS predicates)
- View element attributes and bounds
- Copy locators to clipboard

### Recorded Actions

The following actions trigger screenshot/source capture:

- Element clicks
- Text input (value)
- Element clear
- Find element/elements
- Touch actions
- Navigation (back, forward, refresh)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/_recorder` | GET | Web viewer UI |
| `/_recorder/history` | GET | Get recorded interactions as JSON |
| `/_recorder/history` | DELETE | Clear recorded history |