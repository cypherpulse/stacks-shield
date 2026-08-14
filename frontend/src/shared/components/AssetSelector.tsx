import { Coins } from "lucide-react";

import { Label } from "@/shared/components/ui/label";
import { cn } from "@/lib/cn";
import type { AssetInfo } from "@/shared/types/shield";

/**
 * A segmented picker over the protocol assets (STX, sBTC, USDCx …). Used on the
 * shield entry point; other operations derive the asset from the selected note.
 */
export function AssetSelector({
  assets,
  value,
  onChange,
  label = "Asset",
  disabled,
}: {
  assets: AssetInfo[];
  value: AssetInfo | null;
  onChange: (asset: AssetInfo) => void;
  label?: string;
  disabled?: boolean;
}) {
  if (assets.length <= 1) return null; // nothing to choose — native STX only

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {assets.map((asset) => {
          const active = value?.symbol === asset.symbol;
          return (
            <button
              key={asset.symbol}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(asset)}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all",
                "disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "border-primary bg-primary/10 text-primary shadow-glow"
                  : "border-border bg-muted/30 text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              <Coins className="size-4" />
              {asset.symbol}
              {!asset.native && <span className="text-[10px] tracking-wide uppercase opacity-60">SIP-10</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
