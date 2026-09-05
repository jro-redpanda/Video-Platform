import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBillingCatalog,
  useGetBillingSubscription,
  useReconcileBillingSubscription,
  getGetBillingCatalogQueryKey,
  getGetBillingSubscriptionQueryKey,
  getGetWorkspaceQueryKey,
  getListBillingInvoicesQueryKey,
} from "@workspace/api-client-react";
import { getSafeStripeUrl } from "@/lib/frontend-safety";

export function useBilling() {
  const queryClient = useQueryClient();
  const catalog = useGetBillingCatalog();
  const subscription = useGetBillingSubscription();
  const reconcile = useReconcileBillingSubscription();

  const [isReconciling, setIsReconciling] = useState(false);
  const attempted = useRef(false);
  const pollingRef = useRef<number | null>(null);

  const invalidateBilling = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetBillingCatalogQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetBillingSubscriptionQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListBillingInvoicesQueryKey() });
  }, [queryClient]);

  useEffect(() => {
    if (attempted.current) return;
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const billingParam = params.get("billing");

    if (billingParam) {
      attempted.current = true;
      setIsReconciling(true);

      const cleanupUrl = () => {
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete("billing");
        window.history.replaceState({}, "", newUrl.toString());
      };

      if (billingParam === "cancelled") {
        invalidateBilling();
        setIsReconciling(false);
        cleanupUrl();
      } else if (billingParam === "success" || billingParam === "portal") {
        const key = crypto.randomUUID();
        reconcile.mutate({ data: { idempotencyKey: key } }, {
          onSettled: () => {
            invalidateBilling();
            setIsReconciling(false);
            cleanupUrl();
            
            if (billingParam === "success") {
              // Poll for a bounded period since webhooks can lag
              let polls = 0;
              const maxPolls = 10;
              
              if (pollingRef.current) clearInterval(pollingRef.current);
              
              pollingRef.current = window.setInterval(() => {
                polls++;
                queryClient.invalidateQueries({ queryKey: getGetBillingSubscriptionQueryKey() });
                queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() });
                if (polls >= maxPolls && pollingRef.current) {
                  clearInterval(pollingRef.current);
                  pollingRef.current = null;
                }
              }, 3000);
            }
          }
        });
      } else {
        setIsReconciling(false);
      }
    }
    
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [reconcile, invalidateBilling, queryClient]);

  return {
    catalog: catalog.data,
    isCatalogLoading: catalog.isLoading,
    subscription: subscription.data,
    isSubscriptionLoading: subscription.isLoading,
    isReconciling,
  };
}

export function safeRedirect(url: string) {
  const trustedUrl = getSafeStripeUrl(url);
  if (trustedUrl) {
    window.location.assign(trustedUrl);
    return true;
  }
  console.error("Blocked an untrusted billing redirect URL.");
  return false;
}
