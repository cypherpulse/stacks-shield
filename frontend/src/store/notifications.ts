import { create } from "zustand";

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  description?: string;
  createdAt: number;
  read: boolean;
}

interface NotificationState {
  items: AppNotification[];
  unread: number;
  push: (n: Omit<AppNotification, "id" | "createdAt" | "read">) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `n_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  unread: 0,
  push: (n) =>
    set((s) => {
      const item: AppNotification = { ...n, id: uid(), createdAt: Date.now(), read: false };
      return { items: [item, ...s.items].slice(0, 50), unread: s.unread + 1 };
    }),
  markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })), unread: 0 })),
  remove: (id) =>
    set((s) => {
      const target = s.items.find((i) => i.id === id);
      return {
        items: s.items.filter((i) => i.id !== id),
        unread: target && !target.read ? Math.max(0, s.unread - 1) : s.unread,
      };
    }),
  clear: () => set({ items: [], unread: 0 }),
}));
