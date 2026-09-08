"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { Loader } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { useTenantLogin, useTenantLoginMfa } from "@/hooks/api/use-tenant-auth";
import { getErrorMessage, isMfaChallenge } from "@heirs/api-client";
import { MfaChallengeForm } from "@heirs/ui";
import { Button } from "@heirs/ui";
import { Field } from "@heirs/ui";
import { Input } from "@heirs/ui";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof schema>;

const LoginForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useTenantLogin();
  const loginMfa = useTenantLoginMfa();

  /**
   * Set only when the password was right but the account has a second factor. It
   * is a handle to a pending login, not a session — the cookie arrives once the
   * code is redeemed below.
   */
  const [challenge, setChallenge] = useState<string>();
  const [mfaError, setMfaError] = useState<string>();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const land = () => router.replace(searchParams.get("next") || "/ocr");

  const onSubmit = handleSubmit((values) => {
    login.mutate(values, {
      onSuccess: (result) => (isMfaChallenge(result) ? setChallenge(result.challenge) : land()),
      onError: (error) => toast.error(getErrorMessage(error)),
    });
  });

  if (challenge) {
    return (
      <MfaChallengeForm
        pending={loginMfa.isPending}
        error={mfaError}
        onCancel={() => {
          setChallenge(undefined);
          setMfaError(undefined);
        }}
        onSubmit={(code) => {
          setMfaError(undefined);
          loginMfa.mutate(
            { challenge, code },
            {
              onSuccess: land,
              onError: (error) => setMfaError(getErrorMessage(error)),
            },
          );
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-2xl font-semibold tracking-tight">Welcome back</p>
        <p className="text-sm text-muted-foreground">Sign in to your Heirs OCR workspace.</p>
      </div>
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register("email")} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!errors.password}
            {...register("password")}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? <Loader className="animate-spin" /> : "Sign in"}
        </Button>
      </form>
    </div>
  );
};

const Page = () => (
  <Suspense fallback={null}>
    <LoginForm />
  </Suspense>
);

export default Page;
