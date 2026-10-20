// Run after cargo build: PLAYWRIGHT_MODULE=/path/to/playwright node tests/viewer_smoke.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const project = path.resolve(__dirname, '..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=';
let step = 0;
const source = () => `<AppiumAUT><XCUIElementTypeButton type="XCUIElementTypeButton" name="continue" label="${step === 1 ? 'Continue' : 'Next'}" value="&lt;img src=x onerror=window.viewerInjected=1&gt;" enabled="true" visible="true" accessible="true"/></AppiumAUT>`;
const upstream = http.createServer((request, response) => {
  let value = null;
  if (request.url === '/session/demo/back') step++;
  else if (request.url === '/session/demo/source') value = source();
  else if (request.url === '/session/demo/screenshot') value = png;
  else { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ value }));
});

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function startRecorder(port, upstreamPort) {
  const binary = process.env.RECORDER_BINARY || path.join(project, 'target/debug/appium-recorder');
  const recorder = spawn(binary, ['proxy', 'start', '--port', String(port), '--appium-url', `http://127.0.0.1:${upstreamPort}`], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Recorder startup timed out')), 10000);
    let output = '';
    const finish = callback => {
      clearTimeout(timer);
      recorder.stdout.removeListener('data', data);
      recorder.removeListener('error', failure);
      recorder.removeListener('exit', exited);
      callback();
    };
    const failure = error => finish(() => reject(error));
    const exited = code => failure(new Error(`Recorder exited before startup (${code})`));
    const data = chunk => {
      output += chunk.toString();
      if (!output.includes('\n')) return;
      try {
        const response = JSON.parse(output.split('\n')[0]);
        if (!response.ok) throw new Error(JSON.stringify(response.error));
        finish(resolve);
      } catch (error) { failure(error); }
    };
    recorder.stdout.on('data', data);
    recorder.once('error', failure);
    recorder.once('exit', exited);
  });
  return { recorder, ready };
}

async function main() {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const { recorder, ready } = startRecorder(port, upstream.address().port);
  let browser;
  try {
    await ready;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BINARY || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${port}`;
    await page.goto(`${base}/_recorder`);
    await page.waitForFunction(() => document.getElementById('connection').textContent === 'Live');
    const back = async () => {
      const response = await fetch(`${base}/session/demo/back`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200);
      await response.json();
    };
    await back();
    await page.waitForFunction(() => document.getElementById('source').textContent.includes('Continue'));
    await back();
    await page.waitForFunction(() => document.getElementById('source').textContent.includes('Next'));
    assert.match(await page.locator('#position').textContent(), /Action 2 of 2/);
    assert.equal(await page.locator('#screenshot').isVisible(), true);
    await page.waitForFunction(() => document.getElementById('screenshot').naturalWidth > 0);
    await page.locator('#previous').click();
    await page.locator('#elements button', { hasText: 'XCUIElementTypeButton' }).click();
    await page.waitForFunction(() => document.getElementById('stability').textContent.includes('1/1 stable'));
    assert.equal(await page.locator('#follow').isChecked(), false);
    assert.ok(await page.locator('#selectors button', { hasText: 'Copy' }).count() > 0);
    assert.equal(await page.locator('[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.viewerInjected), undefined);
    await page.locator('#strategy').selectOption('xpath');
    await page.locator('#query-value').fill('//XCUIElementTypeButton[@name="continue"]');
    await page.locator('#query button').click();
    await page.waitForFunction(() => document.getElementById('query-result').textContent.includes('Found 1'));
    await page.locator('#strategy').selectOption('accessibility id');
    await page.locator('#query-value').fill('continue');
    await page.locator('#query button').click();
    await page.waitForFunction(() => document.getElementById('query-result').textContent.includes('Found 1'));
    await page.locator('#next').click();
    await page.waitForFunction(() => document.getElementById('source').textContent.includes('Next'));
    await page.locator('#tab-diff').click();
    await page.waitForFunction(() => document.getElementById('diff-summary').textContent.includes('+1'));
    assert.equal(await page.locator('#diff-rows tr.modified').count(), 1);
    await page.locator('#tab-journey').click();
    assert.equal(await page.locator('#journey-list button').count(), 2);
    await page.locator('#journey-list button').first().click();
    assert.match(await page.locator('#position').textContent(), /Action 1 of 2/);
    await page.locator('#follow').check();
    await page.waitForFunction(() => document.getElementById('position').textContent.includes('Action 2'));
    await page.locator('#clear').click();
    await page.waitForFunction(() => document.getElementById('position').textContent.includes('No actions'));
    assert.equal(await page.locator('#screenshot').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS viewer: live Rust proxy, captures, SSE, navigation, XPath/mobile queries, ranked selectors, stability, diff, journey, clear, CSP');
  } finally {
    if (browser) await browser.close();
    const exited = new Promise(resolve => recorder.once('exit', resolve));
    if (recorder.pid && recorder.exitCode === null) {
      recorder.kill('SIGTERM');
      const timer = setTimeout(() => recorder.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
