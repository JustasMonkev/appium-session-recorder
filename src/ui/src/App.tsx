import { type Component, createSignal, createMemo, createEffect, onCleanup } from 'solid-js';
import { useInteractions } from './hooks/useInteractions';
import { ActionCarousel } from './components/ActionCarousel';
import { MainInspector } from './components/MainInspector';
import {
    MAX_STABILITY_ELEMENTS,
    MAX_STABILITY_SNAPSHOTS,
    MAX_STABILITY_SOURCE_CHARS,
} from '../../core/selectors/selector-stability';
import { inspectPageSource } from '../../core/xml/xml-limits';
import type { Interaction } from './types';
import './App.css';

const App: Component = () => {
    const { interactions: actions, hydrateInteraction } = useInteractions();
    const [selectedId, setSelectedId] = createSignal<number>();
    const [followLatest, setFollowLatest] = createSignal(true);
    const [detailStates, setDetailStates] = createSignal<Record<number, 'loading' | 'error'>>({});
    const [detailRetry, setDetailRetry] = createSignal(0);
    const detailRequests = new Map<number, { controller: AbortController; interaction: Interaction }>();

    const currentIndex = createMemo(() => {
        const list = actions();
        const index = list.findIndex(action => action.id === selectedId());
        return index >= 0 ? index : Math.max(0, list.length - 1);
    });
    const currentAction = createMemo(() => actions()[currentIndex()]);

    const previousAction = createMemo(() => {
        const idx = currentIndex();
        return idx > 0 ? actions()[idx - 1] : undefined;
    });

    createEffect(() => {
        detailRetry();
        const list = actions();
        const index = currentIndex();
        const futureTargets: Interaction[] = [];
        let sourceChars = 0;
        let elementCount = 0;
        for (const interaction of list.slice(index + 1)) {
            if (!interaction.source && !interaction.detailsTruncated) continue;
            if (futureTargets.length >= MAX_STABILITY_SNAPSHOTS) break;
            if (interaction.source) {
                if (sourceChars + interaction.source.length > MAX_STABILITY_SOURCE_CHARS) break;
                const count = inspectPageSource(interaction.source)?.elementCount;
                if (
                    count === undefined
                    || elementCount + count > MAX_STABILITY_ELEMENTS
                ) break;
                sourceChars += interaction.source.length;
                elementCount += count;
            }
            futureTargets.push(interaction);
            if (interaction.detailsTruncated) break;
        }
        const targets = [
            list[index],
            list[index - 1],
            ...futureTargets,
        ].filter((interaction): interaction is Interaction => interaction !== undefined);
        const detailTargetIds = new Set(
            targets.filter(interaction => interaction.detailsTruncated).map(interaction => interaction.id),
        );
        setDetailStates(states => {
            const entries = Object.entries(states).filter(([id]) => detailTargetIds.has(Number(id)));
            return entries.length === Object.keys(states).length ? states : Object.fromEntries(entries);
        });
        for (const [id, request] of detailRequests) {
            if (targets.find(interaction => interaction.id === id) === request.interaction) continue;
            request.controller.abort();
            detailRequests.delete(id);
        }
        for (const interaction of targets) {
            if (!interaction.detailsTruncated) continue;
            if (!interaction.detailsUrl) {
                setDetailStates(states => ({ ...states, [interaction.id]: 'error' }));
                continue;
            }
            if (detailRequests.has(interaction.id)) continue;
            const controller = new AbortController();
            detailRequests.set(interaction.id, { controller, interaction });
            setDetailStates(states => ({ ...states, [interaction.id]: 'loading' }));
            let retryAfterCompletion = false;
            void hydrateInteraction(interaction, controller.signal)
                .then((didApply) => {
                    retryAfterCompletion = !didApply;
                    setDetailStates(states => {
                        const next = { ...states };
                        delete next[interaction.id];
                        return next;
                    });
                })
                .catch(error => {
                    if (controller.signal.aborted) return;
                    const current = actions().find(candidate => candidate.id === interaction.id);
                    if (current !== interaction) {
                        retryAfterCompletion = current?.detailsTruncated === true;
                        setDetailStates(states => {
                            const next = { ...states };
                            delete next[interaction.id];
                            return next;
                        });
                        return;
                    }
                    setDetailStates(states => ({ ...states, [interaction.id]: 'error' }));
                    console.error('Interaction detail hydration failed:', error);
                })
                .finally(() => {
                    if (detailRequests.get(interaction.id)?.controller === controller) {
                        detailRequests.delete(interaction.id);
                    }
                    if (
                        retryAfterCompletion
                        && !controller.signal.aborted
                        && actions().some(current => current.id === interaction.id && current.detailsTruncated)
                    ) setDetailRetry(value => value + 1);
                });
        }
    });

    onCleanup(() => detailRequests.forEach(request => request.controller.abort()));

    createEffect(() => {
        const list = actions();
        if (list.length === 0) {
            setSelectedId(undefined);
            setFollowLatest(true);
            return;
        }

        const id = selectedId();
        if (followLatest()) {
            setSelectedId(list[list.length - 1].id);
        } else if (id === undefined || !list.some(action => action.id === id)) {
            setSelectedId(list.find(action => id === undefined || action.id > id)?.id ?? list[0].id);
        }
    });

    const selectAction = (index: number) => {
        const list = actions();
        const action = list[index];
        if (!action) return;
        setFollowLatest(index === list.length - 1);
        setSelectedId(action.id);
    };

    return (
        <div class="app">
            <ActionCarousel
                actions={actions()}
                currentIndex={currentIndex()}
                onNavigate={selectAction}
            />
            <main class="app-main">
                <MainInspector
                    interaction={currentAction()}
                    previousInteraction={previousAction()}
                    allActions={actions()}
                    currentIndex={currentIndex()}
                    onSelectAction={selectAction}
                    detailsState={currentAction() ? detailStates()[currentAction()!.id] : undefined}
                    previousDetailsState={previousAction() ? detailStates()[previousAction()!.id] : undefined}
                    onRetryDetails={() => setDetailRetry(value => value + 1)}
                />
            </main>
        </div>
    );
};

export default App;
