export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'pdf-studio:theme';

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

export function applyTheme(theme: ThemePref): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

export function nextTheme(theme: ThemePref): ThemePref {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}
