import { type Component, createMemo, Show, For } from 'solid-js';
import type { Interaction, ParsedElement, Locator } from '../types';
import { parseXmlSource } from '../utils/xml-parser';
import './SelectorStability.css';

type SelectorStabilityProps = {
    selectedElement: ParsedElement | null;
    locators: Locator[];
    /** All recorded actions (with source), starting from the current action forward */
    futureActions: Interaction[];
};

type StabilityRow = {
    strategy: string;
    value: string;
    stableSteps: number;
    firstFailureStep: number;
    totalSteps: number;
};

function matchLocator(strategy: string, value: string, elements: ParsedElement[]): number {
    switch (strategy) {
        case 'accessibility id':
            return elements.filter(el => el.name === value || el.label === value).length;
        case 'class name':
            return elements.filter(el => el.type === value).length;
        case 'xpath':
            // Can't evaluate arbitrary xpath in this context without DOMParser per snapshot
            // Fall back to exact xpath match
            return elements.filter(el => el.xpath === value).length;
        case '-ios predicate string': {
            const eqMatch = value.match(/(name|label|type)\s*==\s*['"](.+?)['"]/i);
            if (eqMatch) {
                const [, field, expected] = eqMatch;
                return elements.filter(el => {
                    if (field === 'name') return el.name === expected;
                    if (field === 'label') return el.label === expected;
                    return el.type === expected;
                }).length;
            }
            return 0;
        }
        case '-ios class chain': {
            const ccMatch = value.match(/\*\*\/(\w+)(?:\[`(.+?)`\])?/);
            if (!ccMatch) return 0;
            const targetType = ccMatch[1];
            const predicate = ccMatch[2];
            return elements.filter(el => {
                if (el.type !== targetType) return false;
                if (!predicate) return true;
                const nameMatch = predicate.match(/name\s*==\s*['"](.*)['"]/i);
                if (nameMatch) return el.name === nameMatch[1];
                const labelMatch = predicate.match(/label\s*==\s*['"](.*)['"]/i);
                if (labelMatch) return el.label === labelMatch[1];
                return true;
            }).length;
        }
        default:
            return 0;
    }
}

export const SelectorStability: Component<SelectorStabilityProps> = (props) => {
    const stabilityRows = createMemo((): StabilityRow[] => {
        if (!props.selectedElement || props.locators.length === 0 || props.futureActions.length === 0) {
            return [];
        }

        // Parse all future action sources into element lists
        const snapshots = props.futureActions
            .filter(a => a.source)
            .map(a => parseXmlSource(a.source!));

        if (snapshots.length === 0) return [];

        return props.locators.map(locator => {
            let stableSteps = 0;
            let firstFailureStep = 0;

            for (let i = 0; i < snapshots.length; i++) {
                const matchCount = matchLocator(locator.strategy, locator.value, snapshots[i]);
                if (matchCount === 1) {
                    stableSteps++;
                } else if (firstFailureStep === 0) {
                    firstFailureStep = i + 1;
                }
            }

            return {
                strategy: locator.strategy,
                value: locator.value,
                stableSteps,
                firstFailureStep,
                totalSteps: snapshots.length,
            };
        }).sort((a, b) => b.stableSteps - a.stableSteps);
    });

    const bestRow = createMemo(() => {
        const rows = stabilityRows();
        return rows.length > 0 && rows[0].stableSteps > 0 ? rows[0] : null;
    });

    return (
        <Show when={stabilityRows().length > 0}>
            <div class="selector-stability">
                <h4 class="stability-title">Selector Stability</h4>
                <Show when={bestRow()}>
                    <div class="stability-best">
                        Best: <code>{bestRow()!.strategy}</code> — stable for {bestRow()!.stableSteps}/{bestRow()!.totalSteps} steps
                    </div>
                </Show>
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
            </div>
        </Show>
    );
};
