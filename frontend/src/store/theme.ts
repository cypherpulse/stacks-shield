import { create } from "zustand";

export type Theme = "dark" | "light";

const STORAGE_KEY = "stx-shield.theme";

function apply(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("light", theme === "light");
}

export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  init: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: "dark",
  setTheme: (theme) => {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, theme);
    apply(theme);
    set({ theme });
  },
  init: () => {
    const theme = readStoredTheme();
    apply(theme);
    set({ theme });
  },
}));
