import { type Component, createSignal, Show, For, createEffect, onCleanup, createMemo } from 'solid-js';
import type { Interaction } from '../types';
import { parseXmlDocument, type ParsedXmlDocument } from '../utils/xml-parser';
import { DiffPanel } from './DiffPanel';
import { JourneyPanel } from './JourneyPanel';
import { SelectorStability } from './SelectorStability';
import { compileCandidateMatcher } from '../../../core/selectors/score-candidates';
import { generateSelectorCandidates } from '../../../core/selectors/generate-candidates';
import type { SelectorCandidate, SelectorStrategy } from '../../../core/types';
import type { ParsedElement } from '../types';
import './MainInspector.css';

const QUERY_STRATEGIES: readonly SelectorStrategy[] = [
    'accessibility id',
    'id',
    'xpath',
    'class name',
    '-ios predicate string',
    '-ios class chain',
    '-android uiautomator',
];
const MAX_INSPECTOR_SOURCE_CHARS = 512 * 1024;

type MainInspectorProps = {
    interaction: Interaction | null;
    previousInteraction?: Interaction;
    allActions?: Interaction[];
    currentIndex?: number;
    onSelectAction?: (index: number) => void;
    detailsState?: 'loading' | 'error';
    previousDetailsState?: 'loading' | 'error';
    onRetryDetails?: () => void;
};

