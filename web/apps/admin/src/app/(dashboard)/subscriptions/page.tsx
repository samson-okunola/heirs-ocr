"use client";

import { Box } from "lucide-react";
import { useMemo } from "react";

import { DataTable, EmptyState, ErrorState, PageLayout, Skeleton } from "@/components/shared";
import { useSubscriptions, useSubscriptionSummary } from "@/hooks/api/use-admin-subscriptions";
import { createSubscriptionColumns } from "@/config/columns/subscriptions";
import { getErrorMessage } from "@heirs/api-client";
import { usePagination } from "@heirs/ui";
import { StatTile } from "@heirs/ui";
import { formatMinorCurrency } from "@heirs/ui";

/**
 * Live tenant enrolments. The plan *catalog* is managed separately under
 * `/subscription-plans`; this page shows who is on what, and what they've used.
 */

/**
 * Accrued revenue this period. Subscriptions snapshot their own plan, so tenants can
 * legitimately be on different currencies — summing across them would be nonsense.
 * Totalled per currency and rendered as the dominant one, with the rest as a hint.
 */
const money = (currency: string, minor: number): string => formatMinorCurrency(minor, currency);

const Page = () => {
  const { params, tableProps } = usePagination();
  // The table shows a page; the tiles describe the whole estate. Two queries, because
  // they are two different questions — this page used to answer both by downloading
  // the entire catalog and cutting it in the browser.
  const subscriptions = useSubscriptions(params);
  const summary = useSubscriptionSummary();
  const columns = useMemo(() => createSubscriptionColumns(), []);

  const subs = subscriptions.data?.items ?? [];
  const accrued = summary.data?.accruedByCurrency ?? [];

  return (
    <PageLayout
      title="Subscriptions"
      subtitle="Every tenant's live plan enrolment, status, and usage this billing period."
    >
      <div className="space-y-6">
        {subscriptions.isError && (
          <ErrorState
            title="Couldn't load subscriptions"
            description={getErrorMessage(subscriptions.error)}
            onRetry={() => subscriptions.refetch()}
            retrying={subscriptions.isFetching}
          />
        )}
        {subscriptions.isPending ? (
          <Skeleton skeleton="table" columns={5} rows={6} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <StatTile label="Subscriptions" value={summary.data?.total ?? 0} />
              <StatTile label="Serving" value={summary.data?.serving ?? 0} hint="active or trialing" tone="success" />
              <StatTile
                label="Needs attention"
                value={summary.data?.attention ?? 0}
                hint={(summary.data?.attention ?? 0) > 0 ? "past due or suspended" : "none past due"}
                tone={(summary.data?.attention ?? 0) > 0 ? "warning" : "default"}
              />
              <StatTile
                tone="notable"
                label="Accrued this period"
                // Plans may price in different currencies; the largest leads and the
                // rest sit underneath, because adding them together would be nonsense.
                value={accrued.length ? money(accrued[0]!.currency, accrued[0]!.amountMinor) : "—"}
                hint={
                  accrued.length > 1
                    ? accrued
                        .slice(1)
                        .map((a) => money(a.currency, a.amountMinor))
                        .join(" · ")
                    : undefined
                }
              />
            </div>
            {subs.length === 0 && !subscriptions.isError ? (
              <EmptyState
                icon={Box}
                title="No subscriptions yet"
                description="Assign a plan to a tenant from the Tenants page to enrol them."
              />
            ) : (
              <DataTable columns={columns} data={subs} total={subscriptions.data?.total ?? 0} {...tableProps} />
            )}
          </>
        )}
      </div>
    </PageLayout>
  );
};

export default Page;
