import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Logo } from "@/shared/components/brand/Logo";

/**
 * A minimal, wallet-free page shell for the legal pages (Terms, Privacy). Content
 * is rendered as a readable prose column with consistent heading styles.
 */
export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link to="/">
            <Logo />
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {updated}</p>
        <div
          className={[
            "mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground",
            "[&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground",
            "[&_h2]:tracking-tight [&_p]:mt-3",
            "[&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5",
            "[&_a]:text-primary [&_a]:underline [&_strong]:text-foreground",
          ].join(" ")}
        >
          {children}
        </div>

        <div className="mt-12 border-t border-border pt-6 text-xs text-muted-foreground">
          <Link to="/terms" className="hover:text-foreground">
            Terms of Service
          </Link>
          {" · "}
          <Link to="/privacy" className="hover:text-foreground">
            Privacy Policy
          </Link>
        </div>
      </main>
    </div>
  );
}
