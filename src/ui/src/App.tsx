import { type Component, createSignal, createMemo, createEffect } from 'solid-js';
import { useInteractions } from './hooks/useInteractions';
import { ActionCarousel } from './components/ActionCarousel';
import { MainInspector } from './components/MainInspector';
import './App.css';

const App: Component = () => {
    const { interactions } = useInteractions();
    const [currentIndex, setCurrentIndex] = createSignal(0);

    // Filter to only actions (interactions with screenshots)
    const actions = createMemo(() =>
        interactions().filter(i => i.screenshot)
    );

    // Get the current action
    const currentAction = createMemo(() => actions()[currentIndex()]);

    // Auto-select the latest action when new ones are added
    createEffect(() => {
        const actionsCount = actions().length;
        if (actionsCount > 0) {
            setCurrentIndex(actionsCount - 1);
        }
    });

    return (
        <div class="app">
            <ActionCarousel
                interactions={interactions()}
                currentIndex={currentIndex()}
                onNavigate={setCurrentIndex}
            />
            <main class="app-main">
                <MainInspector interaction={currentAction()} />
            </main>
        </div>
    );
};

export default App;