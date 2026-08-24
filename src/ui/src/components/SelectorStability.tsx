import { type Component, createMemo, Show, For } from 'solid-js';
import type { Interaction, ParsedElement } from '../types';
import type { SelectorCandidate } from '../../../core/types';
import { getParsedElements } from '../utils/xml-parser';
import {
    evaluateSelectorStability,
    MAX_STABILITY_ELEMENTS,
    MAX_STABILITY_SNAPSHOTS,
    MAX_STABILITY_SOURCE_CHARS,
} from '../../../core/selectors/selector-stability';
import { inspectPageSource } from '../../../core/xml/xml-limits';
import './SelectorStability.css';

type SelectorStabilityProps = {
    selectedElement: ParsedElement | null;
    locators: SelectorCandidate[];
    futureActions: Interaction[];
};

type StabilityRow = {
    strategy: string;
    value: string;
    stableSteps: number;
    firstFailureStep: number;
    totalSteps: number;
};

export const SelectorStability: Component<SelectorStabilityProps> = (props) => {
    const snapshotReport = createMemo(() => {
        const eligible = props.futureActions.filter(action => action.source || action.detailsTruncated);
        const snapshots: ParsedElement[][] = [];
        let elementCount = 0;
        let sourceChars = 0;
        for (const action of eligible) {
            if (snapshots.length >= MAX_STABILITY_SNAPSHOTS) break;
            if (!action.source || sourceChars + action.source.length > MAX_STABILITY_SOURCE_CHARS) break;
            const estimatedElements = inspectPageSource(action.source)?.elementCount ?? MAX_STABILITY_ELEMENTS + 1;
            if (elementCount + estimatedElements > MAX_STABILITY_ELEMENTS) break;
            const elements = getParsedElements(action);
            if (elementCount + elements.length > MAX_STABILITY_ELEMENTS) break;
            snapshots.push(elements);
            elementCount += elements.length;
            sourceChars += action.source.length;
        }
        return {
            snapshots,
            eligibleCount: eligible.length,
            truncated: snapshots.length < eligible.length,
        };
    });

    const stabilityRows = createMemo((): StabilityRow[] => {
        const selectedElement = props.selectedElement;
        if (!selectedElement || props.locators.length === 0) {
            return [];
        }

        const parsedSnapshots = snapshotReport().snapshots;
        if (parsedSnapshots.length === 0) return [];

        return evaluateSelectorStability(props.locators, parsedSnapshots).results.map(result => {
            return {
                strategy: result.candidate.strategy,
                value: result.candidate.value,
                stableSteps: result.stableSteps,
                firstFailureStep: result.firstFailureStep,
                totalSteps: result.totalSteps,
            };
        });
    });

    const bestRow = createMemo(() => {
        const rows = stabilityRows();
        return rows.length > 0 && rows[0].stableSteps > 0 ? rows[0] : null;
    });

    return (
        <Show when={stabilityRows().length > 0 || snapshotReport().truncated}>
            <div class="selector-stability">
                <h4 class="stability-title">Selector Stability</h4>
                <Show when={bestRow()}>
                    <div class="stability-best">
                        Best: <code>{bestRow()!.strategy}</code> — stable for {bestRow()!.stableSteps}/{bestRow()!.totalSteps} steps
                    </div>
                </Show>
                <Show when={snapshotReport().truncated}>
                    <div class="stability-best">
                        Analysis limited to {snapshotReport().snapshots.length}/{snapshotReport().eligibleCount} future screens.
                    </div>
                </Show>
                <Show when={stabilityRows().length > 0}>
                    <div class="stability-table">
                        <div class="stability-header">
                            <span class="stability-col-strategy">Strategy</span>
                            <span class="stability-col-value">Value</span>
                            <span class="stability-col-stable">Stable</span>
                            <span class="stability-col-fail">First Fail</span>
                        </div>
                        <For each={stabilityRows()}>
                            {(row) => (
                                <div
                                    class="stability-row"
                                    classList={{
                                        'stability-row-good': row.firstFailureStep === 0,
                                        'stability-row-warn': row.firstFailureStep > 0 && row.stableSteps > 0,
                                        'stability-row-bad': row.stableSteps === 0,
                                    }}
                                >
                                    <span class="stability-col-strategy">{row.strategy}</span>
                                    <span class="stability-col-value" title={row.value}>{row.value}</span>
                                    <span class="stability-col-stable">{row.stableSteps}/{row.totalSteps}</span>
                                    <span class="stability-col-fail">
                                        {row.firstFailureStep === 0 ? '—' : `Step ${row.firstFailureStep}`}
                                    </span>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </div>
        </Show>
    );
};