export const MainInspector: Component<MainInspectorProps> = (props) => {
    const [selectedElement, setSelectedElement] = createSignal<ParsedElement | null>(null);
    const [queryStrategy, setQueryStrategy] = createSignal<SelectorStrategy>('accessibility id');
    const [queryValue, setQueryValue] = createSignal('');
    const [foundElements, setFoundElements] = createSignal<ParsedElement[]>([]);
    const [copiedText, setCopiedText] = createSignal<string | null>(null);
    const [queryError, setQueryError] = createSignal<string | null>(null);
    const [activeTab, setActiveTab] = createSignal<'inspect' | 'diff' | 'journey'>('inspect');
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;

    createEffect(() => {
        if (props.interaction) {
            setSelectedElement(null);
            setQueryValue('');
            setFoundElements([]);
            setQueryError(null);
        }
    });

    const parsedSource = createMemo<ParsedXmlDocument | null>(() => {
        if (!props.interaction?.source || props.interaction.source.length > MAX_INSPECTOR_SOURCE_CHARS) return null;
        return parseXmlDocument(props.interaction.source);
    });

    const parsedElements = () => parsedSource()?.elements ?? [];

    const futureActions = createMemo(() => {
        const all = props.allActions ?? [];
        const idx = props.currentIndex ?? -1;
        if (idx < 0 || idx >= all.length) return [];
        return all.slice(idx + 1);
    });

    const runQuery = () => {
        const strategy = queryStrategy();
        const value = queryValue();

        setQueryError(null);
        setSelectedElement(null);
        setFoundElements([]);

        if (!value.trim()) return;

        const elements = parsedElements();
        let found: ParsedElement[] = [];

        if (strategy === 'xpath') {
            const doc = parsedSource()?.doc;
            if (doc) {
                try {
                    const result = doc.evaluate(value, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                    const matchedNodes = new Set<Node>();
                    for (let i = 0; i < result.snapshotLength; i++) {
                        const node = result.snapshotItem(i);
                        if (node?.nodeType === 1) matchedNodes.add(node);
                    }
                    found = elements.filter(element => matchedNodes.has(element.node));
                } catch {
                    setQueryError(`Invalid XPath: "${value}"`);
                    return;
                }
            }
        } else {
            const platform = elements.find(element => element.platform !== 'unknown')?.platform ?? 'generic';
            const matches = compileCandidateMatcher({ strategy, value, platform });
            found = elements.filter(matches);
        }

        setFoundElements(found);
        if (found.length > 0) {
            setSelectedElement(found[0]);
            setQueryError(null);
        } else {
            setSelectedElement(null);
            setQueryError(`No elements found for ${strategy}: "${value}"`);
        }
    };

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedText(text);
            if (copiedTimer) clearTimeout(copiedTimer);
            copiedTimer = setTimeout(() => setCopiedText(null), 2000);
        } catch {
            setCopiedText(null);
        }
    };
    onCleanup(() => {
        if (copiedTimer) clearTimeout(copiedTimer);
    });

    const locators = createMemo<SelectorCandidate[]>(() => {
        const el = selectedElement();
        return el ? generateSelectorCandidates(el) : [];
    });

    return (
        <div class="main-inspector">
            <Show
                when={props.interaction}
                fallback={
                    <div class="inspector-empty">
                        <div class="inspector-empty-content">
                            <span class="inspector-empty-icon">🔍</span>
                            <span class="inspector-empty-text">Select an action to inspect</span>
                        </div>
                    </div>
                }
            >
                <div class="inspector-tabs">
                    <button
                        class="inspector-tab"
                        classList={{ active: activeTab() === 'inspect' }}
                        onClick={() => setActiveTab('inspect')}
                    >
                        Inspect
                    </button>
                    <button
                        class="inspector-tab"
                        classList={{ active: activeTab() === 'diff' }}
                        onClick={() => setActiveTab('diff')}
                    >
                        Diff
                    </button>
                    <button
                        class="inspector-tab"
                        classList={{ active: activeTab() === 'journey' }}
                        onClick={() => setActiveTab('journey')}
                    >
                        Journey
                    </button>
                </div>

                <Show when={activeTab() === 'inspect'}>
                    <Show when={props.interaction!.detailsTruncated}>
                        <div class="capture-unavailable">
                            <Show
                                when={props.detailsState !== 'error'}
                                fallback={(
                                    <>
                                        Interaction details unavailable.
                                        <button type="button" onClick={props.onRetryDetails}>Retry</button>
                                    </>
                                )}
                            >
                                Loading interaction details…
                            </Show>
                        </div>
                    </Show>
                    <div class="query-section">
                        <h3 class="section-title">Query Tester</h3>
                        <div class="query-row">
                            <select
                                value={queryStrategy()}
                                onChange={(event) => {
                                    const strategy = QUERY_STRATEGIES.find(
                                        candidate => candidate === event.currentTarget.value,
                                    );
                                    if (strategy) setQueryStrategy(strategy);
                                }}
                                class="query-select"
                            >
                                <For each={QUERY_STRATEGIES}>
                                    {(strategy) => <option value={strategy}>{strategy}</option>}
                                </For>
                            </select>
                            <input
                                type="text"
                                value={queryValue()}
                                onInput={(e) => setQueryValue(e.currentTarget.value)}
                                onKeyDown={(e) => e.key === 'Enter' && runQuery()}
                                placeholder="Enter locator value..."
                                class="query-input"
                            />
                            <button onClick={runQuery} class="query-btn">
                                Find
                            </button>
                        </div>

                        <Show when={foundElements().length > 0}>
                            <div class="query-result success">
                                Found {foundElements().length} element(s)
                            </div>
                        </Show>

                        <Show when={queryError()}>
                            <div class="query-result error">
                                <span class="error-icon">⚠️</span>
                                <span>{queryError()}</span>
                                <button class="error-dismiss" onClick={() => setQueryError(null)}>✕</button>
                            </div>
                        </Show>

                        <Show when={selectedElement()}>
                            <div class="element-panel">
                                <div class="element-details">
                                    <div class="element-attr">
                                        <span class="attr-name">Type:</span>
                                        <span class="attr-value">{selectedElement()!.type}</span>
                                    </div>
                                    <Show when={selectedElement()!.name}>
                                        <div class="element-attr">
                                            <span class="attr-name">Name:</span>
                                            <span class="attr-value">{selectedElement()!.name}</span>
                                        </div>
                                    </Show>
                                    <Show when={selectedElement()!.label}>
                                        <div class="element-attr">
                                            <span class="attr-name">Label:</span>
                                            <span class="attr-value">{selectedElement()!.label}</span>
                                        </div>
                                    </Show>
                                    <div class="element-attr">
                                        <span class="attr-name">Bounds:</span>
                                        <span class="attr-value">
                                            x={selectedElement()!.x}, y={selectedElement()!.y},
                                            w={selectedElement()!.width}, h={selectedElement()!.height}
                                        </span>
                                    </div>
                                </div>

                                <div class="locators-section">
                                    <h4>Locators (click to copy)</h4>
                                    <div class="locators-list">
                                        <For each={locators()}>
                                            {(locator) => (
                                                <div
                                                    class="locator-row"
                                                    classList={{ copied: copiedText() === locator.value }}
                                                    onClick={() => copyText(locator.value)}
                                                >
                                                    <span class="locator-strategy">{locator.strategy}</span>
                                                    <span class="locator-value">{locator.value}</span>
                                                    <Show when={copiedText() === locator.value}>
                                                        <span class="copied-badge">Copied!</span>
                                                    </Show>
                                                </div>
                                            )}
                                        </For>
                                    </div>

                                    <SelectorStability
                                        selectedElement={selectedElement()}
                                        locators={locators()}
                                        futureActions={futureActions()}
                                    />
                                </div>
                            </div>
                        </Show>
                    </div>

                    <div class="content-area">
                        <div class="screenshot-section">
                            <Show
                                when={props.interaction!.screenshotUrl}
                                fallback={
                                    <div class="capture-unavailable">
                                        Screenshot {props.interaction!.captureStatus === 'pending' ? 'pending' : 'unavailable'}
                                    </div>
                                }
                            >
                                <img
                                    src={props.interaction!.screenshotUrl}
                                    alt="Screenshot"
                                    class="screenshot-image"
                                />
                            </Show>
                        </div>

                        <div class="xml-section">
                            <h3 class="section-title">Page Source</h3>
                            <Show
                                when={!props.interaction!.detailsTruncated}
                                fallback={<div class="capture-unavailable">Interaction details are required to view page source.</div>}
                            >
                                <Show
                                    when={(props.interaction!.source?.length ?? 0) <= MAX_INSPECTOR_SOURCE_CHARS}
                                    fallback={<div class="capture-unavailable">Page source is too large to display or inspect.</div>}
                                >
                                    <pre class="xml-source">{props.interaction!.source ?? ''}</pre>
                                </Show>
                            </Show>
                        </div>
                    </div>
                </Show>

                <Show when={activeTab() === 'diff'}>
                    <Show when={props.previousInteraction?.detailsTruncated}>
                        <div class="capture-unavailable">
                            <Show
                                when={props.previousDetailsState !== 'error'}
                                fallback={(
                                    <>
                                        Previous interaction details unavailable.
                                        <button type="button" onClick={props.onRetryDetails}>Retry</button>
                                    </>
                                )}
                            >
                                Loading previous interaction details…
                            </Show>
                        </div>
                    </Show>
                    <DiffPanel
                        current={props.interaction!}
                        previous={props.previousInteraction}
                    />
                </Show>

                <Show when={activeTab() === 'journey'}>
                    <JourneyPanel
                        actions={props.allActions ?? []}
                        currentIndex={props.currentIndex ?? 0}
                        onSelectAction={props.onSelectAction}
                    />
                </Show>
            </Show>
        </div>
    );
};
