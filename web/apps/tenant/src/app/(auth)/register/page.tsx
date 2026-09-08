"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader } from "lucide-react";
import { Suspense, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { z } from "zod";

import { useTenantRegister } from "@/hooks/api/use-tenant-auth";
import { useTenantPlans } from "@/hooks/api/use-tenant-plan";
import { getErrorMessage } from "@heirs/api-client";
import { planOptionLabel } from "@/lib/plans";
import { SelectOption } from "@heirs/ui";
import { Button } from "@heirs/ui";
import { Field } from "@heirs/ui";
import { Input } from "@heirs/ui";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
  name: z.string().min(1, "Your name is required"),
  organizationName: z.string().min(1, "An organization name is required"),
  planId: z.string().min(1, "Choose a plan"),
});

type FormValues = z.infer<typeof schema>;

const RegisterForm = () => {
  const plans = useTenantPlans({ page: 1, pageSize: 20 });
  const searchParams = useSearchParams();
  const signup = useTenantRegister();
  const router = useRouter();

  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const available = plans.data?.items ?? [];
  const planOptions = available.map((plan) => ({ label: planOptionLabel(plan), value: plan.id }));

  /**
   * A plan chosen from the landing page's pricing cards arrives as `?plan=`. It is
   * applied once the catalog has loaded and only if it names a real plan — a stale
   * or hand-edited link must not preselect something that isn't on offer.
   *
   * Adjusting state during render rather than in an effect: the value is derived
   * from props, and an effect would render the empty picker first.
   */
  const [appliedPlan, setAppliedPlan] = useState<string | null>(null);
  const requested = searchParams.get("plan");
  if (available.length > 0 && appliedPlan === null) {
    setAppliedPlan(requested ?? "");
    if (requested && available.some((plan) => plan.id === requested)) setValue("planId", requested);
  }

  const onSubmit = handleSubmit((values) => {
    signup.mutate(values, {
      // No workspace exists yet — the code decides that. Carry the email forward so
      // the next screen doesn't ask for something already typed.
      onSuccess: ({ email }) => router.replace(`/verification?email=${encodeURIComponent(email)}`),
      onError: (error) => toast.error(getErrorMessage(error)),
    });
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-2xl font-semibold tracking-tight">Create your workspace</p>
        <p className="text-muted-foreground text-sm text-pretty">
          We&rsquo;ll email you a code to confirm the address before anything is created.
        </p>
      </div>
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <Field label="Your name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" type="text" autoComplete="name" aria-invalid={!!errors.name} {...register("name")} />
        </Field>
        <Field label="Work email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register("email")} />
        </Field>
        <Field
          label="Organization"
          htmlFor="organizationName"
          error={errors.organizationName?.message}
          hint="The name your team will see. You can change it later."
        >
          <Input
            id="organizationName"
            type="text"
            autoComplete="organization"
            aria-invalid={!!errors.organizationName}
            {...register("organizationName")}
          />
        </Field>
        <Field
          label="Plan"
          htmlFor="planId"
          error={
            errors.planId?.message ?? (plans.isError ? "Could not load the plans. Refresh to try again." : undefined)
          }
          hint={plans.isError ? undefined : "Start on the free trial if you're evaluating — you can move up any time."}
        >
          {/* `SelectOption` is not an input, so it is driven through the form rather
              than registered on it. */}
          <Controller
            control={control}
            name="planId"
            render={({ field }) => (
              <SelectOption
                id="planId"
                value={field.value}
                onValueChange={field.onChange}
                options={planOptions}
                disabled={plans.isPending || planOptions.length === 0}
                aria-invalid={!!errors.planId}
                placeholder={
                  plans.isPending ? "Loading plans…" : planOptions.length === 0 ? "No plans available" : "Choose a plan"
                }
              />
            )}
          />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            {...register("password")}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={signup.isPending}>
          {signup.isPending ? <Loader className="animate-spin" /> : "Create workspace"}
        </Button>
      </form>
      <p className="text-muted-foreground text-sm text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-foreground underline">
          Sign in
        </Link>
      </p>
    </div>
  );
};

const Page = () => (
  <Suspense fallback={null}>
    <RegisterForm />
  </Suspense>
);

export default Page;
