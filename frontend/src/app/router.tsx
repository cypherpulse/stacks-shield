import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { queryClient } from "@/lib/query-client";
import { AppShell } from "@/shared/layouts/AppShell";

// ---- root ------------------------------------------------------------------
export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: ErrorBoundary,
});

function RootComponent() {
  return <Outlet />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has moved.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-xl font-semibold tracking-tight">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error?.message ?? "Something went wrong."} You can try again or head home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

// ---- landing (public) ------------------------------------------------------
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("@/features/landing/LandingPage"), "Landing"),
});

// ---- app shell (pathless layout) -------------------------------------------
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/dashboard",
  component: lazyRouteComponent(() => import("@/features/dashboard/DashboardPage"), "Dashboard"),
});
const shieldRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/shield",
  component: lazyRouteComponent(() => import("@/features/shield/ShieldPage"), "ShieldPage"),
});
const notesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/notes",
  component: lazyRouteComponent(() => import("@/features/notes/NotesPage"), "NotesPage"),
});
const transferRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/transfer",
  component: lazyRouteComponent(() => import("@/features/transfer/TransferPage"), "TransferPage"),
});
const splitRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/split",
  component: lazyRouteComponent(() => import("@/features/split/SplitPage"), "SplitPage"),
});
const mergeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/merge",
  component: lazyRouteComponent(() => import("@/features/merge/MergePage"), "MergePage"),
});
const withdrawRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/withdraw",
  component: lazyRouteComponent(() => import("@/features/withdraw/WithdrawPage"), "WithdrawPage"),
});
const activityRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/activity",
  component: lazyRouteComponent(() => import("@/features/activity/ActivityPage"), "ActivityPage"),
});
const explorerRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/explorer",
  component: lazyRouteComponent(() => import("@/features/explorer/ExplorerPage"), "Explorer"),
});
const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("@/features/settings/SettingsPage"), "Settings"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appLayoutRoute.addChildren([
    dashboardRoute,
    shieldRoute,
    notesRoute,
    transferRoute,
    splitRoute,
    mergeRoute,
    withdrawRoute,
    activityRoute,
    explorerRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
