'use strict';

const $ = id => document.getElementById(id);
const MAX_SOURCE = 512 * 1024;
let actions = [];
let selectedId;
let selectedElement;
let inspection;
let displayedAction;
let selectionRequest = new AbortController();
let elementRequest = new AbortController();
let queryRequest = new AbortController();
let activeTab = 'inspect';
let diffRows = [];

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function notice(message) {
  $('notice').textContent = message;
}

async function jsonRequest(path, options = {}) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const response = await fetch(path, { ...options, signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

function inspect(request, signal) {
  return jsonRequest('/_recorder/api/inspect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal,
  });
}

function validAction(action) {
  return action && Number.isSafeInteger(action.id) && action.id > 0
    && typeof action.timestamp === 'string' && typeof action.method === 'string'
    && typeof action.path === 'string'
    && (action.source === undefined || typeof action.source === 'string')
    && (action.screenshotUrl === undefined || typeof action.screenshotUrl === 'string');
}

function currentIndex() {
  return actions.findIndex(action => action.id === selectedId);
}

function screenshot(image, action) {
  const path = action?.screenshotUrl;
  if (path && /^\/_recorder\/api\/screenshot\/[1-9]\d*(?:\?v=\d+)?$/.test(path)) {
    image.src = path;
    image.hidden = false;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
  }
}

async function hydrate(action, signal) {
  if (!action?.detailsTruncated) return action;
  const path = action.detailsUrl;
  if (path !== `/_recorder/api/interaction/${action.id}`) throw new Error('Invalid interaction details URL');
  const details = await jsonRequest(path, { signal });
  if (!validAction(details) || details.id !== action.id || details.detailsTruncated) {
    throw new Error('Invalid interaction details response');
  }
  const index = actions.indexOf(action);
  if (index >= 0) actions[index] = details;
  return details;
}

function renderNavigation() {
  const index = currentIndex();
  const action = actions[index];
  $('position').textContent = action ? `Action ${index + 1} of ${actions.length} · #${action.id}` : 'No actions recorded';
  $('action-meta').textContent = action ? `${action.method} ${action.path} · ${new Date(action.timestamp).toLocaleTimeString()} · ${action.actionKind || 'unknown'} · capture ${action.captureStatus || 'unavailable'}` : 'Point your Appium client at this recorder to begin.';
  $('action-selector').textContent = action?.elementInfo ? `${action.elementInfo.using}: ${action.elementInfo.value}` : '';
  $('previous').disabled = index <= 0;
  $('next').disabled = index < 0 || index >= actions.length - 1;
}

function selectAction(id, follow = false) {
  selectedId = id;
  $('follow').checked = follow;
  render();
}

function render() {
  if (!actions.some(action => action.id === selectedId)) selectedId = actions.at(-1)?.id;
  renderNavigation();
  renderJourney();
  const action = actions[currentIndex()];
  if (action === displayedAction) return;
  displayedAction = action;
  selectionRequest.abort();
  elementRequest.abort();
  queryRequest.abort();
  selectionRequest = new AbortController();
  selectedElement = undefined;
  inspection = undefined;
  $('element-details').hidden = true;
  $('elements').replaceChildren();
  $('elements-status').textContent = '';
  $('query-result').textContent = '';
  $('query-value').value = '';
  $('source').textContent = '';
  screenshot($('screenshot'), action);
  $('capture-status').textContent = action?.screenshotUrl ? '' : action ? `Screenshot ${action.captureStatus || 'unavailable'}` : 'Waiting for an Appium action.';
  $('copy-source').disabled = !action;
  diffRows = [];
  screenshot($('previous-screenshot'));
  screenshot($('current-screenshot'));
  renderDiffRows();
  $('diff-summary').textContent = action ? 'Loading comparison…' : 'Record at least two actions to compare screens.';
  if (action) loadAction(action, selectionRequest.signal);
}

async function loadAction(summary, signal) {
  try {
    const action = await hydrate(summary, signal);
    if (signal.aborted) return;
    displayedAction = action;
    screenshot($('screenshot'), action);
    $('capture-status').textContent = action.screenshotUrl ? '' : `Screenshot ${action.captureStatus || 'unavailable'}`;
    const source = action.source;
    if (!source) {
      $('source').textContent = 'No page source was captured for this action.';
    } else if (source.length > MAX_SOURCE) {
      $('source').textContent = 'Page source is too large to display or inspect (512 KiB limit).';
    } else {
      $('source').textContent = source;
      inspection = await inspect({ source }, signal);
      if (signal.aborted) return;
      renderElements();
    }
    const previous = await hydrate(actions[currentIndex() - 1], signal);
    if (signal.aborted) return;
    renderDiff(previous, action);
  } catch (error) {
    if (signal.aborted) return;
    notice(`${error.message}. Select another action and return to retry.`);
    $('elements-status').textContent = 'Inspection unavailable.';
    $('diff-summary').textContent = 'Comparison unavailable.';
  }
}

function renderElements(matches) {
  const all = matches || inspection?.elements || [];
  const filter = $('element-filter').value.toLowerCase();
  const filtered = all.filter(element => (!$('actionable').checked || (element.enabled && element.visible && (element.clickable || element.accessible)))
    && [element.type, element.name, element.label, element.resourceId, element.text].some(value => value?.toLowerCase().includes(filter)));
  $('elements-status').textContent = `${filtered.length} matching elements${filtered.length > 500 ? ' · showing first 500; filter to narrow the list' : ''}`;
  const fragment = document.createDocumentFragment();
  for (const element of filtered.slice(0, 500)) {
    const button = node('button', `${element.type} ${element.label || element.name || element.resourceId || ''}`);
    button.type = 'button';
    button.title = element.xpath;
    button.setAttribute('aria-pressed', String(element.elementRef === selectedElement?.elementRef));
    button.addEventListener('click', () => selectElement(element));
    fragment.append(button);
  }
  $('elements').replaceChildren(fragment);
}

async function futureSnapshots(signal) {
  const sources = [];
  let size = 0;
  let count = 0;
  const future = actions.slice(currentIndex() + 1).filter(action => action.source || action.detailsTruncated);
  for (const summary of future) {
    if (sources.length >= 10) break;
    const action = await hydrate(summary, signal);
    if (!action.source || size + action.source.length > MAX_SOURCE) break;
    const parsed = await inspect({ source: action.source }, signal);
    if (count + parsed.elements.length > 2000) break;
    size += action.source.length;
    count += parsed.elements.length;
    sources.push(action.source);
  }
  return { sources, eligible: future.length };
}

async function selectElement(element) {
  elementRequest.abort();
  elementRequest = new AbortController();
  const signal = AbortSignal.any([elementRequest.signal, selectionRequest.signal]);
  selectedElement = element;
  renderElements();
  $('element-details').hidden = false;
  $('attributes').textContent = JSON.stringify(element, null, 2);
  $('selectors').textContent = 'Ranking selectors…';
  $('stability').replaceChildren();
  $('stability-status').textContent = 'Checking future screens…';
  const source = displayedAction.source;
  try {
    const result = await inspect({ source, elementRef: element.elementRef }, signal);
    if (signal.aborted) return;
    renderSelectors(result.selectors || []);
    const snapshots = await futureSnapshots(signal);
    if (signal.aborted) return;
    $('stability-status').textContent = snapshots.sources.length ? `Analyzed ${snapshots.sources.length}/${snapshots.eligible} future screens; stable means exactly one match at every consecutive step.` : 'No eligible future screens available.';
    if (snapshots.sources.length) {
      const report = await inspect({ source, elementRef: element.elementRef, snapshots: snapshots.sources }, signal);
      if (!signal.aborted) renderStability(report.stability);
    }
  } catch (error) {
    if (!signal.aborted) notice(`Element inspection failed: ${error.message}`);
  }
}

function renderSelectors(selectors) {
  const fragment = document.createDocumentFragment();
  for (const selector of selectors) {
    const row = node('div', undefined, 'selector-row');
    const description = node('div', selector.strategy);
    description.append(node('small', `Score ${selector.score} · ${selector.matchCount} matches`));
    const value = node('code', selector.value);
    const test = node('button', 'Test');
    test.type = 'button';
    test.addEventListener('click', () => {
      $('strategy').value = selector.strategy;
      $('query-value').value = selector.value;
      $('query').requestSubmit();
    });
    const copy = node('button', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(selector.value));
    row.append(description, value, test, copy);
    fragment.append(row);
  }
  $('selectors').replaceChildren(fragment);
}

function renderStability(report) {
  const fragment = document.createDocumentFragment();
  for (const result of report?.results || []) {
    const row = node('div', undefined, 'stability-row');
    row.append(node('span', result.candidate.strategy), node('code', result.candidate.value), node('span', `${result.stableSteps}/${result.totalSteps} stable${result.firstFailureStep ? ` · fails at ${result.firstFailureStep}` : ''}`));
    fragment.append(row);
  }
  $('stability').replaceChildren(fragment);
}

function xpathMatches(source, expression) {
  const html = htmlSource(source);
  const doc = new DOMParser().parseFromString(source, html ? 'text/html' : 'text/xml');
  const result = doc.evaluate(expression, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const matches = new Set();
  for (let index = 0; index < result.snapshotLength; index++) {
    const element = result.snapshotItem(index);
    if (element?.nodeType === Node.ELEMENT_NODE) matches.add(element);
  }
  const paths = new Set();
  for (const element of matches) {
    const segments = [];
    let current = element;
    while (current?.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === current.tagName && sibling.namespaceURI === current.namespaceURI) index++;
      }
      const name = html
        ? current.namespaceURI === 'http://www.w3.org/1999/xhtml' && /^[A-Za-z_][\w.-]*$/.test(current.localName)
          ? current.localName : `*[local-name(.)="${current.localName}"]`
        : current.tagName;
      segments.unshift(`${name}[${index}]`);
      current = current.parentElement;
    }
    paths.add(`/${segments.join('/')}`);
  }
  return inspection.elements.filter(element => paths.has(element.xpath));
}

