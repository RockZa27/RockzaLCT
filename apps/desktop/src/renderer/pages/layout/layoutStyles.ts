/** Styles for the layout page (kept here because styles.css belongs to the shell). */
export const LAYOUT_CSS = `
.layout-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
@media (max-width: 1100px) { .layout-grid { grid-template-columns: minmax(0, 1fr); } }
.layout-wide { max-width: none; }
.layout-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.layout-fields .field { margin-bottom: 0; }
.layout-fields select, .layout-ports select, .layout-card select {
  font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 8px; max-width: 100%;
}
.layout-ports { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.layout-port {
  display: grid; grid-template-columns: 100px 70px 1fr 42px 130px 32px; align-items: center; gap: 8px;
  padding: 4px 6px; border: 1px solid transparent; border-radius: 8px;
}
.layout-port.active { border-color: var(--accent); background: var(--panel-2); }
.layout-port-select { display: flex; align-items: center; gap: 6px; padding: 4px 8px; text-align: left; }
.layout-port button:last-child { padding: 2px 0; }
.layout-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.layout-bar { height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden; border: 1px solid var(--border); }
.layout-bar-fill { height: 100%; }
.layout-pct { text-align: right; font-size: 0.85rem; color: var(--muted); }
.layout-pct.over { color: var(--err); font-weight: 600; }
.layout-issues { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.layout-issue.error { color: var(--err); }
.layout-issue.warning { color: #ffd54f; }
.layout-ok { color: var(--ok); margin: 0; }
.layout-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 0; }
.layout-notice { color: var(--muted); margin: 8px 0 0; }
`;
