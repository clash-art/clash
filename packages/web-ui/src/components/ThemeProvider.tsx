import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ACCENT_STORAGE_KEY,
  applyAccentColor,
  applyResolvedTheme,
  normalizeAccentColor,
  readAccentColor,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  writeAccentColor,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme';

export interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  accentColor: string;
  setPreference: (preference: ThemePreference) => void;
  setAccentColor: (color: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState<ThemePreference>(() =>
    readThemePreference(),
  );
  const [accentColor, setStoredAccentColor] = useState(() => readAccentColor());
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );
  const resolvedTheme = resolveTheme(preference, prefersDark);

  useLayoutEffect(() => {
    applyResolvedTheme(document.documentElement, resolvedTheme);
  }, [resolvedTheme]);

  useLayoutEffect(() => {
    applyAccentColor(document.documentElement, accentColor);
  }, [accentColor]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    setPrefersDark(media.matches);
    media.addEventListener?.('change', handleChange);
    return () => media.removeEventListener?.('change', handleChange);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === THEME_STORAGE_KEY) {
        setStoredPreference(readThemePreference());
      }
      if (!event.key || event.key === ACCENT_STORAGE_KEY) {
        setStoredAccentColor(readAccentColor());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    const handlePreferenceSync = () => {
      setStoredPreference(readThemePreference());
    };
    window.addEventListener('clash:appearance-preference-sync', handlePreferenceSync);
    return () =>
      window.removeEventListener('clash:appearance-preference-sync', handlePreferenceSync);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    writeThemePreference(next);
  }, []);

  const setAccentColor = useCallback((next: string) => {
    const normalized = normalizeAccentColor(next);
    if (!normalized) return;
    setStoredAccentColor(normalized);
    writeAccentColor(normalized);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      accentColor,
      setPreference,
      setAccentColor,
    }),
    [accentColor, preference, resolvedTheme, setAccentColor, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}