async function runQuery(event) {
  event.preventDefault();
  const value = $('query-value').value;
  if (!inspection || !value.trim()) return;
  queryRequest.abort();
  queryRequest = new AbortController();
  const signal = AbortSignal.any([selectionRequest.signal, queryRequest.signal]);
  try {
    const strategy = $('strategy').value;
    const matches = strategy === 'xpath'
      ? xpathMatches(displayedAction.source, value)
      : (await inspect({ source: displayedAction.source, query: { strategy, value } }, signal)).matches;
    if (signal.aborted) return;
    $('query-result').textContent = `Found ${matches.length} element(s) in the captured source.`;
    if (matches.length) await selectElement(matches[0]);
    renderElements(matches);
  } catch (error) {
    if (!signal.aborted) $('query-result').textContent = `Query failed: ${error.message}`;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notice('Copied to clipboard.');
  } catch (error) {
    notice(`Clipboard unavailable: ${error.message}. Select and copy the text manually.`);
  }
}

function sourceLines(source) {
  if (!source || source.length > 2 * 1024 * 1024) return null;
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g);
  if (!tokens) return null;
  const mixed = htmlSource(source) || tokens.some(token => !token.startsWith('<') && token.trim())
    || tokens.some(token => /^(?:<!--|<!\[CDATA\[|<\?)/.test(token) && token.includes('\n'));
  let depth = 0;
  const formatted = mixed ? source : tokens.filter(token => token.trim()).map(token => {
    if (token.startsWith('</')) depth = Math.max(0, depth - 1);
    const line = '  '.repeat(Math.min(depth, 128)) + token.trim();
    if (/^<[^!?/]/.test(token) && !token.endsWith('/>')) depth++;
    return line;
  }).join('\n');
  const lines = formatted.replace(/\n$/, '').split('\n');
  return lines.length <= 2000 ? lines : null;
}

function htmlSource(source) {
  return /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype\s+html(?:\s|>)|<html(?:\s|>))/i.test(source);
}

