import { useState, useEffect } from "react"
import { useGetRuntimeConfig, useGetWorkspace, useUpdateWorkspace, getGetWorkspaceQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Server, Loader2, Receipt } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useBilling } from "@/hooks/use-billing"
import { CurrentPlan } from "@/components/billing/current-plan"
import { PlanComparison } from "@/components/billing/plan-comparison"
import { InvoiceList } from "@/components/billing/invoice-list"

export default function Settings() {
  const { data: workspace, isLoading: isWorkspaceLoading } = useGetWorkspace()
  const { data: runtimeConfig } = useGetRuntimeConfig()
  const updateWorkspace = useUpdateWorkspace()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [name, setName] = useState("")

  const { catalog, subscription, isCatalogLoading, isSubscriptionLoading, isReconciling } = useBilling()

  useEffect(() => {
    if (workspace) {
      setName(workspace.name)
    }
  }, [workspace])

  const handleSave = () => {
    updateWorkspace.mutate({ data: { name } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetWorkspaceQueryKey(), data)
        toast({ title: "Settings saved", description: "Workspace name updated successfully." })
      }
    })
  }

  const isLoading = isWorkspaceLoading || isCatalogLoading || isSubscriptionLoading;

  if (isLoading) {
    return <div className="p-8 space-y-8 max-w-5xl mx-auto"><Skeleton className="h-12 w-1/3" /><Skeleton className="h-[400px] w-full rounded-xl" /><Skeleton className="h-[300px] w-full rounded-xl" /></div>
  }

  if (!workspace || !catalog || !subscription) return null

  return (
    <div className="flex-1 p-6 md:p-10 overflow-y-auto bg-background/50">
      <div className="max-w-5xl mx-auto space-y-12 pb-16">

        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1 text-lg">Manage your workspace configuration and billing.</p>
        </div>

        {isReconciling && (
          <div className="bg-primary/5 border border-primary/20 text-primary p-4 rounded-lg flex items-center justify-center gap-3 shadow-sm animate-in fade-in slide-in-from-top-4">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="font-medium">Updating your subscription details...</span>
          </div>
        )}

        <div className="grid gap-12">

          <div className="grid gap-8">
            <h2 className="text-xl font-bold tracking-tight border-b pb-2">Workspace Setup</h2>
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle>Workspace Identity</CardTitle>
                <CardDescription>The display name and URL slug for your workspace.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="name">Workspace Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="max-w-md bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Workspace Slug</Label>
                  <div className="flex items-center max-w-md rounded-md overflow-hidden border border-input shadow-sm transition-colors focus-within:border-primary">
                    <div className="bg-muted px-4 py-2.5 text-sm border-r text-muted-foreground whitespace-nowrap">
                      {runtimeConfig?.appDomain}/
                    </div>
                    <Input
                      value={workspace.slug}
                      disabled
                      className="border-0 rounded-none bg-muted/20 focus-visible:ring-0 opacity-100 font-mono text-sm w-full"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">The slug cannot be changed after creation.</p>
                </div>
              </CardContent>
              <CardFooter className="border-t px-6 py-4 bg-muted/10">
                <Button onClick={handleSave} disabled={updateWorkspace.isPending || !name || name === workspace.name} className="font-semibold shadow-sm">
                  {updateWorkspace.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </CardFooter>
            </Card>

            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-primary" /> Resource Usage
                </CardTitle>
                <CardDescription>Current storage and limits for your workspace.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between bg-muted/20 p-5 rounded-xl border border-border/50 gap-4">
                  <div>
                    <div className="text-3xl font-extrabold tracking-tight">{workspace.storageUsedGb} <span className="text-xl text-muted-foreground font-semibold">GB</span></div>
                    <div className="text-sm text-muted-foreground mt-1">used of {workspace.storageLimitGb} GB limit</div>
                  </div>
                  <Badge variant={workspace.storageUsedGb / workspace.storageLimitGb > 0.8 ? "destructive" : "secondary"} className="text-sm px-3 py-1 font-semibold self-start sm:self-auto">
                    {Math.round((workspace.storageUsedGb / workspace.storageLimitGb) * 100)}% Used
                  </Badge>
                </div>

                <div className="h-3.5 w-full bg-secondary rounded-full overflow-hidden shadow-inner">
                  <div
                    className={`h-full transition-all duration-1000 ease-out ${workspace.storageUsedGb / workspace.storageLimitGb > 0.9 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, (workspace.storageUsedGb / workspace.storageLimitGb) * 100)}%` }}
                  />
                </div>
              </CardContent>
              <CardFooter className="border-t px-6 py-4 bg-muted/10">
                <Button variant="outline" className="w-full sm:w-auto font-medium shadow-sm" onClick={() => document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth' })}>
                  Upgrade to Increase Limits
                </Button>
              </CardFooter>
            </Card>
          </div>

          <div id="plans" className="pt-6 space-y-12">
            <div className="space-y-2 border-b pb-4">
              <h2 className="text-xl font-bold tracking-tight">Billing & Plans</h2>
              <p className="text-muted-foreground">Manage your subscription and view past payments.</p>
            </div>

            <div className="space-y-8">
              <CurrentPlan subscription={subscription} />
              <PlanComparison catalog={catalog} subscription={subscription} />
            </div>

            {subscription.capabilities.canManage && (
              <div className="space-y-6 pt-8 border-t">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                    <Receipt className="h-6 w-6 text-muted-foreground" />
                    Billing History
                  </h2>
                  <p className="text-muted-foreground mt-1">View and download your past invoices.</p>
                </div>
                <InvoiceList canManage={subscription.capabilities.canManage} />
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
