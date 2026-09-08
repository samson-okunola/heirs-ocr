import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function removeNullOrUndefined<
  T extends {
    [K in keyof T]: T[K] | null | undefined;
  },
>(params: T | null | undefined) {
  if (params == null) return {} as Partial<T>;
  const cleaned = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
  return cleaned as Partial<T>;
}
