import { type Component, Show } from 'solid-js';
import type { Interaction } from '../types';
import './InteractionCard.css';

type InteractionCardProps = {
    interaction: Interaction;
    onInspect?: () => void;
};

export const InteractionCard: Component<InteractionCardProps> = (props) => {
    const formattedTime = () => new Date(props.interaction.timestamp).toLocaleTimeString();
    const isAction = () => !!props.interaction.screenshot;

    return (
        <div classList={{ 'interaction-card': true, 'action': isAction() }}>
            <div class="interaction-header">
                <div class="interaction-header-left">
                    <span class="interaction-id">#{props.interaction.id}</span>
                    <span classList={{
                        'interaction-method': true,
                        [props.interaction.method]: true,
                    }}>
                        {props.interaction.method}
                    </span>
                    <span class="interaction-path">{props.interaction.path}</span>
                </div>
                <span class="interaction-time">{formattedTime()}</span>
            </div>

            <Show when={props.interaction.elementInfo}>
                <div class="element-info">
                    <span class="element-info-using">{props.interaction.elementInfo!.using}:</span>
                    {' "'}
                    <span class="element-info-value">{props.interaction.elementInfo!.value}</span>
                    {'"'}
                </div>
            </Show>

            <Show when={props.interaction.body}>
                <pre class="interaction-body">
                    {JSON.stringify(props.interaction.body, null, 2)}
                </pre>
            </Show>

            <Show when={props.interaction.screenshot}>
                <div class="screenshot-container">
                    <img
                        src={`data:image/png;base64,${props.interaction.screenshot}`}
                        alt="Screenshot"
                        class="screenshot"
                        onClick={props.onInspect}
                    />
                    <button class="inspect-btn" onClick={props.onInspect}>
                        Inspect Elements
                    </button>
                </div>
            </Show>
        </div>
    );
};
