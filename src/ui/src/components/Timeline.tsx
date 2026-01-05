import { type Component, For, Show } from 'solid-js';
import type { Interaction } from '../types';
import { InteractionCard } from './InteractionCard';
import './Timeline.css';

type TimelineProps = {
    interactions: Interaction[];
    onInspect?: (interaction: Interaction) => void;
};

export const Timeline: Component<TimelineProps> = (props) => {
    return (
        <div class="timeline">
            <Show
                when={props.interactions.length > 0}
                fallback={
                    <div class="empty-state">
                        <div class="empty-icon">📱</div>
                        <div class="empty-title">No interactions recorded yet</div>
                        <div class="empty-text">
                            Connect Appium Inspector to port 4724 and start interacting
                        </div>
                    </div>
                }
            >
                <For each={props.interactions}>
                    {(interaction) => (
                        <InteractionCard
                            interaction={interaction}
                            onInspect={() => props.onInspect?.(interaction)}
                        />
                    )}
                </For>
            </Show>
        </div>
    );
};
