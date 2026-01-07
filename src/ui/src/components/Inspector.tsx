import { type Component, createSignal, Show, For } from 'solid-js';
import { Dialog } from '@kobalte/core/dialog';
import type { Interaction } from '../types';
import { parseXmlSource } from '../utils/xml-parser';
import { generateLocators } from '../utils/locators';
import type { ParsedElement, Locator } from '../types';
import './Inspector.css';

type InspectorProps = {
    interaction: Interaction | null;
    open: boolean;
    onClose: () => void;
};

export const Inspector: Component<InspectorProps> = (props) => {
    const [selectedElement, setSelectedElement] = createSignal<ParsedElement | null>(null);
    const [queryStrategy, setQueryStrategy] = createSignal('accessibility id');
    const [queryValue, setQueryValue] = createSignal('');
    const [foundElements, setFoundElements] = createSignal<ParsedElement[]>([]);
    const [showSource, setShowSource] = createSignal(false);

    const parsedElements = () => {
        if (!props.interaction?.source) return [];
        return parseXmlSource(props.interaction.source);
    };

    const runQuery = () => {
        const strategy = queryStrategy();
        const value = queryValue().trim();

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
                // Properly evaluate XPath against the XML source
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
                        // Match found nodes back to parsed elements
                        found = elements.filter(el => matchedNodes.some(node => el.node.isEqualNode(node)));
                    } catch (e) {
                        console.error('Invalid XPath expression:', e);
                    }
                }
                break;
            case '-ios predicate string':
                // iOS predicate string matching (simplified attribute matching)
                found = elements.filter(el => {
                    // Parse simple predicates like "name == 'value'" or "label CONTAINS 'text'"
                    const predicateLower = value.toLowerCase();
                    if (predicateLower.includes('name')) {
                        const match = value.match(/name\s*(==|CONTAINS)\s*['"](.*)['"]/i);
                        if (match) {
                            return match[1] === '=='
                                ? el.name === match[2]
                                : el.name.includes(match[2]);
                        }
                    }
                    if (predicateLower.includes('label')) {
                        const match = value.match(/label\s*(==|CONTAINS)\s*['"](.*)['"]/i);
                        if (match) {
                            return match[1] === '=='
                                ? el.label === match[2]
                                : el.label.includes(match[2]);
                        }
                    }
                    if (predicateLower.includes('type')) {
                        const match = value.match(/type\s*(==|CONTAINS)\s*['"](.*)['"]/i);
                        if (match) {
                            return match[1] === '=='
                                ? el.type === match[2]
                                : el.type.includes(match[2]);
                        }
                    }
                    return false;
                });
                break;
            case '-ios class chain':
                // iOS class chain matching (simplified type/index matching)
                // Format: **/XCUIElementTypeButton[`name == "buttonName"`]
                const classChainMatch = value.match(/\*\*\/(\w+)(?:\[`(.+?)`\])?/);
                if (classChainMatch) {
                    const targetType = classChainMatch[1];
                    const predicate = classChainMatch[2];
                    found = elements.filter(el => {
                        if (el.type !== targetType) return false;
                        if (!predicate) return true;
                        // Simple predicate matching within class chain
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
        }
    };

    const copyText = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    const locators = (): Locator[] => {
        const el = selectedElement();
        return el ? generateLocators(el) : [];
    };

    const selectElement = (element: ParsedElement, e: MouseEvent) => {
        e.stopPropagation();
        setSelectedElement(element);
        setFoundElements([element]);
    };

    const resetState = () => {
        setSelectedElement(null);
        setQueryStrategy('accessibility id');
        setQueryValue('');
        setFoundElements([]);
        setShowSource(false);
    };

    const handleClose = () => {
        resetState();
        props.onClose();
    };

    return (
        <Dialog open={props.open} onOpenChange={(open) => !open && handleClose()}>
            <Dialog.Portal>
                <Dialog.Overlay class="inspector-overlay" />
                <Dialog.Content class="inspector-modal">
                    <Dialog.CloseButton class="inspector-close">✕</Dialog.CloseButton>

                    <div class="inspector-panel">
                        <div class="inspector-left">
                            <Show when={props.interaction?.screenshot}>
                                <img
                                    src={`data:image/png;base64,${props.interaction!.screenshot}`}
                                    alt="Screenshot"
                                    class="inspector-screenshot"
                                />
                            </Show>
                        </div>

                        <div class="inspector-right">
                            <div class="inspector-section">
                                <h3>Query Tester</h3>
                                <div class="query-tester">
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
                                </div>
                            </div>
                            <Show when={selectedElement()}>
                                <div class="inspector-section">
                                    <h3>Element Details</h3>
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
                                </div>

                                <div class="inspector-section">
                                    <h3>Locators (click to copy)</h3>
                                    <div class="locators-list">
                                        <For each={locators()}>
                                            {(locator) => (
                                                <div class="locator-row" onClick={() => copyText(locator.value)}>
                                                    <span class="locator-strategy">{locator.strategy}</span>
                                                    <span class="locator-value">{locator.value}</span>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                </div>
                            </Show>

                            {/* XML Source Toggle */}
                            <Show when={props.interaction?.source}>
                                <div class="inspector-section">
                                    <button
                                        class="source-toggle-btn"
                                        onClick={() => setShowSource(!showSource())}
                                    >
                                        {showSource() ? 'Hide' : 'Show'} XML Source
                                    </button>
                                    <Show when={showSource()}>
                                        <pre class="xml-source">{props.interaction!.source}</pre>
                                    </Show>
                                </div>
                            </Show>
                        </div>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog>
    );
};

