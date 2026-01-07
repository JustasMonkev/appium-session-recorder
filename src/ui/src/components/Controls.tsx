import { type Component } from 'solid-js';
import './Controls.css';

type ControlsProps = {
    onRefresh: () => void;
    onClear: () => void;
};

export const Controls: Component<ControlsProps> = (props) => {
    const handleClear = () => {
        if (confirm('Clear all recorded interactions?')) {
            props.onClear();
        }
    };

    return (
        <div class="controls">
            <button class="btn btn-primary" onClick={props.onRefresh}>
                🔄 Refresh
            </button>
            <button class="btn btn-danger" onClick={handleClear}>
                🗑️ Clear History
            </button>
        </div>
    );
};
