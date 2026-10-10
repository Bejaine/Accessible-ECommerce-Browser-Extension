// Debug panel: live inference scores (for the demo and for calibrating weights). A plain table
// refreshed every 500 ms; deliberately not a live region, so screen readers aren't flooded.
import { MIN_GROUPS, SUGGEST_THRESHOLD, type ScoreEngine } from '../infer/scores';
import { modeName } from '../infer/suggest';
import { label } from './strings';

export interface DebugPanel {
  readonly element: HTMLElement;
  refresh(): void;
  dispose(): void;
}

export function createDebugPanel(
  engine: ScoreEngine,
  isActive: (c: 'visual' | 'speech' | 'motor' | 'ageing') => boolean,
  lang?: string,
): DebugPanel {
  const section = document.createElement('section');
  section.className = 'asl-debug asl-output';
  section.setAttribute('aria-labelledby', 'asl-debug-title');
  const heading = document.createElement('h3');
  heading.id = 'asl-debug-title';
  heading.textContent = label('debug.title', lang);
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const key of ['debug.condition', 'debug.score', 'debug.signals', 'debug.status'] as const) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label(key, lang);
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  section.append(heading, table);

  function refresh(): void {
    const scores = engine.scores();
    tbody.replaceChildren(
      ...(Object.keys(scores) as (keyof typeof scores)[]).map((c) => {
        const s = scores[c];
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = modeName(c, lang);
        const groups = Object.entries(s.groups)
          .map(([g, v]) => `${g} ${v.toFixed(2)}`)
          .join(', ');
        const status = isActive(c)
          ? 'on'
          : s.ready
            ? 'ready to suggest'
            : `needs ${SUGGEST_THRESHOLD} and ${MIN_GROUPS[c]} groups (has ${s.groupCount})`;
        const cells = [`${Math.round(s.score * 100)}%`, groups || '-', status].map((v) => {
          const td = document.createElement('td');
          td.textContent = v;
          return td;
        });
        tr.append(th, ...cells);
        return tr;
      }),
    );
  }

  refresh();
  const timer = setInterval(refresh, 500);
  return { element: section, refresh, dispose: () => clearInterval(timer) };
}
