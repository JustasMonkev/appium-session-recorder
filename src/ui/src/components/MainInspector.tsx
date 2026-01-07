import { type Component, createSignal, Show, For, createEffect, createRenderEffect, onCleanup } from 'solid-js';
import type { Interaction } from '../types';
import { parseXmlSource } from '../utils/xml-parser';
import { generateLocators } from '../utils/locators';
import type { ParsedElement, Locator } from '../types';
import './MainInspector.css';

type MainInspectorProps = {
    interaction: Interaction | null;
};

export const MainInspector: Component<MainInspectorProps> = (props) => {
    const [selectedElement, setSelectedElement] = createSignal<ParsedElement | null>(null);
    const [queryStrategy, setQueryStrategy] = createSignal('accessibility id');
    const [queryValue, setQueryValue] = createSignal('');
    const [foundElements, setFoundElements] = createSignal<ParsedElement[]>([]);
    const [copiedText, setCopiedText] = createSignal<string | null>(null);
    const [queryError, setQueryError] = createSignal<string | null>(null);
    const [xmlPreRef, setXmlPreRef] = createSignal<HTMLPreElement | undefined>(undefined);

    // Reset state when interaction changes
    createEffect(() => {
        if (props.interaction) {
            setSelectedElement(null);
            setQueryValue('');
            setFoundElements([]);
        }
    });

    const parsedElements = () => {
        if (!props.interaction?.source) return [];
        return parseXmlSource(props.interaction.source);
    };

    const runQuery = () => {
        const strategy = queryStrategy();
        const value = queryValue().trim();

        setQueryError(null);

        if (!value) return;

        const elements = parsedElements();
        let found: ParsedElement[] = [];

        switch (strategy) {
            case 'accessibility id':
                found = elements.filter(el => el.name === value || el.label === value);
                break;
            case 'class name':
                found = elements.filter(el => el.type === value);
                break;
            case 'xpath':
                if (props.interaction?.source) {
                    try {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(props.interaction.source, 'text/xml');
                        const result = doc.evaluate(value, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                        const matchedNodes: Element[] = [];
                        for (let i = 0; i < result.snapshotLength; i++) {
                            const node = result.snapshotItem(i);
                            if (node && node.nodeType === 1) {
                                matchedNodes.push(node as Element);
                            }
                        }
                        found = elements.filter(el => matchedNodes.some(node => el.node.isEqualNode(node)));
                    } catch (e) {
                        console.error('Invalid XPath expression:', e);
                    }
                }
                break;
            case '-ios predicate string':
                found = elements.filter(el => {
                    const predicateLower = value.toLowerCase();
                    if (predicateLower.includes('name')) {
                        const match = value.match(/name\s*(==|CONTAINS)\s*['"](.*)['"]/i);
                        if (match) {
                            return match[1] === '==' ? el.name === match[2] : el.name.includes(match[2]);
                        }
                    }
                    if (predicateLower.includes('label')) {
                        const match = value.match(/label\s*(==|CONTAINS)\s*['"](.*)['"]/i);
                        if (match) {
                            return match[1] === '==' ? el.label === match[2] : el.label.includes(match[2]);
                        }
                    }
                    if (predicateLower.includes('type')) {
                        const match = value.match(/type\s*(==|CONTAINS)\s*['"](.*)['"]/i);
                        if (match) {
                            return match[1] === '==' ? el.type === match[2] : el.type.includes(match[2]);
                        }
                    }
                    return false;
                });
                break;
            case '-ios class chain':
                const classChainMatch = value.match(/\*\*\/(\w+)(?:\[`(.+?)`\])?/);
                if (classChainMatch) {
                    const targetType = classChainMatch[1];
                    const predicate = classChainMatch[2];
                    found = elements.filter(el => {
                        if (el.type !== targetType) return false;
                        if (!predicate) return true;
                        const nameMatch = predicate.match(/name\s*==\s*['"](.*)['"]/i);
                        if (nameMatch) return el.name === nameMatch[1];
                        const labelMatch = predicate.match(/label\s*==\s*['"](.*)['"]/i);
                        if (labelMatch) return el.label === labelMatch[1];
                        return true;
                    });
                }
                break;
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

    const copyText = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopiedText(text);
        setTimeout(() => setCopiedText(null), 2000);
    };

    const locators = (): Locator[] => {
        const el = selectedElement();
        return el ? generateLocators(el) : [];
    };

    const formatXml = (xml: string) => {
        // Simple XML formatting for better readability
        let formatted = '';
        let indent = 0;
        const lines = xml.replace(/></g, '>\n<').split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('</')) {
                indent = Math.max(0, indent - 1);
            }

            formatted += '  '.repeat(indent) + trimmed + '\n';

            if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.includes('</')) {
                indent++;
            }
        }

        return formatted;
    };

    // Defense-in-depth: render XML as textContent (never HTML)
    createRenderEffect(() => {
        const el = xmlPreRef();
        if (!el) return;
        el.textContent = formatXml(props.interaction?.source || '');
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
                {/* Query Tester Section */}
                <div class="query-section">
                    <h3 class="section-title">Query Tester</h3>
                    <div class="query-row">
                        <select
                            value={queryStrategy()}
                            onChange={(e) => setQueryStrategy(e.currentTarget.value)}
                            class="query-select"
                        >
                            <option value="accessibility id">accessibility id</option>
                            <option value="xpath">xpath</option>
                            <option value="class name">class name</option>
                            <option value="-ios predicate string">-ios predicate string</option>
                            <option value="-ios class chain">-ios class chain</option>
                        </select>
                        <input
                            type="text"
                            value={queryValue()}
                            onInput={(e) => setQueryValue(e.currentTarget.value)}
                            onKeyPress={(e) => e.key === 'Enter' && runQuery()}
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

                    {/* Element Details */}
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
                            </div>
                        </div>
                    </Show>
                </div>

                {/* Content Area: Screenshot Left, XML Right */}
                <div class="content-area">
                    {/* Screenshot Section */}
                    <div class="screenshot-section">
                        <Show when={props.interaction!.screenshot}>
                            <img
                                src={`data:image/png;base64,${props.interaction!.screenshot}`}
                                alt="Screenshot"
                                class="screenshot-image"
                            />
                        </Show>
                    </div>

	                    {/* XML Source Section */}
	                    <div class="xml-section">
	                        <h3 class="section-title">XML Source</h3>
	                        <pre
	                            ref={(el) => {
	                                setXmlPreRef(el);
	                                onCleanup(() => {
	                                    setXmlPreRef(undefined);
	                                });
	                            }}
	                            class="xml-source"
	                        />
	                    </div>
	                </div>
	            </Show>
	        </div>
	    );
};
