// End-to-end check against a real Appium server using @appium/fake-driver.
// Run after cargo build:
//   APPIUM_MODULE=/path/to/node_modules/appium APPIUM_HOME=/path/with/fake-driver node tests/appium_e2e.cjs
// Set RECORDER_BINARY to override the recorder binary path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const binary = process.env.RECORDER_BINARY || path.join(project, 'target/debug/appium-recorder');
const appiumModule = process.env.APPIUM_MODULE;
assert.ok(appiumModule, 'APPIUM_MODULE must point to an installed appium package');
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const children = [];

const APP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<app width="400" height="852">
    <MockListView id="lv" top="15" left="20" width="30" height="2">
        <MockListItem id="li" />
        <MockListItem id="li" />
    </MockListView>
    <MockInputField id="input" name="TypeMe" />
    <MockButton id="Button2" />
</app>
`;

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: project, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.output = () => output;
  children.push(child);
  return child;
}

async function waitFor(url, child, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early:\n${child.output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready:\n${child.output()}`);
}

function cli(args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd: project, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`Invalid CLI JSON for ${args.join(' ')}: ${stdout}`));
      }
      if (error || !parsed.ok) return reject(new Error(`CLI ${args.slice(0, 2).join(' ')} failed: ${stdout}`));
      resolve(parsed.result);
    });
  });
}

async function webdriver(base, method, route, body, headers = {}) {
  const response = await fetch(base + route, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, value: text ? JSON.parse(text).value : undefined };
}

