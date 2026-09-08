"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Loader } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { useTenantResendVerification, useTenantVerification } from "@/hooks/api/use-tenant-auth";
import { getErrorMessage } from "@heirs/api-client";
import { OtpInput } from "@heirs/ui";
import { Button } from "@heirs/ui";
import { Field } from "@heirs/ui";
import { Input } from "@heirs/ui";

/**
 * The second half of signup. Nothing has been created at this point: the code is
 * what turns the details held on the server into a real workspace, and redeeming it
 * also signs the new owner in — so this lands on the dashboard, not back on /login.
 */
const VerificationForm = () => {
  const searchParams = useSearchParams();
  const verify = useTenantVerification();
  const resend = useTenantResendVerification();
  const router = useRouter();

  // Carried over from /register. Editable, because someone may arrive here from a
  // link in the email on a different device, with no query string at all.
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string>();

  const complete = otp.length === 6 && email.trim().length > 0;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    setError(undefined);

    verify.mutate(
      { email: email.trim(), otp },
      {
        onSuccess: ({ apiKey }) => {
          // Shown once and never recoverable — say so before the dashboard replaces
          // this screen, and keep it on screen until dismissed.
          toast.success("Workspace created. Your API key is on the Keys page.", {
            description: apiKey,
            duration: Infinity,
            closeButton: true,
          });
          router.replace("/ocr");
        },
        onError: (mutationError) => {
          setOtp("");
          setError(getErrorMessage(mutationError));
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-2xl font-semibold tracking-tight">Check your email</p>
        <p className="text-muted-foreground text-sm text-pretty">
          We sent a 6-digit code to {email || "the address you registered with"}. It expires shortly, and your workspace
          is created the moment you enter it.
        </p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly
          />
        </Field>
        <Field label="Verification code" error={error}>
          <OtpInput value={otp} onChange={setOtp} disabled={verify.isPending} />
        </Field>
        <Button type="submit" className="w-full" disabled={verify.isPending || !complete}>
          {verify.isPending ? <Loader className="animate-spin" /> : "Create workspace"}
        </Button>
      </form>

      <div className="text-muted-foreground space-y-2 text-sm">
        <p>
          Didn&rsquo;t get it? Check spam, then{" "}
          <button
            type="button"
            className="text-foreground underline disabled:opacity-50"
            disabled={resend.isPending || !email.trim()}
            onClick={() =>
              resend.mutate(
                { email: email.trim() },
                {
                  onSuccess: () => toast.success("Sent. The previous code no longer works."),
                  onError: (resendError) => toast.error(getErrorMessage(resendError)),
                },
              )
            }
          >
            send another code
          </button>
          .
        </p>
        <p>
          Already verified?{" "}
          <Link href="/login" className="text-foreground underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
};

const Page = () => (
  <Suspense fallback={null}>
    <VerificationForm />
  </Suspense>
);

export default Page;
