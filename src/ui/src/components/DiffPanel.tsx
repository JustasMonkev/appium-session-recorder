import { type Component, createMemo, createSignal, For, Show } from 'solid-js';
import type { DiffRow, Interaction, DiffSummary } from '../types';
import { computeDiffSummary } from '../utils/diff';
import './DiffPanel.css';

type DiffPanelProps = {
    current: Interaction;
    previous: Interaction | undefined;
};

export const DiffPanel: Component<DiffPanelProps> = (props) => {
    const [changesOnly, setChangesOnly] = createSignal(true);
    const [copiedSide, setCopiedSide] = createSignal<'previous' | 'current' | null>(null);

    const diffSummary = createMemo((): DiffSummary | null => {
        if (!props.previous) return null;
        return computeDiffSummary(props.previous.source, props.current.source);
    });

    const hasChanges = createMemo<boolean>(() => {
        const summary = diffSummary();
        if (!summary) return false;
        return summary.changedLineCount > 0;
    });

    const visibleRows = createMemo<DiffRow[]>(() => {
        const summary = diffSummary();
        if (!summary) return [];
        return changesOnly()
            ? summary.rows.filter((row) => row.previousText !== row.currentText)
            : summary.rows;
    });

    const formatLineNumber = (value: number | null) => value == null ? '' : String(value);
    const rowClassName = (row: DiffRow) => {
        if (row.previousText && row.currentText && row.previousText !== row.currentText) return 'diff-row diff-row-modified';
        if (row.previousText && !row.currentText) return 'diff-row diff-row-deleted';
        if (!row.previousText && row.currentText) return 'diff-row diff-row-inserted';
        return 'diff-row diff-row-equal';
    };
    const formatXmlForCopy = (xml: string | undefined) => {
        if (!xml) return '';

        let formatted = '';
        let indent = 0;
        const lines = xml.replace(/></g, '>\n<').split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('</')) {
                indent = Math.max(0, indent - 1);
            }

            formatted += `${'  '.repeat(indent)}${trimmed}\n`;

            if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.includes('</')) {
                indent++;
            }
        }

        return formatted;
    };
    const copyXml = async (side: 'previous' | 'current') => {
        const xml = side === 'previous' ? props.previous?.source : props.current.source;
        if (!xml) return;

        await navigator.clipboard.writeText(formatXmlForCopy(xml));
        setCopiedSide(side);
        setTimeout(() => setCopiedSide((value) => value === side ? null : value), 2000);
    };

    return (
        <div class="diff-panel">
            <div class="diff-header">
                <div>
                    <h3 class="section-title">Diff (Previous → Current)</h3>
                    <Show when={diffSummary()}>
                        <div class="diff-subtitle">
                            {diffSummary()!.changedLineCount} changed line{diffSummary()!.changedLineCount === 1 ? '' : 's'}
                        </div>
                    </Show>
                </div>
                <Show when={hasChanges()}>
                    <div class="diff-controls">
                        <button
                            type="button"
                            class="diff-toggle"
                            classList={{ active: changesOnly() }}
                            onClick={() => setChangesOnly(true)}
                        >
                            Changes Only
                        </button>
                        <button
                            type="button"
                            class="diff-toggle"
                            classList={{ active: !changesOnly() }}
                            onClick={() => setChangesOnly(false)}
                        >
                            Full Context
                        </button>
                    </div>
                </Show>
            </div>

            <Show when={props.previous}>
                <div class="diff-preview-grid">
                    <div class="diff-preview-card">
                        <div class="diff-label">Previous</div>
                        <Show when={props.previous!.screenshot}>
                            <img
                                src={`data:image/png;base64,${props.previous!.screenshot}`}
                                alt="Previous screenshot"
                                class="diff-screenshot-img"
                            />
                        </Show>
                    </div>
                    <div class="diff-preview-card">
                        <div class="diff-label">Current</div>
                        <Show when={props.current.screenshot}>
                            <img
                                src={`data:image/png;base64,${props.current.screenshot}`}
                                alt="Current screenshot"
                                class="diff-screenshot-img"
                            />
                        </Show>
                    </div>
                </div>
            </Show>

            <Show when={diffSummary()}>
                <div class="diff-stats">
                    <span class="diff-stat">
                        Elements: {diffSummary()!.prevElementCount} → {diffSummary()!.currElementCount}
                    </span>
                    <span
                        class="diff-stat"
                        classList={{
                            'diff-stat-positive': diffSummary()!.elementCountDelta > 0,
                            'diff-stat-negative': diffSummary()!.elementCountDelta < 0,
                        }}
                    >
                        ({diffSummary()!.elementCountDelta >= 0 ? '+' : ''}{diffSummary()!.elementCountDelta})
                    </span>
                    <span class="diff-stat diff-stat-insert">
                        +{diffSummary()!.insertedLineCount} added
                    </span>
                    <span class="diff-stat diff-stat-delete">
                        -{diffSummary()!.deletedLineCount} removed
                    </span>
                </div>
            </Show>

            <Show when={!props.previous}>
                <div class="diff-empty">No previous action to compare with.</div>
            </Show>

            <Show when={props.previous && !hasChanges()}>
                <div class="diff-empty">No XML changes between steps.</div>
            </Show>

            <Show when={props.previous && hasChanges()}>
                <div class="diff-source">
                    <div class="diff-source-toolbar">
                        <div class="diff-copy-group">
                            <button
                                type="button"
                                class="diff-copy-btn"
                                onClick={() => void copyXml('previous')}
                            >
                                {copiedSide() === 'previous' ? 'Copied Previous XML' : 'Copy Previous XML'}
                            </button>
                            <button
                                type="button"
                                class="diff-copy-btn"
                                onClick={() => void copyXml('current')}
                            >
                                {copiedSide() === 'current' ? 'Copied Current XML' : 'Copy Current XML'}
                            </button>
                        </div>
                    </div>
                    <div class="diff-source-head">
                        <span>Prev</span>
                        <span>Previous XML</span>
                        <span>Curr</span>
                        <span>Current XML</span>
                    </div>
                    <div class="diff-source-body">
                        <For each={visibleRows()}>
                            {(row) => (
                                <div class={rowClassName(row)}>
                                    <span class="diff-line-number">{formatLineNumber(row.previousLineNumber)}</span>
                                    <code class="diff-line-text diff-line-text-prev">{row.previousText ?? ''}</code>
                                    <span class="diff-line-number">{formatLineNumber(row.currentLineNumber)}</span>
                                    <code class="diff-line-text diff-line-text-curr">{row.currentText ?? ''}</code>
                                </div>
                            )}
                        </For>
                    </div>
                </div>
            </Show>
        </div>
    );
};
