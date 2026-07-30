import { Bell, Check, Copy, LogOut, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/components/ui/popover";
import { SidebarTrigger } from "@/shared/components/ui/sidebar";
import { useActivity } from "@/features/activity/useActivity";
import { useWallet } from "@/features/wallet/useWallet";
import { relativeTime, truncate } from "@/shared/utils/format";

export function TopNav() {
  const { isConnected, isConnecting, address, connect, disconnect } = useWallet();
  const { data: history } = useActivity();
  const [copied, setCopied] = useState(false);

  const recent = (history ?? []).slice(0, 5);

  const copy = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    toast.success("Address copied");
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-xl sm:px-5">
      <SidebarTrigger />

      <Badge
        variant="outline"
        className="ml-1 gap-1.5 border-success/40 text-success max-sm:hidden"
      >
        <span className="size-1.5 rounded-full bg-success" />
        Stacks Testnet
      </Badge>

      <div className="ml-auto flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Notifications">
              <Bell className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-medium">Notifications</p>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {recent.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No recent activity yet.
                </p>
              ) : (
                recent.map((entry, i) => (
                  <div
                    key={entry.id ?? i}
                    className="border-b border-border px-4 py-3 last:border-0"
                  >
                    <p className="text-sm font-medium capitalize">{entry.type}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.status ?? "submitted"} ·{" "}
                      {relativeTime(entry.timestamp ?? entry.createdAt)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>

        {isConnected && address ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2 font-mono text-xs">
                <span className="size-1.5 rounded-full bg-success" />
                {truncate(address, 5, 4)}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="font-mono text-xs break-all">
                {address}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void copy()}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                Copy address
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void disconnect()}>
                <LogOut className="size-4" />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button onClick={() => void connect()} disabled={isConnecting} className="gap-2">
            <Wallet className="size-4" />
            {isConnecting ? "Connecting…" : "Connect Wallet"}
          </Button>
        )}
      </div>
    </header>
  );
}