function lineDiff(previous, current) {
  const n = previous.length;
  const m = current.length;
  const lengths = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i][j] = previous[i] === current[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && previous[i] === current[j]) {
      rows.push({ previous: previous[i], current: current[j], before: ++i, after: ++j });
      continue;
    }
    const removed = [];
    const added = [];
    while ((i < n || j < m) && !(i < n && j < m && previous[i] === current[j])) {
      if (i < n && (j === m || lengths[i + 1][j] >= lengths[i][j + 1])) removed.push({ text: previous[i], number: ++i });
      else added.push({ text: current[j], number: ++j });
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push({ previous: removed[k]?.text, current: added[k]?.text, before: removed[k]?.number, after: added[k]?.number });
    }
  }
  return rows;
}

function renderDiff(previous, current) {
  screenshot($('previous-screenshot'), previous);
  screenshot($('current-screenshot'), current);
  if (!previous) {
    $('diff-summary').textContent = 'Record at least two actions to compare screens.';
    return;
  }
  const before = sourceLines(previous.source);
  const after = sourceLines(current.source);
  if (!before || !after || before.length + after.length > 2000) {
    $('diff-summary').textContent = 'Diff unavailable: page source is missing or exceeds the 2,000-line comparison limit.';
    return;
  }
  diffRows = lineDiff(before, after);
  const changes = diffRows.filter(row => row.previous !== row.current);
  const deleted = changes.filter(row => row.previous !== undefined).length;
  const added = changes.filter(row => row.current !== undefined).length;
  $('diff-summary').textContent = `+${added} inserted lines · −${deleted} deleted lines${changes.length ? '' : ' · No changes'}`;
  renderDiffRows();
}

