import { Link } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  Droplets,
  Info,
  Merge,
  Shield,
  Split,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/shared/components/States";
import { Button } from "@/shared/components/ui/button";
import { Card } from "@/shared/components/ui/card";
import { FAUCET_AMOUNT_STX, MIN_SHIELD_STX } from "@/shared/constants/protocol";

interface Step {
  icon: LucideIcon;
  title: string;
  what: string;
  how: string[];
  to: string;
  cta: string;
}

const steps: Step[] = [
  {
    icon: Droplets,
    title: "Claim testnet STX",
    what: `Grab ${FAUCET_AMOUNT_STX} free testnet STX to test with. Testnet STX has no real value.`,
    how: [
      "Connect a Stacks wallet (Leather or Xverse) set to Testnet.",
      "Open the Faucet and claim to your wallet address.",
      "Give it about a minute to arrive before shielding.",
    ],
    to: "/faucet",
    cta: "Open the faucet",
  },
  {
    icon: Shield,
    title: "Shield STX",
    what: "Deposit public STX and receive a private note that only you can see.",
    how: [
      `Enter an amount (minimum ${MIN_SHIELD_STX} STX) and confirm in your wallet.`,
      "Your note shows as pending, then flips to confirmed once it lands on chain.",
      "The note's amount is decrypted only in your browser. Nobody else can read it.",
    ],
    to: "/shield",
    cta: "Shield STX",
  },
  {
    icon: ArrowLeftRight,
    title: "Transfer privately",
    what: "Send a whole note to someone's shield address with no on-chain trace of the sender.",
    how: [
      "Ask the recipient for their Stacks Shield address (Settings, then Show my shield address).",
      "The recipient must have opened Stacks Shield once, so their address exists.",
      "Pick a note, paste their shield address, and send.",
    ],
    to: "/transfer",
    cta: "Make a transfer",
  },
  {
    icon: Split,
    title: "Split a note",
    what: "Break one note into two smaller notes you own, so you can spend exact amounts.",
    how: [
      "Pick a note, then enter amount A. Amount B is the remainder.",
      "You get two new notes that together equal the original.",
      "Need more denominations? Split one of the results again.",
    ],
    to: "/split",
    cta: "Split a note",
  },
  {
    icon: Merge,
    title: "Merge notes",
    what: "Combine two notes back into a single, larger note.",
    how: [
      "Pick exactly two notes you own.",
      "Merge them into one note worth the sum of both.",
      "Handy for tidying up lots of small notes.",
    ],
    to: "/merge",
    cta: "Merge notes",
  },
  {
    icon: ArrowDownToLine,
    title: "Withdraw",
    what: "Redeem a note back to public STX at any Stacks address.",
    how: [
      "Pick a note. Leave the recipient blank to withdraw to your own wallet.",
      "A small protocol fee of about 0.3% is taken on withdrawal.",
      "The STX arrives at the destination address once the transaction confirms.",
    ],
    to: "/withdraw",
    cta: "Withdraw",
  },
];

const tips = [
  "The first time you connect, you sign two free messages: one to authenticate, one to derive your private note key. This is normal and moves no funds.",
  "Every operation takes about a minute to confirm on chain. Notes stay pending until then.",
  "Amounts and note ownership are private. The protocol never learns who owns what.",
  "This runs on public Stacks Testnet. Use testnet STX only.",
];

export function GuidePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Getting started"
        description="Test the full private lifecycle, one step at a time: claim, shield, transfer, split, merge and withdraw."
      />

      <div className="space-y-4">
        {steps.map((step, i) => (
          <Card key={step.to} className="glass gap-0 p-0">
            <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:gap-5">
              <div className="flex items-center gap-3 sm:flex-col sm:items-center sm:gap-2">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                  <step.icon className="size-5" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  Step {i + 1}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <h2 className="font-display text-lg font-semibold">{step.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{step.what}</p>
                <ul className="mt-3 space-y-1.5">
                  {step.how.map((line) => (
                    <li key={line} className="flex gap-2 text-sm text-muted-foreground">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/50" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="sm:pt-1">
                <Button asChild variant="outline" className="w-full sm:w-auto">
                  <Link to={step.to}>
                    {step.cta} <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="glass gap-3 p-6">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Info className="size-4 text-primary" /> Good to know
        </p>
        <ul className="space-y-2">
          {tips.map((tip) => (
            <li key={tip} className="flex gap-2 text-sm text-muted-foreground">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="gradient-brand flex flex-col items-center gap-3 p-8 text-center text-primary-foreground shadow-glow">
        <p className="font-display text-xl font-semibold">Ready to try it?</p>
        <p className="max-w-md text-sm text-primary-foreground/80">
          Start by claiming testnet STX, then shield your first private note.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Button asChild variant="secondary">
            <Link to="/faucet">Claim testnet STX</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="border-primary-foreground/30 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
          >
            <Link to="/shield">Shield STX</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
