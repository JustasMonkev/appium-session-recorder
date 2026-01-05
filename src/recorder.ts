import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

export type RecorderOptions = {
    appiumUrl?: string;
    host?: string;
    port?: number;
};

type Interaction = {
    id: number;
    timestamp: string;
    method: string;
    path: string;
    body: any;
    screenshot?: string;  // base64
    source?: string;      // XML
    elementInfo?: {
        using: string;
        value: string;
    };
};

const history: Interaction[] = [];
let interactionId = 0;

async function fetchFromAppium(appiumUrl: string, sessionId: string, endpoint: string): Promise<any> {
    try {
        const response = await fetch(`${appiumUrl}/session/${sessionId}/${endpoint}`);
        const data = await response.json();
        return data.value;
    } catch (e) {
        return null;
    }
}

async function captureState(appiumUrl: string, sessionId: string): Promise<{ screenshot?: string; source?: string }> {
    const [screenshot, source] = await Promise.all([
        fetchFromAppium(appiumUrl, sessionId, 'screenshot'),
        fetchFromAppium(appiumUrl, sessionId, 'source'),
    ]);
    return { screenshot, source };
}

function isActionEndpoint(method: string, path: string): boolean {
    const actionPatterns = [
        /\/element\/[^/]+\/click$/,
        /\/element\/[^/]+\/value$/,
        /\/element\/[^/]+\/clear$/,
        /\/element$/,
        /\/elements$/,
        /\/touch\/perform$/,
        /\/actions$/,
        /\/back$/,
        /\/forward$/,
        /\/refresh$/,
    ];

    if (method === 'POST' || method === 'DELETE') {
        return actionPatterns.some(pattern => pattern.test(path));
    }
    return false;
}

export function createRecorderApp(options: RecorderOptions = {}) {
    const appiumUrl = options.appiumUrl ?? process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
    const app = express();

    // Parse JSON bodies
    app.use(express.json({ type: ['application/json', 'application/*+json'] }));
    app.use(express.urlencoded({ extended: true }));

    // Serve the history viewer
    app.get('/_recorder', (_req, res) => {
        res.send(getViewerHtml());
    });

    // API to get history
    app.get('/_recorder/history', (_req, res) => {
        res.json(history);
    });

    // API to clear history
    app.delete('/_recorder/history', (_req, res) => {
        history.length = 0;
        interactionId = 0;
        res.json({ ok: true });
    });

    // Intercept session requests
    app.use('/session/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
        const { sessionId } = req.params;
        const isAction = isActionEndpoint(req.method, req.path);

        // Log the interaction
        const interaction: Interaction = {
            id: ++interactionId,
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.originalUrl,
            body: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
        };

        // Extract element info for find operations
        if (req.body?.using && req.body?.value) {
            interaction.elementInfo = {
                using: req.body.using,
                value: req.body.value,
            };
        }

        console.log(`[${interaction.id}] ${req.method} ${req.originalUrl}`);
        if (interaction.body) {
            console.log('Body:', JSON.stringify(interaction.body, null, 2));
        }

        // For actions, capture state after the action completes
        if (isAction) {
            // Store reference to capture after response
            res.on('finish', async () => {
                const state = await captureState(appiumUrl, sessionId);
                interaction.screenshot = state.screenshot;
                interaction.source = state.source;
                history.push(interaction);
                console.log(`[${interaction.id}] State captured (screenshot + source)`);
            });
        } else {
            history.push(interaction);
        }

        next();
    });

    // Proxy everything to Appium
    app.use(
        createProxyMiddleware({
            target: appiumUrl,
            changeOrigin: true,
            ws: true,
            on: {
                proxyReq: fixRequestBody,
            },
        }),
    );

    return app;
}

