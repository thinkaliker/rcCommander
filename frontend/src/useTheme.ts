import { useEffect, useState } from 'react';

/** 'auto' follows the OS; the other two pin one scheme. */
export type ThemeChoice = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'rc-theme';

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Private-browsing modes can throw on access; fall through to 'auto'.
  }
  return 'auto';
}

/**
 * Reads the persisted theme choice and mirrors it onto <html data-theme>,
 * which is what index.css keys `color-scheme` off. 'auto' clears the
 * attribute so `color-scheme: light dark` follows the OS again.
 *
 * The same attribute is set by an inline script in index.html so a stored
 * choice is already applied on the first paint, before React mounts.
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeChoice>(readStored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;

    try {
      if (theme === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not being able to persist is not worth failing the toggle over.
    }
  }, [theme]);

  return [theme, setTheme] as const;
}
