import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeftRight,
  Compass,
  LayoutDashboard,
  Merge,
  Settings,
  Shield,
  Split,
  Wallet,
} from "lucide-react";

import { Logo } from "@/shared/components/brand/Logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/shared/components/ui/sidebar";

const overview = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Notes", url: "/notes", icon: Wallet },
  { title: "Activity", url: "/activity", icon: Activity },
];

const operations = [
  { title: "Shield", url: "/shield", icon: Shield },
  { title: "Transfer", url: "/transfer", icon: ArrowLeftRight },
  { title: "Split", url: "/split", icon: Split },
  { title: "Merge", url: "/merge", icon: Merge },
  { title: "Withdraw", url: "/withdraw", icon: ArrowDownToLine },
];

const protocol = [
  { title: "Explorer", url: "/explorer", icon: Compass },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  const isActive = (url: string) =>
    url === "/dashboard"
      ? pathname === "/dashboard" || pathname === "/dashboard/"
      : pathname.startsWith(url);

  const renderGroup = (label: string, items: typeof overview) => (
    <SidebarGroup>
      {!collapsed && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                <Link to={item.url}>
                  <item.icon className="size-4" />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        <Link to="/">
          <Logo compact={collapsed} />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {renderGroup("Overview", overview)}
        {renderGroup("Operations", operations)}
        {renderGroup("Protocol", protocol)}
      </SidebarContent>
    </Sidebar>
  );
}
