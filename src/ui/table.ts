import { summarizeRisk } from '../geo/scoring';
import type { LayerDef } from '../map/layerRegistry';
import type { AppState, Candidate, LayerResult } from '../types';

export interface TableCallbacks {
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string, field: 'label' | 'notes' | 'price', value: string) => void;
}

type SortKey = string;
let sortKey: SortKey = 'risk';
let sortAsc = true;

// Which row the user has clicked to follow across a wide horizontal scroll.
// Kept here rather than in the store: it is a reading aid, not portfolio data.
let selectedId: string | null = null;

const money = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function resultText(def: LayerDef, result: LayerResult | undefined): { text: string; cls: string; title: string } {
  if (!result) return { text: '…', cls: 'pending', title: 'Not yet evaluated' };

  if (def.mode === 'proximity') {
    if (result.distanceMi === undefined) {
      return { text: '—', cls: 'none', title: 'Nothing of this kind within 25 miles' };
    }
    const miles = result.distanceMi;
    const text = miles < 0.1 ? `${Math.round(miles * 5280)} ft` : `${miles.toFixed(2)} mi`;
    return {
      text,
      cls: result.state === 'hit' ? 'flag' : 'ok',
      title:
        result.state === 'hit'
          ? `Within the flagging distance for ${def.label.toLowerCase()}`
          : `Nearest ${def.label.toLowerCase()}`,
    };
  }

  switch (result.state) {
    case 'hit':
      return {
        text: result.value ?? 'In zone',
        cls: 'flag',
        title: result.authoritative
          ? 'Confirmed against the authoritative service for this exact point'
          : 'From the simplified local copy — confirm with the official service',
      };
    case 'clear':
      return { text: 'Clear', cls: 'ok', title: 'Mapped here, and outside any zone' };
    default:
      return {
        text: 'no data',
        cls: 'unknown',
        // This is the distinction the whole three-state design exists to keep.
        title:
          'This quadrangle has not been mapped for this hazard. That is not the same as being outside a zone.',
      };
  }
}

function sortValue(candidate: Candidate, key: string, enabledIds: string[]): number | string {
  if (key === 'risk') return summarizeRisk(candidate, enabledIds).flags;
  if (key === 'address') return candidate.address.toLowerCase();
  if (key === 'label') return candidate.label.toLowerCase();
  if (key === 'price') return candidate.price ?? Number.POSITIVE_INFINITY;
  if (key === 'zipPrice') return candidate.zipPrice?.medianSalePrice ?? Number.POSITIVE_INFINITY;
  if (key === 'zone') return candidate.inZone === true ? 0 : candidate.inZone === false ? 1 : 2;
  if (key.startsWith('drive:')) {
    return candidate.driveTimes[key.slice(6)] ?? Number.POSITIVE_INFINITY;
  }
  const result = candidate.results[key];
  if (!result) return Number.POSITIVE_INFINITY;
  if (result.distanceMi !== undefined) return result.distanceMi;
  return result.state === 'hit' ? 0 : result.state === 'clear' ? 1 : 2;
}

