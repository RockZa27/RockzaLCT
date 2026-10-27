/** Styles for the monitoring page (kept here because styles.css belongs to the shell). */
export const MONITOR_CSS = `
.mon { --mon-warn: #f5b94a; --mon-offline: #7b8699; }
.mon .card { max-width: none; }
.mon-layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
@media (max-width: 1100px) { .mon-layout { grid-template-columns: minmax(0, 1fr); } }
.mon-toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 12px; }
.mon-toolbar .field { margin-bottom: 0; }
.mon select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.mon-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.mon-chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 12px; background: var(--panel-2); }
.mon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.mon-tile { display: flex; flex-direction: column; gap: 2px; text-align: left; border-left-width: 6px; padding: 8px 10px; }
.mon-tile[aria-pressed='true'] { outline: 2px solid var(--accent); }
.mon-tile.ok { border-left-color: var(--ok); }
.mon-tile.warning { border-left-color: var(--mon-warn); }
.mon-tile.critical { border-left-color: var(--err); background: rgba(255, 107, 107, 0.12); }
.mon-tile.offline { border-left-color: var(--mon-offline); border-style: dashed; color: var(--muted); }
.mon-tile-name { font-weight: 600; }
.mon-badge { font-size: 0.8rem; font-weight: 600; }
.mon-tile.ok .mon-badge, .mon-sev-ok { color: var(--ok); }
.mon-tile.warning .mon-badge, .mon-sev-warning { color: var(--mon-warn); }
.mon-tile.critical .mon-badge, .mon-sev-critical { color: var(--err); }
.mon-tile.offline .mon-badge { color: var(--mon-offline); }
.mon-trend { width: 100%; max-width: 420px; height: auto; display: block; }
.mon-axis { stroke: var(--border); stroke-width: 1; }
.mon-tick { fill: var(--muted); font-size: 9px; }
.mon-line { stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; }
.mon-dot { fill: var(--accent); }
.mon-alerts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.mon-alerts li { border-left: 4px solid var(--mon-warn); padding: 4px 10px; background: var(--panel-2); border-radius: 4px; }
.mon-alerts li.critical { border-left-color: var(--err); }
.mon-history { max-height: 260px; overflow: auto; }
.mon-settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.mon-settings-grid .field { margin-bottom: 0; }
.mon-check { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
`;
