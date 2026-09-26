import { useEffect, useState, type ReactNode } from "react";

/**
 * The colour theme. "system" is stored as absence, so the page follows the OS
 * until the operator pins a scheme; `app.css` resolves every colour through
 * `light-dark()`, so pinning is only a `color-scheme` override on the root.
 */
const THEME_KEY = "obserf.theme";

type Theme = "system" | "light" | "dark";

const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

export function storedTheme(): Theme {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

const THEME_ICONS: Record<Theme, ReactNode> = {
  system: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  dark: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
};

/** Cycles system → light → dark; the icon shows the theme in force, the label the next. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(storedTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Unavailable storage only costs remembering the choice.
    }
  }, [theme]);
  const label = `Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`;
  return (
    <button
      type="button"
      className="icon"
      aria-label={label}
      title={label}
      onClick={() => setTheme(NEXT_THEME[theme])}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {THEME_ICONS[theme]}
      </svg>
    </button>
  );
}
