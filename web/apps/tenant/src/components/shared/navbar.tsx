"use client";

import { useState } from "react";
import Link from "next/link";

import { Menu, X, ScanText } from "lucide-react";
import { Button } from "@heirs/ui";

const links = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#pricing", label: "Pricing" },
];

export const Navbar = () => {
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold text-foreground">
          <ScanText className="size-5 text-primary" />
          <span>Heirs OCR</span>
        </Link>
        <div className="hidden items-center gap-6 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <Button variant="ghost" size="sm" render={<Link href="/login">Sign In</Link>}></Button>
          <Button size="sm" render={<Link href="/register">Get started</Link>}></Button>
        </div>
        <button className="md:hidden" onClick={() => setOpen((v) => !v)} aria-label="Toggle menu">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <div className="border-t bg-background px-4 pb-4 md:hidden">
          <div className="flex flex-col gap-3 pt-3">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="text-sm text-muted-foreground" onClick={() => setOpen(false)}>
                {l.label}
              </Link>
            ))}
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                render={<Link href="/login">Sign In</Link>}
              ></Button>
              <Button size="sm" className="flex-1" render={<Link href="/login">Get started</Link>}></Button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
};
