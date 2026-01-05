import { type Component, createSignal } from 'solid-js';
import { useInteractions } from './hooks/useInteractions';
import { Stats } from './components/Stats';
import { Controls } from './components/Controls';
import { Timeline } from './components/Timeline';
import { Inspector } from './components/Inspector';
import type { Interaction } from './types';
import './App.css';

const App: Component = () => {
    const { interactions, stats, clearHistory, refresh } = useInteractions();
    const [inspectorOpen, setInspectorOpen] = createSignal(false);
    const [inspectorInteraction, setInspectorInteraction] = createSignal<Interaction | null>(null);

    const handleInspect = (interaction: Interaction) => {
        setInspectorInteraction(interaction);
        setInspectorOpen(true);
    };

    const handleExport = () => {
        const data = JSON.stringify(interactions(), null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `appium-session-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div class="app">
            <header class="app-header">
                <h1 class="app-title">
                    <span class="app-icon">🎬</span>
                    Appium Session Recorder
                </h1>
            </header>

            <main class="app-main">
                <Controls
                    onRefresh={refresh}
                    onClear={clearHistory}
                    onExport={handleExport}
                />

                <Stats total={stats().total} actions={stats().actions} />

                <Timeline
                    interactions={interactions()}
                    onInspect={handleInspect}
                />
            </main>

            <Inspector
                interaction={inspectorInteraction()}
                open={inspectorOpen()}
                onClose={() => setInspectorOpen(false)}
            />
        </div>
    );
};

export default App;
