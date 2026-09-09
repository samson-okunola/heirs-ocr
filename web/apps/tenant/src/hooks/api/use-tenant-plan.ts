import { useQuery } from "@tanstack/react-query";

import { http, unwrap, type Paginated, type PaginatedParams } from "@heirs/api-client";
import { tenantKeys } from "./query-keys";
import type { Plan } from "@/types/plan";

/**
 * The self-serve plan catalog, via the tenant BFF proxy (`/api/tenant/*` → backend
 * `/tenant/api/*`).
 *
 * Open on purpose: the register form has to render the choices before anyone has an
 * account. The backend filters `hidden` plans out, so bespoke enterprise deals never
 * appear here — they are assigned by an operator.
 */
export function useTenantPlans(params?: PaginatedParams) {
  return useQuery({
    queryKey: tenantKeys.planList(params),
    queryFn: () => http.get<Paginated<Plan>>("/api/plans", params).then(unwrap),
    retry: false,
  });
}
