import { useEffect, useState } from 'react';

/** Defaults applied to every transfer unless the confirm dialog overrides them. */
export interface TransferSettings {
  threads: number;
  autoRemove: number;
  /** Show the confirm dialog before each transfer instead of starting it straight away. */
  askEveryTime: boolean;
  /** Seconds between silent re-listings of both panes; 0 disables it. */
  autoRefresh: number;
  /** Let each pane override the auto-refresh interval with one of its own. */
  perPaneRefresh: boolean;
}

export const DEFAULT_SETTINGS: TransferSettings = {
  threads: 4,
  autoRemove: 5,
  askEveryTime: false,
  autoRefresh: 0,
  perPaneRefresh: false,
};

const STORAGE_KEY = 'rc-transfer-settings';

export const clampThreads = (value: number) =>
  Number.isFinite(value) ? Math.min(16, Math.max(1, Math.round(value))) : DEFAULT_SETTINGS.threads;

export const clampAutoRemove = (value: number) =>
  Number.isFinite(value) ? Math.min(3600, Math.max(0, Math.round(value))) : DEFAULT_SETTINGS.autoRemove;

export const clampAutoRefresh = (value: number) =>
  Number.isFinite(value) ? Math.min(3600, Math.max(0, Math.round(value))) : DEFAULT_SETTINGS.autoRefresh;

// Stored values are validated field by field: a hand-edited or half-written
// entry must not leave a transfer running with a nonsense thread count.
function readStored(): TransferSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<TransferSettings>;
    return {
      threads: clampThreads(Number(parsed.threads)),
      autoRemove: clampAutoRemove(Number(parsed.autoRemove)),
      askEveryTime: parsed.askEveryTime === true,
      autoRefresh: clampAutoRefresh(Number(parsed.autoRefresh)),
      perPaneRefresh: parsed.perPaneRefresh === true,
    };
  } catch {
    // Private-browsing modes can throw on access, and malformed JSON lands
    // here too; either way the defaults are a safe transfer configuration.
    return DEFAULT_SETTINGS;
  }
}

/** Transfer defaults, persisted so they survive a reload. */
export function useSettings() {
  const [settings, setSettings] = useState<TransferSettings>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Not being able to persist is not worth failing the change over.
    }
  }, [settings]);

  return [settings, setSettings] as const;
}
