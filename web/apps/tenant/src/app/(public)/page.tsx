import Link from "next/link";
import {
  ScanText,
  FileText,
  ShieldCheck,
  Zap,
  ArrowRight,
  Receipt,
  IdCard,
  BarChart3,
  FileSearch,
  Check,
} from "lucide-react";

import { Button, Badge } from "@heirs/ui";

const functions = [
  { icon: ScanText, label: "Text Extraction", desc: "Canonical markdown from any file type" },
  { icon: Receipt, label: "Receipt Parsing", desc: "Merchant, line items, totals, tax" },
  { icon: IdCard, label: "ID Verification", desc: "ID fields + MRZ, verified deterministically" },
  { icon: BarChart3, label: "Bank Statement Analysis", desc: "Transactions, balances, inflow/outflow" },
  { icon: FileSearch, label: "Document Classification", desc: "Label any document into a type" },
  { icon: FileText, label: "Form Data Extraction", desc: "Caller-defined fields, dynamic schema" },
];

const pillars = [
  {
    icon: Zap,
    title: "One API, 13 functions",
    body: "Receipt parsing, ID verification, bank statements, and more — all behind a single endpoint.",
  },
  {
    icon: ShieldCheck,
    title: "Deterministic validation",
    body: "MRZ checksums, receipt totals, and tamper signals are recomputed in code. The LLM extracts; verdicts are never trusted to the model.",
  },
  {
    icon: FileText,
    title: "Any input format",
    body: "PDF, image, DOCX, or plain text — normalized into one canonical representation before interpretation.",
  },
];

const plans = [
  {
    name: "Free Trial",
    price: "₦0",
    sub: "14 days",
    desc: "Explore all standard functions with no commitment.",
    cta: "Start free trial",
    featured: false,
    features: ["50 documents included", "Standard functions only", "5 pages per document", "Community support"],
  },
  {
    name: "Pay As You Go",
    price: "₦150",
    sub: "/ document",
    desc: "No monthly fee. Pay only for what you process.",
    cta: "Get started",
    featured: false,
    features: ["All standard functions", "No monthly minimum", "Up to 30 pages / doc", "Email support"],
  },
  {
    name: "Starter",
    price: "₦25,000",
    sub: "/ month",
    desc: "For teams with predictable monthly volume.",
    cta: "Get started",
    featured: true,
    features: ["500 documents / month", "All standard functions", "Async job queue", "Webhooks", "Priority processing"],
  },
  {
    name: "Business",
    price: "₦75,000",
    sub: "/ month",
    desc: "PII functions, higher limits, and SLA support.",
    cta: "Get started",
    featured: false,
    features: [
      "2,000 documents / month",
      "PII functions (ID, Loan, Bank)",
      "Extended data retention",
      "Custom form schemas",
      "SLA support",
    ],
  },
];

const snippet = `POST /v1/ocr/RECEIPT_PARSING
Authorization: Bearer hok_live_<key>
Content-Type: multipart/form-data

{
  "requestId": "req_01J...",
  "function": "RECEIPT_PARSING",
  "result": {
    "merchant": { "name": "Shoprite" },
    "currency": "NGN",
    "lineItems": [...],
    "subtotal": 4275.00,
    "tax": 475.00,
    "total": 4750.00,
    "confidence": "high"
  }
}`;

export default function Page() {
  return (
    <div className="overflow-y-auto">
      <section className="relative overflow-hidden border-b bg-linear-to-b from-background to-muted/30">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 text-center">
          <Badge variant="outline" className="mb-6 gap-1.5">
            <ScanText className="size-3" /> 13 document functions
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Turn any document into
            <br />
            <span className="text-primary">structured data</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            One uniform API. Upload a file, pick a function, get back typed JSON. Extraction is shared; interpretation
            is per-function.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              render={
                <Link href="/register">
                  Get started <ArrowRight className="size-4" />
                </Link>
              }
            ></Button>
            <Button
              size="lg"
              variant="outline"
              render={<Link href="/v1/ocr/functions">Browse functions</Link>}
            ></Button>
          </div>
        </div>
      </section>
      <section id="how-it-works" className="border-b py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">How it works</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight">
                Extraction is shared. Interpretation is per-function.
              </h2>
              <p className="mt-4 text-muted-foreground">
                Every upload is ingested once — magic-byte sniffed, sha256-keyed, and cached. The same document hitting
                two functions pays for OCR once. A per-function LLM step runs on top of the canonical representation.
              </p>
              <ul className="mt-6 flex flex-col gap-3">
                {[
                  "Ingest → sniff + sha256 + validate",
                  "Extract → provider → RecognizedDocument",
                  "Interpret → fn.execute → structured output",
                  "Validate → Zod + business rules → typed result",
                ].map((step, i) => (
                  <li key={step} className="flex items-start gap-3 text-sm">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {i + 1}
                    </span>
                    <span className="text-muted-foreground">{step}</span>
                  </li>
                ))}
              </ul>
            </div>
            <pre className="overflow-x-auto rounded-xl border bg-muted/50 p-5 text-xs leading-relaxed text-foreground font-mono">
              {snippet}
            </pre>
          </div>
        </div>
      </section>
      <section id="features" className="border-b py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Features</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">Built for production</h2>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {pillars.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border bg-card p-6">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="size-5 text-primary" />
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="border-b py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Functions</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">13 ready-to-use parsers</h2>
            <p className="mt-3 text-muted-foreground">
              Discoverable at runtime via{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">GET /v1/ocr/functions</code>
            </p>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {functions.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-start gap-4 rounded-xl border bg-card p-5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="size-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section id="pricing" className="border-b py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Pricing</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">Simple, transparent pricing</h2>
            <p className="mt-3 text-muted-foreground">Start free. Scale as you grow. All prices in NGN.</p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`relative flex flex-col rounded-xl border bg-card p-6 ${
                  plan.featured ? "border-primary ring-1 ring-primary" : ""
                }`}
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-primary-foreground">
                    Most popular
                  </span>
                )}
                <p className="text-sm font-semibold">{plan.name}</p>
                <div className="mt-3 flex items-end gap-1">
                  <span className="text-3xl font-bold tracking-tight">{plan.price}</span>
                  {plan.sub && <span className="mb-1 text-xs text-muted-foreground">{plan.sub}</span>}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{plan.desc}</p>
                <ul className="mt-5 flex flex-1 flex-col gap-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
                        <Check className="size-3" />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant={plan.featured ? "default" : "outline"}
                  className="mt-6 w-full"
                  render={<Link href="/login">{plan.cta}</Link>}
                />
              </div>
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Need a custom volume deal?{" "}
            <Link
              href="mailto:support@heirstechnologies.com"
              className="text-primary underline-offset-4 hover:underline"
            >
              Contact us
            </Link>
          </p>
        </div>
      </section>
      <section className="py-24">
        <div className="mx-auto max-w-2xl px-4 text-center sm:px-6">
          <h2 className="text-3xl font-bold tracking-tight">Ready to get started?</h2>
          <p className="mt-4 text-muted-foreground">
            Sign up, provision an API key, and make your first call in minutes.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button
              size="lg"
              render={
                <Link href="/login">
                  Create an account <ArrowRight className="size-4" />
                </Link>
              }
            ></Button>
            <Button size="lg" variant="outline" render={<Link href="/api-reference">View API docs</Link>}></Button>
          </div>
        </div>
      </section>
    </div>
  );
}
