import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useCreateOnboardingWorkspace,
  useRetryOnboarding,
  getGetOnboardingQueryKey,
  type WorkspaceOnboarding
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { LoaderCircle, LogOut, AlertTriangle, ShieldAlert, Film } from "lucide-react";
import { useGetRuntimeConfig } from "@workspace/api-client-react";

const formSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  slug: z.string().max(63).optional().refine(val => !val || val.length >= 2, {
    message: "Slug must be at least 2 characters if provided"
  }),
});

export default function OnboardingFlow({ onboarding }: { onboarding: WorkspaceOnboarding }) {
  const { data: runtimeConfig } = useGetRuntimeConfig();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const createWorkspace = useCreateOnboardingWorkspace();
  const retryOnboarding = useRetryOnboarding();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema as any),
    defaultValues: { name: "", slug: "" },
  });

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      await queryClient.cancelQueries();
      queryClient.clear();
      setLocation("/", { replace: true });
      window.location.reload();
    }
  };

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    createWorkspace.mutate({ data: { name: values.name, slug: values.slug || undefined } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetOnboardingQueryKey(), data);
      },
      onError: (error: unknown) => {
        const data = error && typeof error === "object" && "data" in error
          ? (error as { data?: { error?: unknown } }).data
          : undefined;
        const safeServerMessage = typeof data?.error === "string" ? data.error : undefined;
        const msg = safeServerMessage
          ?? (error instanceof Error ? error.message : "An error occurred creating your workspace.");
        if (msg.toLowerCase().includes("slug") || msg.toLowerCase().includes("name")) {
          if (msg.toLowerCase().includes("slug")) form.setError("slug", { message: msg });
          else form.setError("name", { message: msg });
        } else {
          form.setError("root", { message: msg });
        }
      }
    });
  };

  const onRetry = () => {
    retryOnboarding.mutate({ data: {} }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetOnboardingQueryKey(), data);
      }
    });
  };

  const { state, provisioning } = onboarding;

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col font-sans">
      <header className="flex items-center justify-between p-6 w-full max-w-7xl mx-auto">
        <div className="font-semibold text-lg flex items-center gap-3 text-foreground">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <Film className="h-4 w-4" />
          </span>
          {runtimeConfig?.productName}
        </div>
        <Button variant="ghost" size="sm" onClick={handleSignOut} data-testid="button-signout" className="text-muted-foreground hover:text-foreground">
          <LogOut className="w-4 h-4 mr-2" /> Sign out
        </Button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md bg-card border border-border shadow-sm rounded-xl p-8">
          {state === 'needs_workspace' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="space-y-2">
                <h1 className="text-2xl font-bold tracking-tight text-card-foreground">Create your workspace</h1>
                <p className="text-sm text-muted-foreground">This is your dedicated environment for managing video operations.</p>
              </div>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-foreground">Workspace Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Acme Corp" {...field} data-testid="input-workspace-name" className="bg-background" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="slug"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-foreground flex items-baseline justify-between">
                          URL Slug <span className="text-xs text-muted-foreground font-normal">Optional</span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="acme-corp" {...field} data-testid="input-workspace-slug" className="bg-background" />
                        </FormControl>
                        <FormDescription>Leave blank to auto-generate from your workspace name.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {form.formState.errors.root && (
                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                      <p className="text-sm text-destructive" data-testid="text-error-message">
                        {form.formState.errors.root.message}
                      </p>
                    </div>
                  )}
                  <Button type="submit" className="w-full" disabled={createWorkspace.isPending} data-testid="button-submit-workspace">
                    {createWorkspace.isPending && <LoaderCircle className="w-4 h-4 mr-2 animate-spin" />}
                    Create Workspace
                  </Button>
                </form>
              </Form>
            </div>
          )}

          {state === 'provisioning' && (
            <div className="space-y-6 text-center animate-in fade-in zoom-in-95 duration-500 py-6" data-testid="status-workspace-provisioning">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                {provisioning.state === 'reconciliation_required' ? (
                  <ShieldAlert className="w-8 h-8 text-primary" />
                ) : (
                  <LoaderCircle className="w-8 h-8 text-primary animate-spin" />
                )}
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold tracking-tight text-card-foreground">
                  {provisioning.state === 'reconciliation_required' ? 'Review Required' : 'Setting up your workspace'}
                </h2>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  {provisioning.state === 'reconciliation_required' 
                    ? 'Your workspace requires operator review. Please contact support to continue.'
                    : provisioning.message || 'Provisioning resources. This usually takes a few seconds.'}
                </p>
              </div>
            </div>
          )}

          {state === 'failed' && (
            <div className="space-y-6 text-center animate-in fade-in zoom-in-95 duration-500 py-6" data-testid="status-workspace-failed">
              <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-destructive" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold tracking-tight text-card-foreground">Provisioning Failed</h2>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  {provisioning.message || 'We encountered an error while setting up your workspace.'}
                </p>
              </div>
              {provisioning.retryable && (
                <Button onClick={onRetry} disabled={retryOnboarding.isPending} className="w-full" data-testid="button-retry-provisioning">
                  {retryOnboarding.isPending && <LoaderCircle className="w-4 h-4 mr-2 animate-spin" />}
                  Retry Setup
                </Button>
              )}
              {retryOnboarding.error && (
                <p className="text-sm text-destructive" role="alert" data-testid="text-retry-error">
                  {retryOnboarding.error.message}
                </p>
              )}
            </div>
          )}

          {state === 'suspended' && (
            <div className="space-y-6 text-center animate-in fade-in zoom-in-95 duration-500 py-6" data-testid="status-workspace-suspended">
              <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                <ShieldAlert className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold tracking-tight text-card-foreground">Workspace Suspended</h2>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Your workspace has been suspended. Please contact support for more information.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
