import { type Component, createSignal, createMemo, createEffect, onCleanup } from 'solid-js';
import { useInteractions } from './hooks/useInteractions';
import { ActionCarousel } from './components/ActionCarousel';
import { MainInspector } from './components/MainInspector';
import { MAX_STABILITY_SNAPSHOTS } from '../../core/selectors/selector-stability';
import type { Interaction } from './types';
import './App.css';

const App: Component = () => {
    const { interactions: actions, hydrateInteraction } = useInteractions();
    const [selectedId, setSelectedId] = createSignal<number>();
    const [followLatest, setFollowLatest] = createSignal(true);
    const [detailStates, setDetailStates] = createSignal<Record<number, 'loading' | 'error'>>({});
    const [detailRetry, setDetailRetry] = createSignal(0);
    const detailControllers = new Map<number, AbortController>();

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
        const targets = [
            list[index],
            list[index - 1],
            ...list.slice(index + 1, index + 1 + MAX_STABILITY_SNAPSHOTS),
        ].filter((interaction): interaction is Interaction => interaction !== undefined);
        const targetIds = new Set(targets.map(interaction => interaction.id));
        for (const [id, controller] of detailControllers) {
            if (targetIds.has(id)) continue;
            controller.abort();
            detailControllers.delete(id);
        }
        for (const interaction of targets) {
            if (!interaction.detailsTruncated) continue;
            if (detailControllers.has(interaction.id)) continue;
            const controller = new AbortController();
            detailControllers.set(interaction.id, controller);
            setDetailStates(states => ({ ...states, [interaction.id]: 'loading' }));
            void hydrateInteraction(interaction, controller.signal)
                .then(() => {
                    setDetailStates(states => {
                        const next = { ...states };
                        delete next[interaction.id];
                        return next;
                    });
                })
                .catch(error => {
                    if (controller.signal.aborted) return;
                    setDetailStates(states => ({ ...states, [interaction.id]: 'error' }));
                    console.error('Interaction detail hydration failed:', error);
                })
                .finally(() => {
                    if (detailControllers.get(interaction.id) === controller) {
                        detailControllers.delete(interaction.id);
                    }
                });
        }
    });

    onCleanup(() => detailControllers.forEach(controller => controller.abort()));

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