export function startRecorder(options: RecorderOptions = {}) {
    const host = options.host ?? process.env.PROXY_HOST ?? '127.0.0.1';
    const port = options.port ?? Number(process.env.PROXY_PORT ?? '4724');
    const appiumUrl = options.appiumUrl ?? process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';

    const app = createRecorderApp(options);

    return app.listen(port, host, () => {
        console.log(`Session Recorder started:`);
        console.log(`  Proxy: http://${host}:${port} -> ${appiumUrl}`);
        console.log(`  Viewer: http://${host}:${port}/_recorder`);
    });
}

function getViewerHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Appium Session Recorder</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0; padding: 20px; background: #1a1a2e; color: #eee;
        }
        h1 { color: #00d4ff; margin-bottom: 20px; }
        .controls { margin-bottom: 20px; }
        .controls button {
            background: #00d4ff; color: #1a1a2e; border: none;
            padding: 10px 20px; border-radius: 5px; cursor: pointer;
            font-weight: bold; margin-right: 10px;
        }
        .controls button:hover { background: #00a8cc; }
        .controls button.danger { background: #ff4757; }
        .controls button.danger:hover { background: #ff3344; }
        .timeline { display: flex; flex-direction: column; gap: 15px; }
        .interaction {
            background: #16213e; border-radius: 10px; padding: 15px;
            border-left: 4px solid #00d4ff;
        }
        .interaction.action { border-left-color: #ff9f43; }
        .interaction-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 10px;
        }
        .interaction-id {
            background: #00d4ff; color: #1a1a2e; padding: 2px 8px;
            border-radius: 10px; font-size: 12px; font-weight: bold;
        }
        .interaction.action .interaction-id { background: #ff9f43; }
        .interaction-time { color: #888; font-size: 12px; }
        .interaction-method {
            font-weight: bold; margin-right: 10px;
            padding: 2px 6px; border-radius: 3px; font-size: 12px;
        }
        .interaction-method.POST { background: #2ed573; color: #000; }
        .interaction-method.GET { background: #3498db; color: #fff; }
        .interaction-method.DELETE { background: #ff4757; color: #fff; }
        .interaction-path { font-family: monospace; color: #ddd; word-break: break-all; }
        .interaction-body {
            background: #0f0f23; padding: 10px; border-radius: 5px;
            margin-top: 10px; font-family: monospace; font-size: 12px;
            overflow-x: auto; white-space: pre-wrap;
        }
        .element-info {
            background: #2d3436; padding: 8px 12px; border-radius: 5px;
            margin-top: 10px; display: inline-block;
        }
        .element-info span { color: #00d4ff; }
        .screenshot-container { margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap; }
        .screenshot-container img {
            max-width: 300px; border-radius: 10px; cursor: pointer;
            border: 2px solid #333;
        }
        .screenshot-container img:hover { border-color: #00d4ff; }
        .modal {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.95); z-index: 1000;
        }
        .modal.active { display: flex; }
        .modal-close {
            position: absolute; top: 20px; right: 30px; color: #fff;
            font-size: 40px; cursor: pointer; z-index: 1001;
        }
        .source-toggle, .inspect-btn {
            background: #2d3436; color: #eee; border: none;
            padding: 5px 10px; border-radius: 3px; cursor: pointer;
            margin-top: 10px; font-size: 12px; margin-right: 5px;
        }
        .inspect-btn { background: #6c5ce7; }
        .inspect-btn:hover { background: #5b4cdb; }
        .source-content {
            display: none; background: #0f0f23; padding: 10px;
            border-radius: 5px; margin-top: 10px; font-family: monospace;
            font-size: 11px; max-height: 300px; overflow: auto;
            white-space: pre-wrap; word-break: break-all;
        }
        .source-content.active { display: block; }
        .empty-state {
            text-align: center; padding: 60px; color: #666;
        }
        .stats {
            background: #16213e; padding: 15px 20px; border-radius: 10px;
            margin-bottom: 20px; display: flex; gap: 30px;
        }
        .stat { text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; color: #00d4ff; }
        .stat-label { font-size: 12px; color: #888; }

        /* Inspector Panel Styles */
        .inspector-panel {
            display: flex; height: 100%; padding: 20px; gap: 20px;
        }
        .inspector-left {
            position: relative; flex-shrink: 0;
        }
        .inspector-screenshot {
            max-height: 90vh; border-radius: 10px;
        }
        .element-highlight {
            position: absolute; border: 2px solid #00d4ff; background: rgba(0,212,255,0.2);
            pointer-events: none; border-radius: 3px;
        }
        .inspector-right {
            flex: 1; overflow-y: auto; max-width: 500px;
        }
        .inspector-section {
            background: #16213e; border-radius: 10px; padding: 15px; margin-bottom: 15px;
        }
        .inspector-section h3 {
            margin: 0 0 10px 0; color: #00d4ff; font-size: 14px;
        }
        .element-attr {
            display: flex; margin-bottom: 8px; font-size: 12px;
        }
        .element-attr-name {
            color: #888; width: 120px; flex-shrink: 0;
        }
        .element-attr-value {
            color: #fff; font-family: monospace; word-break: break-all;
        }
        .element-attr-value.copyable {
            cursor: pointer; padding: 2px 6px; background: #0f0f23; border-radius: 3px;
        }
        .element-attr-value.copyable:hover { background: #1a1a3e; }
        .locator-row {
            display: flex; gap: 10px; margin-bottom: 8px; align-items: center;
        }
        .locator-strategy {
            color: #ff9f43; font-size: 11px; width: 100px; flex-shrink: 0;
        }
        .locator-value {
            flex: 1; font-family: monospace; font-size: 11px; color: #fff;
            background: #0f0f23; padding: 5px 8px; border-radius: 3px;
            cursor: pointer; word-break: break-all;
        }
        .locator-value:hover { background: #1a1a3e; }
        .copy-feedback {
            position: fixed; bottom: 20px; right: 20px; background: #2ed573;
            color: #000; padding: 10px 20px; border-radius: 5px; font-weight: bold;
            display: none; z-index: 2000;
        }
        .copy-feedback.active { display: block; }

        /* Query Tester Styles */
        .query-tester {
            background: #0f0f23; border-radius: 5px; padding: 10px; margin-top: 10px;
        }
        .query-input-row {
            display: flex; gap: 10px; margin-bottom: 10px;
        }
        .query-input-row select {
            background: #16213e; color: #fff; border: 1px solid #333;
            padding: 8px; border-radius: 5px; font-size: 12px;
        }
        .query-input-row input {
            flex: 1; background: #16213e; color: #fff; border: 1px solid #333;
            padding: 8px; border-radius: 5px; font-size: 12px; font-family: monospace;
        }
        .query-input-row button {
            background: #6c5ce7; color: #fff; border: none; padding: 8px 15px;
            border-radius: 5px; cursor: pointer; font-size: 12px;
        }
        .query-input-row button:hover { background: #5b4cdb; }
        .query-result {
            font-size: 12px; padding: 10px; border-radius: 5px; margin-top: 10px;
        }
        .query-result.success { background: rgba(46,213,115,0.2); color: #2ed573; }
        .query-result.error { background: rgba(255,71,87,0.2); color: #ff4757; }
        .query-result.info { background: rgba(0,212,255,0.2); color: #00d4ff; }
        .found-elements { margin-top: 10px; }
        .found-element {
            background: #16213e; padding: 8px; border-radius: 5px; margin-bottom: 5px;
            font-family: monospace; font-size: 11px; cursor: pointer;
        }
        .found-element:hover { background: #1a1a3e; }
    </style>
</head>
<body>
    <h1>Appium Session Recorder</h1>

    <div class="controls">
        <button onclick="refresh()">Refresh</button>
        <button onclick="clearHistory()" class="danger">Clear History</button>
        <button onclick="exportHistory()">Export JSON</button>
    </div>

    <div class="stats" id="stats"></div>
    <div class="timeline" id="timeline"></div>

    <div class="modal" id="modal">
        <span class="modal-close" onclick="closeModal()">&times;</span>
        <div class="inspector-panel" id="inspector-panel"></div>
    </div>

    <div class="copy-feedback" id="copy-feedback">Copied!</div>

    <script>
        let historyData = [];
        let renderedIds = new Set();
        let currentInspectorData = null;
        let parsedElements = [];

        async function refresh() {
            const res = await fetch('/_recorder/history');
            historyData = await res.json();
            renderIncremental();
        }

        async function clearHistory() {
            if (confirm('Clear all recorded interactions?')) {
                await fetch('/_recorder/history', { method: 'DELETE' });
                renderedIds.clear();
                historyData = [];
                document.getElementById('timeline').innerHTML = '<div class="empty-state">No interactions recorded yet.<br>Connect Appium Inspector to port 4724 and start interacting.</div>';
                updateStats();
            }
        }

        function exportHistory() {
            const blob = new Blob([JSON.stringify(historyData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'appium-session-' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.json';
            a.click();
        }

        function updateStats() {
            const stats = document.getElementById('stats');
            const actions = historyData.filter(i => i.screenshot);
            stats.innerHTML = \`
                <div class="stat">
                    <div class="stat-value">\${historyData.length}</div>
                    <div class="stat-label">Total Requests</div>
                </div>
                <div class="stat">
                    <div class="stat-value">\${actions.length}</div>
                    <div class="stat-label">Actions (with screenshots)</div>
                </div>
            \`;
        }

        function renderInteraction(i) {
            return \`
                <div class="interaction \${i.screenshot ? 'action' : ''}" id="interaction-\${i.id}">
                    <div class="interaction-header">
                        <div>
                            <span class="interaction-id">#\${i.id}</span>
                            <span class="interaction-method \${i.method}">\${i.method}</span>
                            <span class="interaction-path">\${i.path}</span>
                        </div>
                        <span class="interaction-time">\${new Date(i.timestamp).toLocaleTimeString()}</span>
                    </div>
                    \${i.elementInfo ? \`
                        <div class="element-info">
                            <span>\${i.elementInfo.using}:</span> "\${i.elementInfo.value}"
                        </div>
                    \` : ''}
                    \${i.body ? \`<div class="interaction-body">\${JSON.stringify(i.body, null, 2)}</div>\` : ''}
                    \${i.screenshot ? \`
                        <div class="screenshot-container">
                            <img src="data:image/png;base64,\${i.screenshot}" onclick="openInspector(\${i.id})" title="Click to inspect elements" />
                            <button class="inspect-btn" onclick="openInspector(\${i.id})">Inspect Elements</button>
                        </div>
                    \` : ''}
                    \${i.source ? \`
                        <button class="source-toggle" onclick="toggleSource(\${i.id})">Show XML Source</button>
                        <div class="source-content" id="source-\${i.id}">\${escapeHtml(i.source)}</div>
                    \` : ''}
                </div>
            \`;
        }

        function renderIncremental() {
            const timeline = document.getElementById('timeline');
            updateStats();

            if (historyData.length === 0) {
                timeline.innerHTML = '<div class="empty-state">No interactions recorded yet.<br>Connect Appium Inspector to port 4724 and start interacting.</div>';
                return;
            }

            const emptyState = timeline.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            for (const i of historyData) {
                if (!renderedIds.has(i.id)) {
                    const existing = document.getElementById('interaction-' + i.id);
                    if (existing) {
                        if (i.screenshot || i.source) {
                            existing.outerHTML = renderInteraction(i);
                        }
                    } else {
                        timeline.insertAdjacentHTML('beforeend', renderInteraction(i));
                    }
                    if (i.screenshot) {
                        renderedIds.add(i.id);
                    }
                }
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function toggleSource(id) {
            const el = document.getElementById('source-' + id);
            const btn = el.previousElementSibling;
            const isOpen = el.classList.toggle('active');
            btn.textContent = isOpen ? 'Hide XML Source' : 'Show XML Source';
        }

        // Parse XML source to extract elements with bounding boxes
        function parseXmlSource(xmlString) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlString, 'text/xml');
            const elements = [];

            function traverse(node, xpath = '', index = 0) {
                if (node.nodeType !== 1) return;

                const type = node.getAttribute('type') || node.tagName;
                const x = parseInt(node.getAttribute('x')) || 0;
                const y = parseInt(node.getAttribute('y')) || 0;
                const width = parseInt(node.getAttribute('width')) || 0;
                const height = parseInt(node.getAttribute('height')) || 0;

                const currentXpath = xpath + '/' + type + '[' + (index + 1) + ']';

                elements.push({
                    type,
                    name: node.getAttribute('name') || '',
                    label: node.getAttribute('label') || '',
                    value: node.getAttribute('value') || '',
                    enabled: node.getAttribute('enabled') === 'true',
                    visible: node.getAttribute('visible') === 'true',
                    accessible: node.getAttribute('accessible') === 'true',
                    x, y, width, height,
                    xpath: currentXpath,
                    node
                });

                const childCounts = {};
                for (const child of node.children) {
                    const childType = child.getAttribute('type') || child.tagName;
                    childCounts[childType] = (childCounts[childType] || 0);
                    traverse(child, currentXpath, childCounts[childType]);
                    childCounts[childType]++;
                }
            }

            traverse(doc.documentElement);
            return elements;
        }

        // Generate locators for an element
        function generateLocators(element) {
            const locators = [];

            if (element.name) {
                locators.push({ strategy: 'accessibility id', value: element.name });
            }
            if (element.label && element.label !== element.name) {
                locators.push({ strategy: 'accessibility id', value: element.label });
            }
            locators.push({ strategy: 'xpath', value: element.xpath });
            locators.push({ strategy: 'class name', value: element.type });

            if (element.name) {
                locators.push({
                    strategy: '-ios predicate string',
                    value: \`name == "\${element.name}"\`
                });
            }
            if (element.label) {
                locators.push({
                    strategy: '-ios predicate string',
                    value: \`label == "\${element.label}"\`
                });
            }
            if (element.name) {
                locators.push({
                    strategy: '-ios class chain',
                    value: \`**/\${element.type}[\\\`name == "\${element.name}"\\\`]\`
                });
            }

            return locators;
        }

        // Open inspector panel
        function openInspector(interactionId) {
            const interaction = historyData.find(i => i.id === interactionId);
            if (!interaction || !interaction.screenshot || !interaction.source) return;

            currentInspectorData = interaction;
            parsedElements = parseXmlSource(interaction.source);

            const panel = document.getElementById('inspector-panel');
            panel.innerHTML = \`
                <div class="inspector-left">
                    <img src="data:image/png;base64,\${interaction.screenshot}"
                         class="inspector-screenshot" id="inspector-img" />
                    <div id="element-highlights"></div>
                </div>
                <div class="inspector-right">
                    <div class="inspector-section">
                        <h3>Query Tester</h3>
                        <div class="query-tester">
                            <div class="query-input-row">
                                <select id="query-strategy">
                                    <option value="accessibility id">accessibility id</option>
                                    <option value="xpath">xpath</option>
                                    <option value="class name">class name</option>
                                    <option value="-ios predicate string">-ios predicate string</option>
                                    <option value="-ios class chain">-ios class chain</option>
                                </select>
                                <input type="text" id="query-value" placeholder="Enter locator value..." onkeypress="if(event.key==='Enter')runQuery()" />
                                <button onclick="runQuery()">Find</button>
                            </div>
                            <div id="query-result"></div>
                        </div>
                    </div>
                    <div class="inspector-section" id="element-details">
                        <h3>Element Details</h3>
                        <p style="color: #666; font-size: 12px;">Use Query Tester to find elements</p>
                    </div>
                    <div class="inspector-section" id="element-locators" style="display:none;">
                        <h3>Locators (click to copy)</h3>
                        <div id="locators-list"></div>
                    </div>
                </div>
            \`;

            document.getElementById('modal').classList.add('active');
        }

        function highlightElement(element, img, rect) {
            const scaleX = rect.width / img.naturalWidth;
            const scaleY = rect.height / img.naturalHeight;

            const container = document.getElementById('element-highlights');
            container.innerHTML = \`
                <div class="element-highlight" style="
                    left: \${element.x * scaleX}px;
                    top: \${element.y * scaleY}px;
                    width: \${element.width * scaleX}px;
                    height: \${element.height * scaleY}px;
                "></div>
            \`;
        }

        function showElementDetails(element) {
            const details = document.getElementById('element-details');
            details.innerHTML = \`
                <h3>Element Details</h3>
                <div class="element-attr">
                    <span class="element-attr-name">Type:</span>
                    <span class="element-attr-value">\${element.type}</span>
                </div>
                \${element.name ? \`
                <div class="element-attr">
                    <span class="element-attr-name">Name:</span>
                    <span class="element-attr-value copyable" onclick="copyText('\${escapeAttr(element.name)}')">\${escapeHtml(element.name)}</span>
                </div>\` : ''}
                \${element.label ? \`
                <div class="element-attr">
                    <span class="element-attr-name">Label:</span>
                    <span class="element-attr-value copyable" onclick="copyText('\${escapeAttr(element.label)}')">\${escapeHtml(element.label)}</span>
                </div>\` : ''}
                \${element.value ? \`
                <div class="element-attr">
                    <span class="element-attr-name">Value:</span>
                    <span class="element-attr-value copyable" onclick="copyText('\${escapeAttr(element.value)}')">\${escapeHtml(element.value)}</span>
                </div>\` : ''}
                <div class="element-attr">
                    <span class="element-attr-name">Bounds:</span>
                    <span class="element-attr-value">x=\${element.x}, y=\${element.y}, w=\${element.width}, h=\${element.height}</span>
                </div>
                <div class="element-attr">
                    <span class="element-attr-name">Visible:</span>
                    <span class="element-attr-value">\${element.visible}</span>
                </div>
                <div class="element-attr">
                    <span class="element-attr-name">Enabled:</span>
                    <span class="element-attr-value">\${element.enabled}</span>
                </div>
            \`;

            // Show locators
            const locators = generateLocators(element);
            const locatorsSection = document.getElementById('element-locators');
            const locatorsList = document.getElementById('locators-list');

            locatorsSection.style.display = 'block';
            locatorsList.innerHTML = locators.map(loc => \`
                <div class="locator-row">
                    <span class="locator-strategy">\${loc.strategy}</span>
                    <span class="locator-value" onclick="copyText('\${escapeAttr(loc.value)}')">\${escapeHtml(loc.value)}</span>
                </div>
            \`).join('');
        }

        function escapeAttr(str) {
            return str.replace(/'/g, "\\\\'").replace(/"/g, '\\\\"');
        }

        // Query tester
        function runQuery() {
            const strategy = document.getElementById('query-strategy').value;
            const value = document.getElementById('query-value').value.trim();
            const resultDiv = document.getElementById('query-result');

            if (!value) {
                resultDiv.innerHTML = '<div class="query-result error">Please enter a locator value</div>';
                return;
            }

            let found = [];

            switch (strategy) {
                case 'accessibility id':
                    found = parsedElements.filter(el => el.name === value || el.label === value);
                    break;
                case 'name':
                    found = parsedElements.filter(el => el.name === value);
                    break;
                case 'label':
                    found = parsedElements.filter(el => el.label === value);
                    break;
                case 'class name':
                    found = parsedElements.filter(el => el.type === value);
                    break;
                case 'xpath':
                    try {
                        const doc = new DOMParser().parseFromString(currentInspectorData.source, 'text/xml');
                        const result = doc.evaluate(value, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                        for (let i = 0; i < result.snapshotLength; i++) {
                            const node = result.snapshotItem(i);
                            const match = parsedElements.find(el => el.node === node ||
                                (el.x === parseInt(node.getAttribute('x')) &&
                                 el.y === parseInt(node.getAttribute('y')) &&
                                 el.type === (node.getAttribute('type') || node.tagName)));
                            if (match) found.push(match);
                        }
                    } catch (e) {
                        resultDiv.innerHTML = \`<div class="query-result error">Invalid XPath: \${escapeHtml(e.message)}</div>\`;
                        return;
                    }
                    break;
                case '-ios predicate string':
                    // Simple predicate parsing for common patterns
                    const predicateMatch = value.match(/^(name|label|value)\\s*==\\s*"([^"]+)"$/);
                    if (predicateMatch) {
                        const [, attr, val] = predicateMatch;
                        found = parsedElements.filter(el => el[attr] === val);
                    } else {
                        resultDiv.innerHTML = '<div class="query-result info">Predicate parsing limited. Supported: name == "value", label == "value"</div>';
                        return;
                    }
                    break;
                case '-ios class chain':
                    // Simple class chain parsing
                    const chainMatch = value.match(/\\*\\*\\/([^\\[]+)(?:\\[\\\`([^\\]]+)\\\`\\])?/);
                    if (chainMatch) {
                        const [, className, predicate] = chainMatch;
                        found = parsedElements.filter(el => el.type === className);
                        if (predicate) {
                            const predMatch = predicate.match(/(name|label)\\s*==\\s*"([^"]+)"/);
                            if (predMatch) {
                                const [, attr, val] = predMatch;
                                found = found.filter(el => el[attr] === val);
                            }
                        }
                    } else {
                        resultDiv.innerHTML = '<div class="query-result info">Class chain parsing limited.</div>';
                        return;
                    }
                    break;
            }

            if (found.length === 0) {
                resultDiv.innerHTML = '<div class="query-result error">No elements found</div>';
                clearHighlights();
            } else {
                resultDiv.innerHTML = \`
                    <div class="query-result success">Found \${found.length} element(s)</div>
                    <div class="found-elements">
                        \${found.slice(0, 10).map((el, i) => \`
                            <div class="found-element" onclick="selectFoundElement(\${i})">
                                \${el.type}\${el.name ? ' - ' + escapeHtml(el.name) : ''}\${el.label ? ' (' + escapeHtml(el.label) + ')' : ''}
                            </div>
                        \`).join('')}
                        \${found.length > 10 ? '<div style="color:#888;font-size:11px;padding:5px;">... and ' + (found.length - 10) + ' more</div>' : ''}
                    </div>
                \`;

                // Store found elements for selection
                window.foundElements = found;

                // Highlight first element
                if (found.length > 0) {
                    selectFoundElement(0);
                }
            }
        }

        function selectFoundElement(index) {
            const element = window.foundElements[index];
            if (!element) return;

            showElementDetails(element);
            const img = document.getElementById('inspector-img');
            const rect = img.getBoundingClientRect();
            highlightElement(element, img, rect);
        }

        function clearHighlights() {
            document.getElementById('element-highlights').innerHTML = '';
        }

        function copyText(text) {
            navigator.clipboard.writeText(text).then(() => {
                const feedback = document.getElementById('copy-feedback');
                feedback.classList.add('active');
                setTimeout(() => feedback.classList.remove('active'), 1500);
            });
        }

        function closeModal() {
            document.getElementById('modal').classList.remove('active');
            currentInspectorData = null;
            parsedElements = [];
        }

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeModal();
        });

        refresh();
        setInterval(refresh, 3000);
    </script>
</body>
</html>`;
}

// Run if executed directly
const entry = process.argv?.[1] ?? '';
if (/(^|\/|\\)recorder\.(ts|js)$/.test(entry)) {
    startRecorder();
}
