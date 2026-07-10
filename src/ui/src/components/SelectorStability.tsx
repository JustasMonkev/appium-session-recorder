import { type Component, createMemo, Show, For } from 'solid-js';
import type { Interaction, ParsedElement, Locator } from '../types';
import { getParsedElements } from '../utils/xml-parser';
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

type ElementMatcher = (el: ParsedElement) => boolean;

const neverMatches: ElementMatcher = () => false;

/**
 * Parse a locator once into a matcher so evaluating it across many snapshots
 * doesn't re-run the regex parsing for every snapshot.
 */
function compileLocatorMatcher(strategy: string, value: string): ElementMatcher {
    switch (strategy) {
        case 'accessibility id':
            return el => el.name === value || el.label === value;
        case 'class name':
            return el => el.type === value;
        case 'xpath':
            // Can't evaluate arbitrary xpath in this context without DOMParser per snapshot
            // Fall back to exact xpath match
            return el => el.xpath === value;
        case '-ios predicate string': {
            const eqMatch = value.match(/(name|label|type)\s*==\s*['"](.+?)['"]/i);
            if (!eqMatch) return neverMatches;
            const [, field, expected] = eqMatch;
            if (field === 'name') return el => el.name === expected;
            if (field === 'label') return el => el.label === expected;
            return el => el.type === expected;
        }
        case '-ios class chain': {
            const ccMatch = value.match(/\*\*\/(\w+)(?:\[`(.+?)`\])?/);
            if (!ccMatch) return neverMatches;
            const targetType = ccMatch[1];
            const predicate = ccMatch[2];
            if (!predicate) return el => el.type === targetType;
            const nameMatch = predicate.match(/name\s*==\s*['"](.*)['"]/i);
            const labelMatch = nameMatch ? null : predicate.match(/label\s*==\s*['"](.*)['"]/i);
            return el => {
                if (el.type !== targetType) return false;
                if (nameMatch) return el.name === nameMatch[1];
                if (labelMatch) return el.label === labelMatch[1];
                return true;
            };
        }
        default:
            return neverMatches;
    }
}

export const SelectorStability: Component<SelectorStabilityProps> = (props) => {
    // Parsed per interaction and cached (getParsedElements), and kept in a
    // separate memo so selecting a different element doesn't re-parse the
    // future snapshots — only the cheap matching below re-runs.
    const snapshots = createMemo<ParsedElement[][]>(() =>
        props.futureActions
            .filter(a => a.source)
            .map(a => getParsedElements(a))
    );

    const stabilityRows = createMemo((): StabilityRow[] => {
        if (!props.selectedElement || props.locators.length === 0) {
            return [];
        }

        const parsedSnapshots = snapshots();
        if (parsedSnapshots.length === 0) return [];

        return props.locators.map(locator => {
            let stableSteps = 0;
            let firstFailureStep = 0;
            const matches = compileLocatorMatcher(locator.strategy, locator.value);

            for (let i = 0; i < parsedSnapshots.length; i++) {
                let matchCount = 0;
                for (const el of parsedSnapshots[i]) {
                    if (matches(el)) matchCount++;
                }
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
                totalSteps: parsedSnapshots.length,
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
