import { Outlet } from "@tanstack/react-router";

import { AppSidebar } from "@/shared/layouts/AppSidebar";
import { TopNav } from "@/shared/layouts/TopNav";
import { SidebarInset, SidebarProvider } from "@/shared/components/ui/sidebar";

export function AppShell() {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <SidebarInset className="min-w-0 flex-1">
          <TopNav />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
