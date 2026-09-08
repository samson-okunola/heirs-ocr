"use client";

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Loader } from "lucide-react";
import { Suspense } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Select, SelectContent, SelectTrigger, SelectValue } from "@heirs/ui";
import { useTenantRegister } from "@/hooks/api/use-tenant-auth";
import { getErrorMessage } from "@heirs/api-client";
import { Button } from "@heirs/ui";
import { Field } from "@heirs/ui";
import { Input } from "@heirs/ui";

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
  name: z.string().min(1, "Name is required"),
  organizationName: z.string().min(1, ""),
  planId: z.string().min(1, ""),
});

type FormValues = z.infer<typeof schema>;

const Page = () => {
  const signup = useTenantRegister();
  const router = useRouter();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit((values) => {
    signup.mutate(values, {
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
          <p className="text-2xl font-semibold tracking-tight">Register</p>
          <p className="text-sm text-muted-foreground"></p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <Field label="Name" htmlFor="name" error={errors.name?.message}>
            <Input id="name" type="text" autoComplete="name" aria-invalid={!!errors.name} {...register("name")} />
          </Field>
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register("email")} />
          </Field>
          <Field label="Organization" htmlFor="organizationName" error={errors.organizationName?.message}>
            <Input
              id="organizationName"
              type="text"
              autoComplete="organizationName"
              aria-invalid={!!errors.organizationName}
              {...register("organizationName")}
            />
          </Field>
          <Field label="Plan" htmlFor="planId" error={errors.planId?.message}>
            <Select>
              <SelectTrigger className="">
                <SelectValue />
              </SelectTrigger>
              <SelectContent></SelectContent>
            </Select>
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
          <Button type="submit" className="w-full" disabled={signup.isPending}>
            {signup.isPending ? <Loader className="animate-spin" /> : "Register"}
          </Button>
        </form>
      </div>
    </Suspense>
  );
};

export default Page;
