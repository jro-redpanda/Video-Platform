import { useState, useRef } from "react"
import { BillingCatalog, BillingSubscription, useCreateBillingCheckout, useChangeBillingPlan, BillingPlanInputPlan, BillingPlanInputInterval } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardFooter, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Check, Loader2 } from "lucide-react"
import { safeRedirect } from "@/hooks/use-billing"
import { useToast } from "@/components/ui/use-toast"

export function PlanComparison({ catalog, subscription }: { catalog: BillingCatalog, subscription: BillingSubscription }) {
  const [interval, setInterval] = useState<BillingPlanInputInterval>('month');
  const checkout = useCreateBillingCheckout();
  const changePlan = useChangeBillingPlan();
  const { toast } = useToast();

  const intentKeys = useRef<Record<string, string>>({});
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  const getIntentKey = (action: string) => {
    if (!intentKeys.current[action]) {
      intentKeys.current[action] = crypto.randomUUID();
    }
    return intentKeys.current[action];
  };

  const clearIntentKey = (action: string) => {
    delete intentKeys.current[action];
  };

  const canManage = subscription.capabilities.canManage;
  const isNew = subscription.capabilities.canSubscribe;

  let maxSavingsPercent = 0;
  catalog.plans.forEach(plan => {
    const mPrice = plan.prices.find(p => p.interval === 'month');
    const aPrice = plan.prices.find(p => p.interval === 'year');
    if (mPrice && aPrice && mPrice.amount > 0) {
      const savings = (mPrice.amount * 12) - aPrice.amount;
      const pct = Math.round((savings / (mPrice.amount * 12)) * 100);
      if (pct > maxSavingsPercent) maxSavingsPercent = pct;
    }
  });

  const handleSelectPlan = (planCode: BillingPlanInputPlan, priceAmount: number) => {
    if (!canManage) return;

    setPendingPlan(planCode);
    const intentId = `plan_${planCode}_${interval}`;
    const idempotencyKey = getIntentKey(intentId);

    if (isNew) {
      const displayPrice = `$${priceAmount / 100}/${interval === 'year' ? 'yr' : 'mo'}`;
      if (!confirm(`You are about to subscribe to the ${planCode} plan at ${displayPrice}.\n\nYou will be redirected to Stripe to securely enter your payment details. Access changes will apply only after your payment is confirmed.\n\nProceed to checkout?`)) {
        setPendingPlan(null);
        clearIntentKey(intentId);
        return;
      }

      checkout.mutate({ data: { plan: planCode, interval, idempotencyKey } }, {
        onSuccess: (res) => {
          clearIntentKey(intentId);
          if (!safeRedirect(res.url)) {
            setPendingPlan(null);
            toast({
              title: "Checkout could not be opened",
              description: "The billing provider returned an invalid checkout address. Please try again.",
              variant: "destructive",
            });
          }
        },
        onError: () => {
           setPendingPlan(null);
           toast({ title: "Checkout failed", description: "Could not start checkout. Please try again.", variant: "destructive" });
        }
      });
    } else {
      if (!confirm(`Are you sure you want to change your plan to ${planCode}?`)) {
        setPendingPlan(null);
        clearIntentKey(intentId);
        return;
      }

      changePlan.mutate({ data: { plan: planCode, interval, idempotencyKey } }, {
        onSuccess: (res) => {
          setPendingPlan(null);
          clearIntentKey(intentId);
          if (res.scheduled) {
            toast({ title: "Plan change scheduled", description: `Your plan will change on ${res.effectiveAt ? new Date(res.effectiveAt).toLocaleDateString() : 'your next billing date'}.` });
          } else {
            toast({ title: "Plan updated", description: "Your subscription has been successfully updated." });
          }
        },
        onError: () => {
          setPendingPlan(null);
          toast({ title: "Update failed", description: "Could not update your plan. Please try again.", variant: "destructive" });
        }
      });
    }
  }

  if (catalog.plans.length === 0) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Available Plans</h2>
          <p className="text-muted-foreground mt-1">Choose the scale and capabilities that fit your operations.</p>
        </div>

        <div className="bg-muted p-1 border rounded-lg inline-flex relative shadow-sm shrink-0">
          <button
            className={`px-5 py-2 text-sm font-semibold rounded-md transition-all ${interval === 'month' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setInterval('month')}
          >
            Monthly
          </button>
          <button
            className={`px-5 py-2 text-sm font-semibold rounded-md transition-all ${interval === 'year' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setInterval('year')}
          >
            Annually {maxSavingsPercent > 0 && <span className="text-emerald-500 font-bold ml-1.5 bg-emerald-500/10 px-1.5 py-0.5 rounded text-xs tracking-tight">Save {maxSavingsPercent}%</span>}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        {catalog.plans.map(plan => {
          const monthlyPrice = plan.prices.find(p => p.interval === 'month');
          const annualPrice = plan.prices.find(p => p.interval === 'year');

          const monthlyAmount = monthlyPrice ? monthlyPrice.amount / 100 : 0;
          const annualAmount = annualPrice ? annualPrice.amount / 100 : 0;

          const currentDisplayPrice = interval === 'month' ? monthlyPrice : annualPrice;
          const displayAmount = currentDisplayPrice ? currentDisplayPrice.amount / 100 : 0;

          const monthlyEquivalent = annualPrice ? Math.floor(annualPrice.amount / 12) / 100 : 0;
          const yearlySavings = (monthlyAmount * 12) - annualAmount;

          const isActivePlan = subscription.plan === plan.code && subscription.interval === interval && subscription.status === 'active' && !subscription.pendingPlan;
          const isPendingTarget = subscription.pendingPlan === plan.code;

          return (
            <Card key={plan.code} className={`flex flex-col relative transition-all duration-300 ${isActivePlan ? 'border-primary ring-2 ring-primary/20 shadow-lg' : 'hover:border-primary/40 hover:shadow-md'}`}>
              {isActivePlan && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary text-primary-foreground text-xs font-bold rounded-full uppercase tracking-wider shadow-sm">
                  Current Plan
                </div>
              )}
              {isPendingTarget && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 bg-amber-500 text-white text-xs font-bold rounded-full uppercase tracking-wider shadow-sm">
                  Scheduled
                </div>
              )}

              <CardHeader className="pb-4">
                <CardTitle className="text-2xl capitalize tracking-tight">{plan.name}</CardTitle>
                <CardDescription className="min-h-[2.5rem] mt-1 text-sm">{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-6">
                <div className="p-4 bg-muted/30 rounded-xl border border-border/50">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-4xl font-extrabold tracking-tight">${interval === 'year' ? monthlyEquivalent : displayAmount}</span>
                    <span className="text-sm font-medium text-muted-foreground">/mo</span>
                  </div>
                  {interval === 'year' && displayAmount > 0 && (
                    <div className="text-sm text-emerald-600 dark:text-emerald-400 font-medium mt-1.5">
                      Billed ${displayAmount} annually (Save ${yearlySavings}/yr)
                    </div>
                  )}
                  {interval === 'month' && displayAmount > 0 && (
                    <div className="text-sm text-transparent font-medium mt-1.5 select-none" aria-hidden>
                      Spacer for layout
                    </div>
                  )}
                </div>

                <ul className="space-y-3.5 text-sm pt-2">
                  {Object.entries(plan.entitlements || {}).map(([key, val]) => {
                    if (val === false || val === null || typeof val === 'object') return null;
                    return (
                      <li key={key} className="flex items-start gap-3">
                        <div className="mt-0.5 w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <Check className="h-3 w-3 text-primary" strokeWidth={3} />
                        </div>
                        <span className="text-muted-foreground font-medium leading-snug">
                          {typeof val === 'boolean'
                            ? key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())
                            : <><strong className="text-foreground">{String(val)}</strong> {key.replace(/([A-Z])/g, ' $1').toLowerCase()}</>}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </CardContent>
              <CardFooter className="pt-6">
                <Button
                  className="w-full font-semibold shadow-sm transition-all"
                  size="lg"
                  variant={isActivePlan ? "secondary" : "default"}
                  disabled={isActivePlan || !canManage || (subscription.status === 'restricted' && !isNew) || pendingPlan === plan.code || isPendingTarget}
                  onClick={() => handleSelectPlan(plan.code as BillingPlanInputPlan, currentDisplayPrice ? currentDisplayPrice.amount : 0)}
                >
                  {pendingPlan === plan.code ? (
                    <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Processing...</>
                  ) : isActivePlan ? (
                    "Current Plan"
                  ) : isPendingTarget ? (
                    "Scheduled"
                  ) : isNew ? (
                    "Subscribe"
                  ) : (
                    "Change Plan"
                  )}
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
