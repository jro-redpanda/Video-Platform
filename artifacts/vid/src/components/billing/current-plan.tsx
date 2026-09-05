import { useRef } from "react";
import { BillingSubscription, useCreateBillingPortal, useCancelBillingSubscription, useResumeBillingSubscription, getGetBillingSubscriptionQueryKey } from "@workspace/api-client-react"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CreditCard, ExternalLink, AlertTriangle, Play } from "lucide-react"
import { safeRedirect } from "@/hooks/use-billing"
import { useToast } from "@/components/ui/use-toast"
import { useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"

export function CurrentPlan({ subscription }: { subscription: BillingSubscription }) {
  const portal = useCreateBillingPortal();
  const cancel = useCancelBillingSubscription();
  const resume = useResumeBillingSubscription();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const intentKeys = useRef<Record<string, string>>({});

  const getIntentKey = (action: string) => {
    if (!intentKeys.current[action]) {
      intentKeys.current[action] = crypto.randomUUID();
    }
    return intentKeys.current[action];
  };

  const clearIntentKey = (action: string) => {
    delete intentKeys.current[action];
  };

  const handlePortal = () => {
    portal.mutate({ data: { idempotencyKey: getIntentKey('portal') } }, {
      onSuccess: (data) => {
        clearIntentKey('portal');
        if (!safeRedirect(data.url)) {
          toast({
            title: "Customer portal could not be opened",
            description: "The billing provider returned an invalid portal address. Please try again.",
            variant: "destructive",
          });
        }
      },
      onError: () => toast({ title: "Error", description: "Could not open customer portal.", variant: "destructive" })
    });
  }

  const handleCancel = () => {
    if (!confirm("Are you sure you want to cancel your subscription? You will retain access until the end of your current billing period.")) {
      clearIntentKey('cancel');
      return;
    }
    cancel.mutate({ data: { idempotencyKey: getIntentKey('cancel') } }, {
      onSuccess: () => {
        clearIntentKey('cancel');
        toast({ title: "Subscription canceled", description: "Your subscription will not renew at the end of the period." });
        queryClient.invalidateQueries({ queryKey: getGetBillingSubscriptionQueryKey() });
      },
      onError: () => toast({ title: "Error", description: "Failed to cancel subscription.", variant: "destructive" })
    });
  }

  const handleResume = () => {
    resume.mutate({ data: { idempotencyKey: getIntentKey('resume') } }, {
      onSuccess: () => {
        clearIntentKey('resume');
        toast({ title: "Subscription resumed", description: "Your subscription has been restored and will renew normally." });
        queryClient.invalidateQueries({ queryKey: getGetBillingSubscriptionQueryKey() });
      },
      onError: () => toast({ title: "Error", description: "Failed to resume subscription.", variant: "destructive" })
    });
  }

  const canManage = subscription.capabilities.canManage;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" /> Current Subscription
        </CardTitle>
        <CardDescription>Manage your active plan, view limits, and update payment methods.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {subscription.status === 'unmanaged' ? (
          <div className="p-4 border rounded-lg bg-muted/20">
            <h3 className="font-medium">Unmanaged Workspace</h3>
            <p className="text-sm text-muted-foreground mt-1">This workspace is currently on a grandfathered or unmanaged plan. Upgrade to a modern plan below to access new features and expanded limits.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 border rounded-lg bg-primary/5 border-primary/20 gap-4">
              <div>
                <div className="font-semibold text-xl capitalize flex items-center gap-2">
                  {subscription.plan || 'No Plan'} Plan
                  <Badge variant={
                    subscription.status === 'active' || subscription.status === 'trialing' ? 'default' : 
                    subscription.status === 'canceled' ? 'secondary' : 'destructive'
                  } className="capitalize text-xs font-medium">
                    {subscription.status.replace('_', ' ')}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {subscription.interval ? `Billed ${subscription.interval}ly` : 'No active billing interval'}
                  {subscription.periodEnd && !subscription.cancelAtPeriodEnd && ` • Renews ${format(new Date(subscription.periodEnd), "MMM d, yyyy")}`}
                </div>
              </div>
            </div>

            {subscription.pendingPlan && (
              <div className="flex items-start gap-2 p-3.5 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-md text-sm border border-amber-500/20">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>Your plan is scheduled to change to <strong>{subscription.pendingPlan}</strong> on {subscription.pendingEffectiveAt ? format(new Date(subscription.pendingEffectiveAt), "MMM d, yyyy") : 'your next billing date'}.</p>
              </div>
            )}

            {subscription.cancelAtPeriodEnd && (
              <div className="flex items-start gap-2 p-3.5 bg-destructive/10 text-destructive rounded-md text-sm border border-destructive/20">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>Your subscription is set to cancel on {subscription.periodEnd ? format(new Date(subscription.periodEnd), "MMM d, yyyy") : 'the end of the billing period'}. Your workspace will revert to basic limits without deletion of your videos.</p>
              </div>
            )}
            
            {subscription.graceEndsAt && (
              <div className="flex items-start gap-2 p-3.5 bg-destructive/10 text-destructive rounded-md text-sm border border-destructive/20">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p className="font-medium">Payment past due. Grace period ends on {format(new Date(subscription.graceEndsAt), "MMM d, yyyy")}. Please update your payment method to avoid service interruption.</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t px-6 py-4 bg-muted/10 flex flex-wrap gap-3">
        {canManage ? (
          <>
            <Button 
              variant="outline" 
              onClick={handlePortal} 
              disabled={portal.isPending}
            >
              <ExternalLink className="h-4 w-4 mr-2" /> Open Customer Portal
            </Button>
            
            {subscription.status === 'active' && !subscription.cancelAtPeriodEnd && !subscription.pendingPlan && (
              <Button variant="ghost" className="text-muted-foreground ml-auto hover:text-destructive hover:bg-destructive/10 transition-colors" onClick={handleCancel} disabled={cancel.isPending}>
                Cancel Subscription
              </Button>
            )}
            
            {subscription.cancelAtPeriodEnd && (
              <Button variant="default" className="ml-auto" onClick={handleResume} disabled={resume.isPending}>
                <Play className="h-4 w-4 mr-2" /> Resume Subscription
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground w-full flex items-center justify-center py-1">
            You do not have permission to manage billing for this workspace. Contact an owner.
          </p>
        )}
      </CardFooter>
    </Card>
  )
}
