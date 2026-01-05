import { type Component } from 'solid-js';
import './Stats.css';

type StatsProps = {
    total: number;
    actions: number;
};

export const Stats: Component<StatsProps> = (props) => {
    return (
        <div class="stats">
            <div class="stat">
                <div class="stat-value">{props.total}</div>
                <div class="stat-label">Total Requests</div>
            </div>
            <div class="stat">
                <div class="stat-value">{props.actions}</div>
                <div class="stat-label">Actions (with screenshots)</div>
            </div>
        </div>
    );
};