async function bidiStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('BiDi status timed out')), 10000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'session.status', params: {} }));
    socket.onmessage = event => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(event.data));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`BiDi connection to ${url} failed`));
    };
  });
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-appium-e2e-'));
  const appPath = path.join(work, 'app.xml');
  fs.writeFileSync(appPath, APP_XML);
  const caps = { platformName: 'Fake', 'appium:automationName': 'Fake', 'appium:deviceName': 'Fake', 'appium:app': appPath };
  const capsFile = path.join(work, 'caps.json');
  fs.writeFileSync(capsFile, JSON.stringify(caps));

  const appiumPort = await freePort();
  const appium = start(process.execPath, [path.join(appiumModule, 'index.js'), '--address', '127.0.0.1', '--port', String(appiumPort)], {});
  const appiumUrl = `http://127.0.0.1:${appiumPort}`;
  await waitFor(`${appiumUrl}/status`, appium, 'Appium');
  const status = await webdriver(appiumUrl, 'GET', '/status');
  const version = status.value.build.version;
  console.log(`Appium ${version}`);

  // Command mode talks to Appium directly.
  const created = await cli(['session', 'create', '--appium-url', appiumUrl, '--caps-file', capsFile]);
  const sid = created.sessionId;
  assert.ok(sid);
  const common = ['--appium-url', appiumUrl, '--session-id', sid];
  const snapshot = await cli(['screen', 'snapshot', ...common]);
  assert.match(snapshot.source, /MockInputField/);
  assert.ok(snapshot.screenshot.length > 100);
  const elements = await cli(['screen', 'elements', ...common]);
  const input = elements.elements.find(element => element.attributes.id === 'input');
  assert.ok(input, 'input element is listed');
  const best = await cli(['selectors', 'best', ...common, '--element-ref', input.elementRef]);
  assert.ok(best.allSelectors.some(selector => selector.strategy === 'id' && selector.value === 'input'));
  await cli(['drive', 'tap', ...common, '--using', 'id', '--value', 'Button2']);
  await cli(['drive', 'tap', ...common, '--using', 'xpath', '--value', "//MockButton[@id='Button2']"]);
  await cli(['drive', 'type', ...common, '--using', 'id', '--value', 'input', '--text', 'héllo 👋', '--clear-first']);
  const found = await webdriver(appiumUrl, 'POST', `/session/${sid}/element`, { using: 'id', value: 'input' });
  const text = await webdriver(appiumUrl, 'GET', `/session/${sid}/element/${found.value[ELEMENT]}/text`);
  assert.equal(text.value, 'héllo 👋');
  await cli(['drive', 'swipe', ...common, '--from', '10,500', '--to', '10,100', '--duration-ms', '100']);
  for (const direction of ['up', 'down', 'left', 'right']) {
    await cli(['drive', 'scroll', ...common, '--direction', direction]);
  }
  await cli(['session', 'delete', ...common]);
  console.log('command mode ok');

  // Proxy mode records a W3C client session.
  const recorderPort = await freePort();
  const recorder = start(binary, ['proxy', 'start', '--port', String(recorderPort), '--appium-url', appiumUrl], {});
  const proxy = `http://127.0.0.1:${recorderPort}`;
  await waitFor(`${proxy}/_recorder/api/history`, recorder, 'Recorder');
  const session = await webdriver(proxy, 'POST', '/session', { capabilities: { alwaysMatch: { ...caps, webSocketUrl: true }, firstMatch: [{}] } });
  assert.equal(session.status, 200, JSON.stringify(session.value));
  const psid = session.value.sessionId;
  const button = await webdriver(proxy, 'POST', `/session/${psid}/element`, { using: 'id', value: 'Button2' });
  assert.equal((await webdriver(proxy, 'POST', `/session/${psid}/element/${button.value[ELEMENT]}/click`, {})).status, 200);
  const items = await webdriver(proxy, 'POST', `/session/${psid}/elements`, { using: 'id', value: 'li' });
  assert.equal(items.value.length, 2);
  assert.equal((await webdriver(proxy, 'POST', `/session/${psid}/element/${items.value[1][ELEMENT]}/click`, {})).status, 200);
  const field = await webdriver(proxy, 'POST', `/session/${psid}/element`, { using: 'accessibility id', value: 'input' });
  const fieldId = field.value[ELEMENT];
  assert.equal((await webdriver(proxy, 'POST', `/session/${psid}/element/${fieldId}/clear`, {})).status, 200);
  assert.equal((await webdriver(proxy, 'POST', `/session/${psid}/element/${fieldId}/value`, { text: 'abc' })).status, 200);
  const actions = { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: 100, y: 600 }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 100, x: 100, y: 200 }, { type: 'pointerUp', button: 0 },
  ] }] };
  assert.equal((await webdriver(proxy, 'POST', `/session/${psid}/actions`, actions)).status, 200);
  const missing = await webdriver(proxy, 'POST', `/session/${psid}/element`, { using: 'id', value: 'missing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.value.error, 'no such element');
  const timeouts = await webdriver(proxy, 'POST', `/session/${psid}/timeouts`, { implicit: 0 });
  assert.equal(timeouts.status, 200);

  // WebDriver BiDi upgrades are tunnelled through the recorder.
  const bidiPath = new URL(session.value.capabilities.webSocketUrl).pathname;
  const bidi = await bidiStatus(`ws://127.0.0.1:${recorderPort}${bidiPath}`);
  assert.equal(bidi.type, 'success');

  const deadline = Date.now() + 15000;
  let history;
  do {
    history = await (await fetch(`${proxy}/_recorder/api/history`)).json();
    if (!history.some(entry => entry.captureStatus === 'pending')) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  const byKind = kind => history.filter(entry => entry.actionKind === kind);
  assert.deepEqual(history.map(entry => entry.actionKind), ['find', 'tap', 'find', 'tap', 'find', 'clear', 'type', 'swipe', 'find', 'unknown']);
  for (const entry of history.filter(entry => entry.actionKind !== 'unknown' && entry.elementInfo?.value !== 'missing')) {
    assert.equal(entry.captureStatus, 'complete', JSON.stringify(entry));
    assert.match(entry.source, /MockInputField/);
    const png = await fetch(proxy + entry.screenshotUrl);
    assert.equal(png.status, 200);
  }
  assert.deepEqual(byKind('tap').map(entry => entry.elementInfo), [{ using: 'id', value: 'Button2' }, { using: 'id', value: 'li' }]);
  assert.deepEqual(byKind('type')[0].elementInfo, { using: 'accessibility id', value: 'input' });
  assert.equal(history.find(entry => entry.elementInfo?.value === 'missing').captureStatus, 'skipped');
  assert.equal((await webdriver(proxy, 'DELETE', `/session/${psid}`)).status, 200);
  console.log(`proxy mode ok (${history.length} interactions recorded)`);
}

main()
  .then(() => console.log('Appium end-to-end test passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill('SIGTERM');
  });
