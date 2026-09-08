"use client";

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Loader } from "lucide-react";
import { Suspense } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { useTenantVerification } from "@/hooks/api/use-tenant-auth";
import { getErrorMessage } from "@heirs/api-client";
import { Button } from "@heirs/ui";
import { Field } from "@heirs/ui";
import { Input } from "@heirs/ui";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  otp: z.string().min(1, ""),
});

type FormValues = z.infer<typeof schema>;

const Page = () => {
  const verify = useTenantVerification();
  const router = useRouter();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit((values) => {
    verify.mutate(values, {
      onSuccess: () => {
        router.replace("/verification");
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    });
  });

  return (
    <Suspense>
      <div className="spce-y-6">
        <div className="space-y-1">
          <p className="text-2xl font-semibold tracking-tight">Complete Registration</p>
          <p className="text-sm text-muted-foreground"></p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register("email")} />
          </Field>
          <Button type="submit" className="w-full" disabled={verify.isPending}>
            {verify.isPending ? <Loader className="animate-spin" /> : "Register"}
          </Button>
        </form>
      </div>
    </Suspense>
  );
};

export default Page;
