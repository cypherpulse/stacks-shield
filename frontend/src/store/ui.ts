import { create } from "zustand";

/** Ephemeral UI state (command palette, mobile sidebar) not tied to the server. */
interface UIState {
  commandOpen: boolean;
  sidebarOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  commandOpen: false,
  sidebarOpen: true,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
