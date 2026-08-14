import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  Check,
  Coins,
  EyeOff,
  Github,
  KeyRound,
  Layers,
  Lock,
  Merge,
  Moon,
  ShieldCheck,
  Split,
  Sun,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import { Logo } from "@/shared/components/brand/Logo";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/shared/components/ui/accordion";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { LINKS } from "@/shared/constants/protocol";
import { useStats } from "@/features/dashboard/useStats";
import { priceFor, usePrices } from "@/features/assets/usePrices";
import { useThemeStore } from "@/store/theme";
import { formatNumber, formatUsd } from "@/shared/utils/format";

const navLinks = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#privacy", label: "Privacy" },
  { href: "#faq", label: "FAQ" },
];

const primitives = [
  {
    icon: ShieldCheck,
    title: "Shield",
    body: "Move transparent STX into a private note in a single signature.",
    accent: "primary" as const,
    span: true,
  },
  {
    icon: ArrowLeftRight,
    title: "Transfer",
    body: "Send to any shield address with no on-chain trace of the sender.",
    accent: "teal" as const,
  },
  {
    icon: Split,
    title: "Split",
    body: "Break a note into exact denominations for precise spending.",
    accent: "success" as const,
  },
  {
    icon: Merge,
    title: "Merge",
    body: "Combine notes back into one clean private balance.",
    accent: "primary" as const,
  },
  {
    icon: ArrowDownToLine,
    title: "Withdraw",
    body: "Redeem a note to any Stacks address, privately.",
    accent: "teal" as const,
  },
];

const steps = [
  {
    icon: KeyRound,
    title: "Connect",
    body: "Connect a Stacks wallet on public testnet. Your keys never leave your device.",
  },
  {
    icon: ShieldCheck,
    title: "Shield",
    body: "Deposit STX and receive a private note only you can see.",
  },
  {
    icon: Layers,
    title: "Manage",
    body: "Transfer, split or merge your notes freely and privately.",
  },
  {
    icon: ArrowDownToLine,
    title: "Withdraw",
    body: "Redeem privately to any address whenever you want.",
  },
];

const privacyPoints = [
  { icon: EyeOff, text: "Amounts stay hidden. Notes are decrypted only in your browser, never on a server." },
  { icon: Lock, text: "Non-custodial. Your note keys come from your own wallet signature." },
  {
    icon: ShieldCheck,
    text: "Every spend proves on-chain, with zero-knowledge, that the note is real and unspent.",
  },
];

const faqs = [
  {
    q: "Is Stacks Shield custodial?",
    a: "No. Your keys and note secrets are derived on your device and never leave it. Stacks Shield can never move your funds.",
  },
  {
    q: "What does 'private' actually mean here?",
    a: "The amount and owner of every shielded note are hidden. Deposits and withdrawals still touch the public chain, but nothing links a withdrawal back to the deposit it came from.",
  },
  {
    q: "Which wallets are supported?",
    a: "Any Stacks wallet that works with Stacks Connect, including Leather, Xverse, and Asigna.",
  },
  {
    q: "Are there fees?",
    a: "A small protocol fee of about 0.3% is taken on withdrawals. Shielding only costs the standard Stacks network fee.",
  },
  {
    q: "Do I need to understand zero-knowledge proofs?",
    a: "No. Everything needed to keep your notes private is generated for you, in your browser, every time you act on a note. There is nothing technical to set up or manage.",
  },
  {
    q: "Is it safe to use real STX?",
    a: "Not yet. Stacks Shield runs on public Stacks Testnet. Use testnet STX only. A mainnet release comes later.",
  },
];

const accentText: Record<string, string> = {
  primary: "bg-primary/12 text-primary",
  teal: "bg-teal/12 text-teal",
  success: "bg-success/12 text-success",
};

