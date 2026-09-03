import { useEffect, useState } from "react"
import { 
  useGetCustomDomain,
  useCreateCustomDomain,
  useVerifyCustomDomain,
  useDeleteCustomDomain,
  getGetCustomDomainQueryKey,
} from "@workspace/api-client-react"
import type { 
  CustomDomainStatus, 
  CustomDomainStatusLifecycleState 
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { 
  Copy, Check, RefreshCw, AlertCircle, Trash2, 
  Globe, Info
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export function CustomDomainManager({ entitled }: { entitled: boolean }) {
  const [verificationRequestedTime, setVerificationRequestedTime] = useState<number | null>(null);

  const { data: domainStatus, isLoading, error } = useGetCustomDomain({
    query: {
      queryKey: getGetCustomDomainQueryKey(),
      retry: (failureCount, error) => {
        const err = error as { status?: number };
        if (err?.status === 404) return false;
        return failureCount < 3;
      },
      refetchInterval: (query) => {
        const state = query.state.data?.lifecycleState;
        if (state === 'verifying' || (verificationRequestedTime && state === 'pending_verification')) {
          return 3000;
        }
        return false;
      }
    }
  })

  // Terminal states reset the polling flag
  useEffect(() => {
    if (domainStatus) {
      const state = domainStatus.lifecycleState;
      if (state === 'verified' || state === 'failed' || state === 'suspended' || state === 'reconciliation_required' || state === 'removed') {
        setVerificationRequestedTime(null);
      }
    } else {
      setVerificationRequestedTime(null);
    }
  }, [domainStatus?.lifecycleState, domainStatus]);

  // Timeout after 2 minutes
  useEffect(() => {
    if (verificationRequestedTime) {
      const timeout = setTimeout(() => {
        setVerificationRequestedTime(null);
      }, 2 * 60 * 1000);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [verificationRequestedTime]);

  const hasDomain = Boolean(domainStatus?.hostname)
  
  if (isLoading) {
    return <Skeleton className="h-48 w-full rounded-xl" />
  }

  // Render query errors explicitly except 404 (handled as no domain)
  const err = error as { status?: number; message?: string } | null;
  const isNotFoundError = err?.status === 404;
  if (err && !isNotFoundError) {
    return (
      <div className="bg-destructive/10 text-destructive p-4 rounded-xl border border-destructive/20 flex items-start gap-3">
         <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
         <div>
           <p className="font-medium text-sm">Failed to load domain status</p>
           <p className="text-sm opacity-90 mt-1">{err.message || "An unexpected error occurred. Please try again later."}</p>
         </div>
      </div>
    )
  }

  if (hasDomain && domainStatus) {
    return (
      <DomainStatusCard 
        status={domainStatus} 
        entitled={entitled} 
        onVerificationRequested={() => setVerificationRequestedTime(Date.now())} 
      />
    )
  }

  if (!entitled) {
    return (
      <div className="bg-card rounded-xl shadow-sm border p-6 flex flex-col items-center justify-center text-center space-y-4 py-12">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-2">
          <Globe className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="font-medium">Custom Domain Delivery</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Serve your videos from a custom domain for a complete white-label experience.
        </p>
        <Button variant="outline" disabled className="mt-2">Upgrade Required</Button>
      </div>
    )
  }

  return <CreateDomainCard />
}

function CreateDomainCard() {
  const [hostname, setHostname] = useState("")
  const createDomain = useCreateCustomDomain()
  const queryClient = useQueryClient()
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!hostname) return
    createDomain.mutate({ data: { hostname } }, {
      onSuccess: () => {
        setHostname("")
        queryClient.invalidateQueries({ queryKey: getGetCustomDomainQueryKey() })
      }
    })
  }

  return (
    <div className="bg-card rounded-xl shadow-sm border p-6 space-y-4">
      <div>
        <h3 className="font-medium">Configure Custom Domain</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Set up a dedicated subdomain for your player embeds and delivery network.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-3 mt-4 items-start">
        <div className="flex-1 max-w-md space-y-2">
          <Input 
            placeholder="e.g. video.yourbrand.com" 
            value={hostname}
            onChange={(e) => setHostname(e.target.value.toLowerCase().trim())}
            disabled={createDomain.isPending}
          />
          {createDomain.isError && (
            <p className="text-sm text-destructive font-medium">
              {(createDomain.error as { message?: string })?.message || "Failed to add domain. It may be invalid or already in use."}
            </p>
          )}
        </div>
        <Button type="submit" disabled={createDomain.isPending || !hostname.includes(".")}>
          {createDomain.isPending ? "Adding..." : "Add Domain"}
        </Button>
      </form>
    </div>
  )
}

function DomainStatusCard({ 
  status, 
  entitled,
  onVerificationRequested,
}: { 
  status: CustomDomainStatus; 
  entitled: boolean;
  onVerificationRequested: () => void;
}) {
  const deleteDomain = useDeleteCustomDomain()
  const verifyDomain = useVerifyCustomDomain()
  const queryClient = useQueryClient()
  
  const handleVerify = () => {
    verifyDomain.mutate(undefined, {
      onSuccess: (data) => {
         queryClient.setQueryData(getGetCustomDomainQueryKey(), data)
         onVerificationRequested();
      }
    })
  }

  const handleDelete = () => {
    deleteDomain.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCustomDomainQueryKey() })
      },
    })
  }

  const state = status.lifecycleState;
  const isPending = state === "pending_verification"
  const isVerifying = state === "verifying"
  const isVerified = state === "verified"
  const isFailed = state === "failed"
  const isSuspended = state === "suspended"

  return (
    <div className="bg-card rounded-xl shadow-sm border overflow-hidden">
      <div className="p-6 border-b border-border flex justify-between items-start bg-muted/10">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-medium">{status.hostname}</h3>
            {state && <StateBadge state={state} />}
          </div>
          {status.verifiedAt && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Check className="w-3 h-3" /> Verified {new Date(status.verifiedAt).toLocaleDateString()}
            </p>
          )}
        </div>
        
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              disabled={deleteDomain.isPending} 
              className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/20"
            >
              {deleteDomain.isPending ? (
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              {deleteDomain.isPending ? "Removing..." : "Remove"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove custom domain?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to remove <strong>{status.hostname}</strong>? Any existing embeds using this domain will break immediately and cannot be recovered without full reconfiguration.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Yes, Remove Domain
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {deleteDomain.isError && (
        <div className="px-6 pt-4 pb-0">
          <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Failed to remove domain. {(deleteDomain.error as { message?: string })?.message}</p>
          </div>
        </div>
      )}

      <div className="p-6 space-y-6">
        {/* Verification Instructions */}
        {(isPending || isVerifying || isFailed) && status.txtRecordName && status.txtRecordValue && (
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium">DNS Verification Required</h4>
              <p className="text-sm text-muted-foreground mt-1">
                To prove ownership of this domain, add the following TXT record to your DNS provider. 
                Changes may take a few minutes to propagate.
              </p>
            </div>
            
            <div className="bg-muted/30 border rounded-lg p-4 font-mono text-sm space-y-3 shadow-inner">
              <div className="grid grid-cols-[80px_1fr] items-center gap-4">
                <span className="text-muted-foreground">Type</span>
                <span className="font-semibold">TXT</span>
              </div>
              <div className="grid grid-cols-[80px_1fr] items-center gap-4">
                <span className="text-muted-foreground">Name</span>
                <div className="flex items-center justify-between bg-background border px-3 py-1.5 rounded shadow-sm gap-2">
                  <span className="truncate">{status.txtRecordName}</span>
                  <CopyButton text={status.txtRecordName} />
                </div>
              </div>
              <div className="grid grid-cols-[80px_1fr] items-center gap-4">
                <span className="text-muted-foreground">Value</span>
                <div className="flex items-center justify-between bg-background border px-3 py-1.5 rounded shadow-sm gap-2">
                  <span className="truncate">{status.txtRecordValue}</span>
                  <CopyButton text={status.txtRecordValue} />
                </div>
              </div>
            </div>

            {!entitled && (
              <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md border">
                Verification is currently disabled because your workspace plan no longer includes custom domain delivery.
              </div>
            )}

            {entitled && (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Button onClick={handleVerify} disabled={isVerifying || verifyDomain.isPending} className="min-w-32">
                    {isVerifying || verifyDomain.isPending ? (
                      <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Verifying...</>
                    ) : "Verify Record"}
                  </Button>
                  {status.lastCheckedAt && !isVerifying && (
                    <span className="text-xs text-muted-foreground">
                      Last checked: {new Date(status.lastCheckedAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>
                {verifyDomain.isError && (
                  <p className="text-sm text-destructive font-medium">
                    Failed to trigger verification. {(verifyDomain.error as { message?: string })?.message}
                  </p>
                )}
              </div>
            )}
            
            {status.message && isFailed && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <p>{status.message}</p>
              </div>
            )}
          </div>
        )}

        {/* Verified but needs edge activation */}
        {isVerified && status.activationState === "external_setup_required" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 bg-amber-500/10 p-4 rounded-lg border border-amber-500/20 text-amber-600 dark:text-amber-400">
              <Info className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <h4 className="text-sm font-medium">Activation Required</h4>
                <p className="text-sm opacity-80 mt-1">
                  DNS ownership verified, TLS/edge activation not configured, domain not serving traffic.
                </p>
                {status.message && <p className="text-sm mt-2 font-mono opacity-90">{status.message}</p>}
              </div>
            </div>
          </div>
        )}

        {/* Suspended or Reconciliation */}
        {(isSuspended || state === "reconciliation_required") && (
          <div className="flex items-start gap-3 bg-destructive/10 p-4 rounded-lg border border-destructive/20 text-destructive">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div>
              <h4 className="text-sm font-medium">
                {isSuspended ? "Domain Suspended" : "Configuration Issue"}
              </h4>
              <p className="text-sm opacity-80 mt-1">
                {status.message || "There is an issue with your domain configuration that requires attention."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: NonNullable<CustomDomainStatusLifecycleState> }) {
  const map: Record<NonNullable<CustomDomainStatusLifecycleState>, { label: string, classes: string }> = {
    pending_verification: { label: "Pending", classes: "bg-muted text-muted-foreground border-border" },
    verifying: { label: "Verifying", classes: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" },
    verified: { label: "Verified", classes: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
    failed: { label: "Failed", classes: "bg-destructive/10 text-destructive border-destructive/20" },
    suspended: { label: "Suspended", classes: "bg-destructive/10 text-destructive border-destructive/20" },
    removed: { label: "Removed", classes: "bg-muted text-muted-foreground border-border" },
    reconciliation_required: { label: "Error", classes: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" }
  }
  
  const config = map[state];
  
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.classes}`}>
      {config.label}
    </span>
  )
}

function CopyButton({ text }: { text: string | null | undefined }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle")
  
  const handleCopy = () => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopyStatus("copied")
      setTimeout(() => setCopyStatus("idle"), 2000)
    }).catch(() => {
      setCopyStatus("error")
      setTimeout(() => setCopyStatus("idle"), 2000)
    })
  }
  
  return (
    <button 
      onClick={handleCopy} 
      className={`p-1.5 shrink-0 transition-colors ${copyStatus === "error" ? "text-destructive hover:text-destructive/80" : "text-muted-foreground hover:text-foreground"}`} 
      type="button" 
      title={copyStatus === "error" ? "Failed to copy" : "Copy to clipboard"}
    >
      {copyStatus === "copied" ? <Check className="w-4 h-4 text-emerald-500" /> : copyStatus === "error" ? <AlertCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
    </button>
  )
}
