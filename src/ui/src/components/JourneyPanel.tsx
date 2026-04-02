import { type Component, createMemo, For, Show } from 'solid-js';
import type { Interaction } from '../types';
import './JourneyPanel.css';

type JourneyPanelProps = {
    actions: Interaction[];
    currentIndex: number;
    onSelectAction?: (index: number) => void;
};

export const JourneyPanel: Component<JourneyPanelProps> = (props) => {
    const journeyActions = createMemo(() =>
        props.actions
            .map((action, originalIndex) => ({ action, originalIndex }))
            .filter(({ action }) => action.actionKind !== 'find')
    );

    const currentJourneyIndex = createMemo(() => {
        const entries = journeyActions();
        const activeEntryIndex = entries.findIndex((entry) => entry.originalIndex === props.currentIndex);

        if (activeEntryIndex >= 0) {
            return activeEntryIndex;
        }

        for (let index = entries.length - 1; index >= 0; index--) {
            if (entries[index].originalIndex < props.currentIndex) {
                return index;
            }
        }

        return entries.length > 0 ? 0 : -1;
    });

    const currentEntry = createMemo(() => {
        const index = currentJourneyIndex();
        return index >= 0 ? journeyActions()[index] : undefined;
    });

    const currentAction = createMemo(() => currentEntry()?.action);

    return (
        <div class="journey-panel">
            <Show
                when={currentAction()}
                fallback={<div class="journey-empty">No journey screenshots available yet.</div>}
            >
                <div class="journey-hero">
                    <div class="journey-hero-copy">
                        <div class="journey-kicker">Journey</div>
                        <h3 class="journey-title">Action {currentJourneyIndex() + 1} of {journeyActions().length}</h3>
                        <div class="journey-meta">
                            <span class="journey-chip">#{currentAction()!.id}</span>
                            <span class="journey-chip">{currentAction()!.method}</span>
                            <Show when={currentAction()!.actionKind}>
                                <span class="journey-chip">{currentAction()!.actionKind}</span>
                            </Show>
                        </div>
                        <div class="journey-path">{currentAction()!.path}</div>
                        <Show when={currentAction()!.elementInfo}>
                            <div class="journey-selector">
                                {currentAction()!.elementInfo!.using}: "{currentAction()!.elementInfo!.value}"
                            </div>
                        </Show>
                    </div>

                    <Show when={currentAction()!.screenshot}>
                        <div class="journey-hero-screen">
                            <img
                                src={`data:image/png;base64,${currentAction()!.screenshot}`}
                                alt={`Action ${currentJourneyIndex() + 1} screenshot`}
                                class="journey-hero-image"
                            />
                        </div>
                    </Show>
                </div>

                <div class="journey-strip-header">
                    <div>
                        <h4 class="journey-strip-title">All Screens</h4>
                        <div class="journey-strip-subtitle">Select any step to make it the active screen.</div>
                    </div>
                </div>

                <div class="journey-strip">
                    <For each={journeyActions()}>
                        {(entry, index) => (
                            <button
                                type="button"
                                class="journey-thumb"
                                classList={{ active: index() === currentJourneyIndex() }}
                                onClick={() => props.onSelectAction?.(entry.originalIndex)}
                            >
                                <div class="journey-thumb-frame">
                                    <Show when={entry.action.screenshot}>
                                        <img
                                            src={`data:image/png;base64,${entry.action.screenshot}`}
                                            alt={`Action ${index() + 1}`}
                                            class="journey-thumb-image"
                                        />
                                    </Show>
                                </div>
                                <div class="journey-thumb-meta">
                                    <span class="journey-thumb-index">#{index() + 1}</span>
                                    <span class="journey-thumb-kind">{entry.action.actionKind || entry.action.method}</span>
                                </div>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};
