import { DEFAULT_ENABLED, DEFAULT_MINUTES, DEFAULT_TRAFFIC_FACTOR, STORAGE_KEY } from '../config/constants';
import type { AppState, Candidate, Workplace } from '../types';

type Listener = (state: AppState) => void;

function freshState(): AppState {
  return {
    workplaces: [],
    candidates: [],
    enabledLayers: {},
    zoneMode: 'all',
    trafficFactor: DEFAULT_TRAFFIC_FACTOR,
    tab: 'hazards',
    budget: null,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function blankCandidate(address: string, lat: number, lon: number): Candidate {
  return {
    id: newId('c'),
    address,
    label: '',
    lat,
    lon,
    notes: '',
    price: null,
    results: {},
    driveTimes: {},
    inZone: null,
    scored: false,
  };
}

export function blankWorkplace(address: string, lat: number, lon: number): Workplace {
  return { id: newId('w'), address, lat, lon, minutes: DEFAULT_MINUTES };
}

class Store {
  private state: AppState = freshState();
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Mutations go through here so persistence and re-render stay in lockstep --
   * there is no path that changes state without the table and map hearing
   * about it.
   */
  update(mutate: (state: AppState) => void, options: { persist?: boolean } = {}): void {
    mutate(this.state);
    if (options.persist !== false) this.save();
    for (const listener of this.listeners) listener(this.state);
  }

  replace(next: AppState): void {
    this.state = next;
    this.save();
    for (const listener of this.listeners) listener(this.state);
  }

  initLayers(layerIds: string[]): void {
    this.update(
      (state) => {
        for (const id of layerIds) {
          if (!(id in state.enabledLayers)) state.enabledLayers[id] = DEFAULT_ENABLED.has(id);
        }
      },
      { persist: false },
    );
  }

  private save(): void {
    try {
      // Isochrone geometry is cached separately and can be large; keep it out
      // of the main blob so a big commute zone cannot blow the storage quota
      // and take the whole session with it.
      const slim: AppState = {
        ...this.state,
        workplaces: this.state.workplaces.map(({ isochrone: _isochrone, ...rest }) => rest),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // Non-fatal: the session keeps working, it just will not survive reload.
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<AppState>;
      this.state = { ...freshState(), ...parsed };
      // Anything computed against layer data is recomputed on load rather than
      // trusted: the underlying datasets may have been refreshed since.
      for (const candidate of this.state.candidates) {
        candidate.results = {};
        candidate.scored = false;
      }
    } catch {
      this.state = freshState();
    }
  }
}

export const store = new Store();