function renderDiffRows() {
  const fragment = document.createDocumentFragment();
  for (const row of diffRows) {
    if ($('changes-only').checked && row.previous === row.current) continue;
    const changed = row.previous !== row.current;
    const kind = changed ? row.previous === undefined ? 'inserted' : row.current === undefined ? 'deleted' : 'modified' : 'equal';
    const tr = node('tr', undefined, kind);
    for (const value of [row.before, row.previous, row.after, row.current]) tr.append(node('td', value ?? ''));
    fragment.append(tr);
  }
  $('diff-rows').replaceChildren(fragment);
}

function renderJourney() {
  if (activeTab !== 'journey') return;
  const journey = actions.filter(action => action.actionKind !== 'find' && action.screenshotUrl);
  $('journey-summary').textContent = journey.length ? `${journey.length} captured screens. Select a screen to inspect its action.` : 'No journey screenshots available yet.';
  const fragment = document.createDocumentFragment();
  for (const action of journey) {
    const button = node('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(action.id === selectedId));
    const image = node('img');
    image.alt = `Action ${action.id} screenshot`;
    image.loading = 'lazy';
    screenshot(image, action);
    button.append(image, node('strong', `#${action.id} ${action.actionKind || action.method}`), node('p', action.elementInfo?.value || action.path));
    button.addEventListener('click', () => selectAction(action.id));
    fragment.append(button);
  }
  $('journey-list').replaceChildren(fragment);
}

for (const tab of ['inspect', 'diff', 'journey']) {
  $(`tab-${tab}`).addEventListener('click', () => {
    activeTab = tab;
    for (const name of ['inspect', 'diff', 'journey']) {
      $(name).hidden = name !== tab;
      $(`tab-${name}`).setAttribute('aria-selected', String(name === tab));
    }
    renderJourney();
  });
}
$('previous').addEventListener('click', () => selectAction(actions[currentIndex() - 1]?.id));
$('next').addEventListener('click', () => selectAction(actions[currentIndex() + 1]?.id));
$('follow').addEventListener('change', () => {
  if ($('follow').checked) selectAction(actions.at(-1)?.id, true);
});
$('clear').addEventListener('click', async () => {
  try {
    await jsonRequest('/_recorder/api/history', { method: 'DELETE' });
    actions = [];
    render();
    notice('History cleared.');
  } catch (error) { notice(`Could not clear history: ${error.message}`); }
});
$('query').addEventListener('submit', runQuery);
$('element-filter').addEventListener('input', () => renderElements());
$('actionable').addEventListener('change', () => renderElements());
$('changes-only').addEventListener('change', renderDiffRows);
$('copy-source').addEventListener('click', () => {
  if (displayedAction?.source) copyText(displayedAction.source);
});

const stream = new EventSource('/_recorder/api/stream');
stream.onopen = () => { $('connection').textContent = 'Live'; };
stream.onerror = () => { $('connection').textContent = 'Reconnecting…'; };
stream.onmessage = event => {
  try {
    const update = JSON.parse(event.data);
    if (update.type === 'init' && Array.isArray(update.data) && update.data.every(validAction)) actions = update.data;
    else if (update.type === 'clear' && update.data === null) actions = [];
    else if (update.type === 'evict' && Array.isArray(update.data?.ids)) {
      const removed = new Set(update.data.ids);
      actions = actions.filter(action => !removed.has(action.id));
    } else if (update.type === 'interaction' && validAction(update.data)) {
      const index = actions.findIndex(action => action.id === update.data.id);
      if (index < 0) actions.push(update.data);
      else actions[index] = update.data;
    } else throw new Error('Invalid recorder event');
    actions = actions.slice(-500);
    if ($('follow').checked) selectedId = actions.at(-1)?.id;
    render();
  } catch (error) { notice(`Recorder stream error: ${error.message}`); }
};
window.addEventListener('pagehide', () => {
  stream.close();
  selectionRequest.abort();
  elementRequest.abort();
  queryRequest.abort();
});
render();