export function renderTable(
  container: HTMLElement,
  state: AppState,
  layers: LayerDef[],
  callbacks: TableCallbacks,
): void {
  // Only enabled layers get a column. Switching a filter off removes it from
  // the map and from the assessment, which is the point of the switch.
  const enabled = layers.filter((def) => state.enabledLayers[def.id]);
  const enabledIds = enabled.map((def) => def.id);

  if (selectedId && !state.candidates.some((c) => c.id === selectedId)) selectedId = null;

  if (state.candidates.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <p><strong>No addresses yet.</strong></p>
        <p>Add a candidate address above, or click anywhere on the map to drop one.
        Each address is checked against every filter you have switched on.</p>
      </div>`;
    return;
  }

  const compare = (a: Candidate, b: Candidate) => {
    const left = sortValue(a, sortKey, enabledIds);
    const right = sortValue(b, sortKey, enabledIds);
    const cmp = typeof left === 'string' ? left.localeCompare(right as string) : (left as number) - (right as number);
    return sortAsc ? cmp : -cmp;
  };

  const rows = [...state.candidates].sort(compare);

  const header = `
    <tr>
      <th data-sort="label" class="sortable frozen frozen-1">Label</th>
      <th data-sort="address" class="sortable frozen frozen-2">Address</th>
      <th data-sort="zone" class="sortable" title="Inside the combined commute zone">Zone</th>
      ${state.workplaces
        .map(
          (w) =>
            `<th data-sort="drive:${w.id}" class="sortable num" title="Pessimistic estimate, not a routed time">
               est. min<br><span class="muted">${escapeHtml(shortAddress(w.address))}</span>
             </th>`,
        )
        .join('')}
      <th data-sort="risk" class="sortable num" title="Number of switched-on filters this address trips">Flags</th>
      <th data-sort="price" class="sortable num">Asking</th>
      <th data-sort="zipPrice" class="sortable num" title="Recent sold median for the surrounding ZIP">ZIP sold</th>
      ${enabled
        .map(
          (def) =>
            `<th data-sort="${def.id}" class="sortable" title="${escapeHtml(def.notes ?? def.label)}">${escapeHtml(
              def.label,
            )}</th>`,
        )
        .join('')}
      <th>Notes</th>
      <th class="frozen frozen-r" title="Remove"></th>
    </tr>`;

  const renderRow = (candidate: Candidate, overBudget: boolean): string => {
    const risk = summarizeRisk(candidate, enabledIds);
    const cells = enabled
      .map((def) => {
        const { text, cls, title } = resultText(def, candidate.results[def.id]);
        return `<td class="cell-${cls}" title="${escapeHtml(title)}">${escapeHtml(text)}</td>`;
      })
      .join('');

    return `
      <tr class="band-${risk.band}${candidate.id === selectedId ? ' selected' : ''}" data-id="${candidate.id}">
        <td class="frozen frozen-1"><input class="cell-input" data-field="label" value="${escapeHtml(
          candidate.label,
        )}" placeholder="—"></td>
        <td class="address frozen frozen-2"><button class="linklike" data-focus title="${escapeHtml(
          candidate.address,
        )}">${escapeHtml(candidate.address)}</button></td>
        <td>${candidate.inZone === null ? '<span class="muted">—</span>' : candidate.inZone ? '✓' : '✕'}</td>
        ${state.workplaces
          .map((w) => {
            const minutes = candidate.driveTimes[w.id];
            return `<td class="num">${minutes === null || minutes === undefined ? '—' : Math.round(minutes)}</td>`;
          })
          .join('')}
        <td class="num flags">${candidate.scored ? risk.flags : '…'}${
          risk.unknowns ? `<span class="muted" title="${risk.unknowns} filter(s) have no data here"> +${risk.unknowns}?</span>` : ''
        }</td>
        <td class="num"><input class="cell-input num" data-field="price" value="${
          candidate.price ?? ''
        }" placeholder="—"></td>
        <td class="num${overBudget ? ' cell-over' : ''}"${
          overBudget
            ? ` title="ZIP median is ${escapeHtml(
                money(candidate.zipPrice!.medianSalePrice - state.budget!),
              )} over your budget"`
            : ''
        }>${candidate.zipPrice ? money(candidate.zipPrice.medianSalePrice) : '<span class="muted">—</span>'}</td>
        ${cells}
        <td><input class="cell-input" data-field="notes" value="${escapeHtml(candidate.notes)}" placeholder="—"></td>
        <td class="frozen frozen-r"><button class="remove" data-remove title="Remove this address">×</button></td>
      </tr>`;
  };

  // A max budget splits the table rather than filtering it: an address a little
  // over is still worth seeing next to what it competes with. Both halves keep
  // the current sort, so within budget you are still reading worst-hazard first
  // (or whichever column you clicked).
  //
  // The split is on the ZIP sold median, not the asking price. Asking is a
  // number a seller made up for one house; the ZIP median is what the area
  // actually transacts at, so it is the better read on whether a neighbourhood
  // is in reach at all.
  const columnCount = 8 + state.workplaces.length + enabled.length;
  const sectionRow = (title: string, detail: string) => `
    <tr class="section">
      <td colspan="${columnCount}"><span class="section-label">${escapeHtml(title)}
        <span class="muted">${escapeHtml(detail)}</span></span></td>
    </tr>`;

  let body: string;
  if (state.budget === null) {
    body = rows.map((candidate) => renderRow(candidate, false)).join('');
  } else {
    const budget = state.budget;
    // A missing ZIP median is not the same as over budget -- the price file only
    // covers ZIPs with enough recent sales, and it loads asynchronously -- so
    // those rows stay in the top half. They are not ruled out, just unanswered.
    const median = (candidate: Candidate) => candidate.zipPrice?.medianSalePrice ?? null;
    const within = rows.filter((c) => median(c) === null || median(c)! <= budget);
    const over = rows.filter((c) => median(c) !== null && median(c)! > budget);
    const unpriced = within.filter((c) => median(c) === null).length;

    body =
      sectionRow(
        `Within ${money(budget)}`,
        `${within.length - unpriced} address${within.length - unpriced === 1 ? '' : 'es'}${
          unpriced ? `, plus ${unpriced} with no ZIP median yet` : ''
        } · by recent ZIP sold median`,
      ) +
      (within.length === 0
        ? `<tr class="section-empty"><td colspan="${columnCount}">Nothing in this range yet.</td></tr>`
        : within.map((candidate) => renderRow(candidate, false)).join('')) +
      (over.length > 0
        ? sectionRow(
            `Over ${money(budget)}`,
            `${over.length} address${over.length === 1 ? '' : 'es'}`,
          ) + over.map((candidate) => renderRow(candidate, true)).join('')
        : '');
  }

  container.innerHTML = `
    <table class="results">
      <thead>${header}</thead>
      <tbody>${body}</tbody>
    </table>`;

  container.querySelectorAll<HTMLElement>('th.sortable').forEach((th) => {
    const key = th.dataset.sort!;
    if (key === sortKey) th.classList.add(sortAsc ? 'asc' : 'desc');
    th.addEventListener('click', () => {
      if (sortKey === key) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = true;
      }
      renderTable(container, state, layers, callbacks);
    });
  });

  container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-id]').forEach((row) => {
    const id = row.dataset.id!;

    // Highlight on click, so a row stays readable once the address column is
    // the only thing left on screen. Toggling is done by swapping the class
    // rather than re-rendering: a re-render would blow away the focus and
    // caret of whichever notes field the user is typing in.
    row.addEventListener('click', (event) => {
      const fromControl = (event.target as HTMLElement).closest('input, button, select, textarea');
      selectedId = selectedId === id && !fromControl ? null : id;
      container.querySelectorAll('tbody tr[data-id]').forEach((other) => {
        other.classList.toggle('selected', (other as HTMLElement).dataset.id === selectedId);
      });
    });

    row.querySelector('[data-focus]')?.addEventListener('click', () => callbacks.onFocus(id));
    row.querySelector('[data-remove]')?.addEventListener('click', () => callbacks.onRemove(id));
    row.querySelectorAll<HTMLInputElement>('.cell-input').forEach((input) => {
      input.addEventListener('change', () =>
        callbacks.onEdit(id, input.dataset.field as 'label' | 'notes' | 'price', input.value),
      );
    });
  });
}

function shortAddress(address: string): string {
  return address.split(',')[0].slice(0, 22);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