export function Landing() {
  const { data: stats, isLoading } = useStats();
  const { data: prices } = usePrices();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  // Protocol totals across every asset (STX / sBTC / USDCx …), bridged to USD so
  // the headline is one comparable figure rather than STX alone.
  const proto = stats?.byAsset ?? [];
  const shieldedUsd = proto.reduce((s, a) => s + a.shielded * priceFor(prices, a.symbol), 0);
  const feesUsd = proto.reduce((s, a) => s + a.fees * priceFor(prices, a.symbol), 0);

  const metrics = [
    {
      label: "Total shielded",
      value: isLoading ? "…" : shieldedUsd > 0 ? formatUsd(shieldedUsd) : `${formatNumber(stats?.shielded)} STX`,
    },
    { label: "Private notes", value: isLoading ? "…" : formatNumber(stats?.notes) },
    { label: "Operations", value: isLoading ? "…" : formatNumber(stats?.operations) },
    {
      label: "Fees collected",
      value: isLoading ? "…" : feesUsd > 0 ? formatUsd(feesUsd) : `${formatNumber(stats?.fees)} STX`,
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} className="transition-colors hover:text-foreground">
                {l.label}
              </a>
            ))}
            <Link to="/guide" className="transition-colors hover:text-foreground">
              Guide
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </Button>
            <Button asChild variant="ghost" size="sm" className="max-sm:hidden">
              <a href={LINKS.github} target="_blank" rel="noreferrer" aria-label="GitHub">
                <Github className="size-4" />
              </a>
            </Button>
            <Button asChild size="sm">
              <Link to="/dashboard">
                Launch App <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="grid-backdrop relative overflow-hidden border-b border-border">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1.1fr_0.9fr]">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
          >
            <a
              href="#how"
              className="glass inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="size-1.5 rounded-full bg-success" />
              Now live on public Stacks Testnet
              <ArrowRight className="size-3" />
            </a>

            <h1 className="mt-6 text-4xl leading-[1.05] font-semibold tracking-tight sm:text-6xl">
              Send STX <span className="text-gradient">privately</span> on Stacks
            </h1>
            <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
              Deposit STX and get a private note only you can see. Send, split, merge, and withdraw
              it with the amount and the owner hidden on-chain. Zero-knowledge proofs keep every
              move private and verifiable. You use it like a wallet.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link to="/dashboard">
                  Launch App <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={LINKS.docs} target="_blank" rel="noreferrer">
                  Read the docs
                </a>
              </Button>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              {["Non-custodial", "Zero-knowledge", "Open source"].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-success" /> {t}
                </span>
              ))}
            </div>
          </motion.div>

          {/* Hero visual: shielded balance card */}
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.12, ease: "easeOut" }}
            className="relative"
          >
            <div className="gradient-emerald rounded-3xl p-[1px] shadow-glow">
              <div className="rounded-[calc(1.5rem-1px)] bg-card p-6">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-success" /> Shielded balance
                  </span>
                  <Badge variant="outline" className="border-primary/40 text-primary">
                    Private
                  </Badge>
                </div>
                <p className="mt-4 font-display text-4xl font-semibold tracking-tight">
                  •••• <span className="text-lg text-muted-foreground">STX</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Amount decrypted only on your device
                </p>

                <div className="mt-6 space-y-2.5">
                  {[
                    { icon: ShieldCheck, label: "Shield", tone: "primary" },
                    { icon: ArrowLeftRight, label: "Transfer", tone: "teal" },
                    { icon: ArrowDownToLine, label: "Withdraw", tone: "success" },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-3 py-2.5"
                    >
                      <span className="flex items-center gap-2.5 text-sm">
                        <span
                          className={`flex size-7 items-center justify-center rounded-lg ${accentText[row.tone]}`}
                        >
                          <row.icon className="size-3.5" />
                        </span>
                        {row.label}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">•••••</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Live stats band */}
      <section className="border-b border-border bg-card/30">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 px-4 sm:px-6 lg:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.label} className="px-2 py-8 text-center">
              <p className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {m.value}
              </p>
              <p className="mt-1.5 text-xs tracking-wide text-muted-foreground uppercase">
                {m.label}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Features (bento) */}
      <Section id="features">
        <SectionTitle
          eyebrow="What you can do"
          title="Five ways to move private STX"
          body="Each one runs in your browser and settles on-chain. The cryptography is handled for you."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {primitives.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.05}>
              <div
                className={`glass h-full rounded-2xl p-6 transition-colors hover:border-primary/30 ${
                  f.span ? "sm:col-span-2 lg:col-span-1" : ""
                }`}
              >
                <span
                  className={`flex size-10 items-center justify-center rounded-xl ${accentText[f.accent]}`}
                >
                  <f.icon className="size-5" />
                </span>
                <p className="mt-4 font-display text-lg font-semibold">{f.title}</p>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            </Reveal>
          ))}
          <Reveal delay={0.25}>
            <div className="gradient-brand flex h-full flex-col justify-between rounded-2xl p-6 text-primary-foreground shadow-glow">
              <Zap className="size-6" />
              <div className="mt-6">
                <p className="font-display text-lg font-semibold">Everything runs on your device</p>
                <p className="mt-1.5 text-sm text-primary-foreground/80">
                  Zero-knowledge proofs are generated locally in your browser, so your note secrets
                  never leave it. No account to create.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* How it works */}
      <section id="how" className="border-y border-border bg-card/30">
        <Section>
          <SectionTitle eyebrow="How it works" title="From transparent to private in four steps" />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s, i) => (
              <Reveal key={s.title} delay={i * 0.06}>
                <div className="glass relative h-full rounded-2xl p-6">
                  <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
                  <s.icon className="mt-3 size-6 text-teal" />
                  <p className="mt-3 font-display text-base font-semibold">{s.title}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </Section>
      </section>

      {/* Privacy */}
      <Section id="privacy">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionTitle
              align="left"
              eyebrow="Privacy model"
              title="Your balance is yours alone"
              body="Note amounts are decrypted locally on your device. The protocol never learns who owns what, and spent notes can never be reused."
            />
            <ul className="mt-8 space-y-4">
              {privacyPoints.map((p) => (
                <li key={p.text} className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/12 text-success">
                    <p.icon className="size-4" />
                  </span>
                  <span className="pt-1 text-sm text-muted-foreground">{p.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <Reveal>
            <div className="glass rounded-3xl p-6">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Coins className="size-4 text-primary" /> How a transfer looks on-chain
              </div>
              <div className="mt-5 space-y-3 font-mono text-xs">
                <CodeRow label="sender" value="hidden" tone="success" />
                <CodeRow label="recipient" value="hidden" tone="success" />
                <CodeRow label="amount" value="hidden" tone="success" />
                <CodeRow label="nullifier" value="0x8f…a12c" tone="muted" />
                <CodeRow label="proof" value="valid ✓" tone="primary" />
              </div>
              <p className="mt-5 text-xs text-muted-foreground">
                Observers only see that a valid zero-knowledge proof landed. They never see who sent
                what, to whom, or how much.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* CTA */}
      <Section>
        <div className="gradient-brand relative overflow-hidden rounded-3xl px-6 py-14 text-center text-primary-foreground shadow-glow sm:px-12">
          <h2 className="mx-auto max-w-2xl font-display text-2xl font-semibold tracking-tight sm:text-4xl">
            Make your first private transaction
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-primary-foreground/80 sm:text-base">
            Connect a Stacks wallet, request some testnet STX, and shield it. The whole flow takes a
            couple of minutes.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" variant="secondary">
              <Link to="/dashboard">
                Launch App <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-primary-foreground/30 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <a href={LINKS.github} target="_blank" rel="noreferrer">
                <Github className="size-4" /> Star on GitHub
              </a>
            </Button>
          </div>
        </div>
      </Section>

      {/* FAQ */}
      <section id="faq" className="border-t border-border bg-card/30">
        <Section className="max-w-3xl">
          <SectionTitle eyebrow="FAQ" title="Frequently asked questions" />
          <Accordion type="single" collapsible className="mt-8">
            {faqs.map((f) => (
              <AccordionItem key={f.q} value={f.q}>
                <AccordionTrigger className="text-left">{f.q}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Section>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo />
          <p className="text-xs text-muted-foreground">
            Stacks Shield · Public Stacks Testnet · Use testnet STX only
          </p>
          <div className="flex gap-6 text-sm text-muted-foreground">
            <a href={LINKS.docs} target="_blank" rel="noreferrer" className="hover:text-foreground">
              Docs
            </a>
            <a
              href={LINKS.github}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              GitHub
            </a>
            <Link to="/dashboard" className="hover:text-foreground">
              App
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className="px-4 py-20 sm:px-6 sm:py-24">
      <div className={`mx-auto w-full ${className ?? "max-w-6xl"}`}>{children}</div>
    </section>
  );
}

function SectionTitle({
  eyebrow,
  title,
  body,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  body?: string;
  align?: "center" | "left";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <p className="text-xs font-semibold tracking-widest text-primary uppercase">{eyebrow}</p>
      <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-sm text-muted-foreground sm:text-base">{body}</p>}
    </div>
  );
}

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}

function CodeRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  const toneClass: Record<string, string> = {
    success: "text-success",
    primary: "text-primary",
    muted: "text-muted-foreground",
  };
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={toneClass[tone]}>{value}</span>
    </div>
  );
}
