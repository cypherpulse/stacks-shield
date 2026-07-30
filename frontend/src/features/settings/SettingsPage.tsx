import { Check, Copy, QrCode } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import { API_URL, DEPLOYER, RELAYER_URL } from "@/shared/constants/protocol";
import { getShield } from "@/services/sdk/shield.service";
import { useWallet } from "@/features/wallet/useWallet";
import { useThemeStore } from "@/store/theme";
import { errorMessage } from "@/shared/utils/format";

export function Settings() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { address, isConnected, connect, disconnect } = useWallet();

  const [shieldAddr, setShieldAddr] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    setRevealing(true);
    try {
      const client = await getShield();
      setShieldAddr(await client.getAddress());
    } catch (e) {
      toast.error("Could not derive your shield address", { description: errorMessage(e) });
    } finally {
      setRevealing(false);
    }
  };

  const copy = async () => {
    if (!shieldAddr) return;
    await navigator.clipboard.writeText(shieldAddr);
    setCopied(true);
    toast.success("Shield address copied");
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your receive address, appearance, wallet and endpoints." />

      {/* Receive: the address others use to send you private transfers */}
      <Card className="glass gap-4 p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <QrCode className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">Your STX Shield address</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Share this to receive private transfers. It's a set of public keys — it reveals no
              balance, history, or your wallet address.
            </p>
          </div>
        </div>
        {shieldAddr ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <span className="min-w-0 flex-1 font-mono text-xs break-all">{shieldAddr}</span>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => void copy()}>
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-fit" disabled={!isConnected || revealing} onClick={() => void reveal()}>
            {revealing ? "Deriving…" : "Show my shield address"}
          </Button>
        )}
      </Card>

      <Card className="glass gap-4 p-6">
        <p className="text-sm font-medium">Appearance</p>
        <div className="flex items-center justify-between">
          <Label htmlFor="theme">Dark mode</Label>
          <Switch
            id="theme"
            checked={theme === "dark"}
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        </div>
      </Card>

      <Card className="glass gap-4 p-6">
        <p className="text-sm font-medium">Wallet</p>
        <Row label="Status" value={isConnected ? "Connected" : "Disconnected"} />
        <Row label="Address" value={address ?? "—"} />
        <div>
          {isConnected ? (
            <Button variant="outline" size="sm" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={() => void connect()}>
              Connect Wallet
            </Button>
          )}
        </div>
      </Card>

      <Card className="glass gap-3 p-6">
        <p className="text-sm font-medium">Protocol</p>
        <Row label="Network" value="Stacks Testnet" />
        <Row label="SDK" value="@stx-shield/sdk (workspace)" />
        <Row label="API endpoint" value={API_URL} />
        <Row label="Relayer endpoint" value={RELAYER_URL} />
        <Row label="Contract deployer" value={DEPLOYER} />
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs break-all">{value}</span>
    </div>
  );
}
