import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import { API_URL, DEPLOYER, RELAYER_URL } from "@/shared/constants/protocol";
import { useWallet } from "@/features/wallet/useWallet";
import { useThemeStore } from "@/store/theme";

export function Settings() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { address, isConnected, connect, disconnect } = useWallet();

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Appearance, wallet and protocol endpoints." />

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
