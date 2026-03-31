import { type Component, createMemo, Show, createRenderEffect, createSignal, onCleanup } from 'solid-js';
import type { Interaction, DiffSummary } from '../types';
import { computeDiffSummary } from '../utils/diff';
import './DiffPanel.css';

type DiffPanelProps = {
    current: Interaction;
    previous: Interaction | undefined;
};

export const DiffPanel: Component<DiffPanelProps> = (props) => {
    const [diffPreRef, setDiffPreRef] = createSignal<HTMLPreElement | undefined>(undefined);

    const diffSummary = createMemo((): DiffSummary | null => {
        if (!props.previous) return null;
        return computeDiffSummary(props.previous.source, props.current.source);
    });

    const hasChanges = createMemo(() => {
        const summary = diffSummary();
        if (!summary) return false;
        return summary.segments.some(s => s.type !== 'equal');
    });

    // Render diff as colored text spans using textContent-safe approach
    createRenderEffect(() => {
        const el = diffPreRef();
        if (!el) return;

        // Clear previous content
        el.textContent = '';

        const summary = diffSummary();
        if (!summary) {
            el.textContent = 'No previous action to compare with.';
            return;
        }

        if (!hasChanges()) {
            el.textContent = 'No XML changes between steps.';
            return;
        }

        for (const segment of summary.segments) {
            const span = document.createElement('span');
            span.textContent = segment.text;

            if (segment.type === 'insert') {
                span.className = 'diff-insert';
            } else if (segment.type === 'delete') {
                span.className = 'diff-delete';
            }

            el.appendChild(span);
        }
    });

    return (
        <div class="diff-panel">
            <h3 class="section-title">Diff (Previous → Current)</h3>

            {/* Screenshot Comparison */}
            <Show when={props.previous}>
                <div class="diff-screenshots">
                    <div class="diff-screenshot-col">
                        <span class="diff-label">Previous</span>
                        <Show when={props.previous!.screenshot}>
                            <img
                                src={`data:image/png;base64,${props.previous!.screenshot}`}
                                alt="Previous screenshot"
                                class="diff-screenshot-img"
                            />
                        </Show>
                    </div>
                    <div class="diff-screenshot-col">
                        <span class="diff-label">Current</span>
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

            {/* Summary Counts */}
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
                </div>
            </Show>

            {/* XML Text Diff */}
            <pre
                ref={(el) => {
                    setDiffPreRef(el);
                    onCleanup(() => setDiffPreRef(undefined));
                }}
                class="diff-source"
            />
        </div>
    );
};
