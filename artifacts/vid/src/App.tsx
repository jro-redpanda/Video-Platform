import { type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { Shell } from "@/components/layout/shell";
import Dashboard from "@/pages/dashboard";
import Videos from "@/pages/videos";
import VideoDetail from "@/pages/video-detail";
import Analytics from "@/pages/analytics";
import Members from "@/pages/members";
import Customization from "@/pages/customization";
import Audit from "@/pages/audit";
import Settings from "@/pages/settings";
import EmbedPlayer from "@/pages/embed-player";
import Login from "@/pages/login";
import OnboardingFlow from "@/pages/onboarding";
import AcceptInvitation from "@/pages/invitations/accept";
import { authClient } from "@/lib/auth-client";
import {
  useGetOnboarding,
  getGetOnboardingQueryKey,
  useGetRuntimeConfig,
} from "@workspace/api-client-react";
import { shouldRetryQuery } from "@/lib/frontend-safety";
import {
  TenantTransitionProvider,
  useTenantTransition,
} from "@/lib/tenant-transition";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: shouldRetryQuery,
      staleTime: 30 * 1000,
    },
  },
});

function ProductMetadata() {
  const { data: runtimeConfig } = useGetRuntimeConfig();

  useEffect(() => {
    if (!runtimeConfig?.productName) return;
    const title = runtimeConfig.productName;
    const description = `${title} is a secure workspace for managing and sharing video.`;
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
    document.querySelector('meta[property="og:title"]')?.setAttribute("content", title);
    document.querySelector('meta[property="og:description"]')?.setAttribute("content", description);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute("content", title);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute("content", description);
  }, [runtimeConfig?.productName]);

  return null;
}

function Router() {
  const [location] = useLocation();
  const { isTransitioning } = useTenantTransition();

  if (isTransitioning) {
    return (
      <div
        className="min-h-screen grid place-items-center text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        Switching workspace…
      </div>
    );
  }

  if (location.startsWith("/v/")) {
    return (
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/v/:id" component={EmbedPlayer} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    );
  }

  return <AuthenticatedRouter />;
}

function AuthenticatedRouter() {
  const session = authClient.useSession();
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const userId = session.data?.user.id ?? null;
  const [cacheIdentity, setCacheIdentity] = useState<string | null | undefined>();

  useEffect(() => {
    if (session.isPending || session.error || cacheIdentity === userId) return;
    let active = true;

    void queryClient.cancelQueries()
      .catch(() => undefined)
      .then(() => {
        queryClient.clear();
        if (active) setCacheIdentity(userId);
      });

    return () => {
      active = false;
    };
  }, [cacheIdentity, queryClient, session.error, session.isPending, userId]);

  if (session.isPending) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground" role="status">Loading workspace…</div>;
  }

  if (session.error) {
    return (
      <FullScreenError
        message="We could not verify your session."
        onRetry={() => void session.refetch()}
      />
    );
  }

  if (cacheIdentity !== userId) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground" role="status">Securing workspace data…</div>;
  }

  const isInvitationRoute = location === '/invitations/accept';

  if (!session.data) {
    return <Login isInvitation={isInvitationRoute} />;
  }

  if (isInvitationRoute) {
    return <AcceptInvitation />;
  }

  return <OnboardingGate key={userId} />;
}

function OnboardingGate() {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: onboarding, isLoading, isError } = useGetOnboarding({
    query: {
      queryKey: getGetOnboardingQueryKey(),
      refetchInterval: (query) => {
        return query.state.data?.state === 'provisioning' ? 2000 : false;
      }
    }
  });

  const prevState = useRef(onboarding?.state);

  useEffect(() => {
    if (prevState.current === 'provisioning' && onboarding?.state === 'active') {
      queryClient.invalidateQueries();
    }
    prevState.current = onboarding?.state;
  }, [onboarding?.state, queryClient]);

  useEffect(() => {
    if (isLoading || isError || !onboarding) return;

    if (onboarding.state === 'active' && location === '/onboarding') {
      setLocation('/', { replace: true });
    } else if (onboarding.state !== 'active' && location !== '/onboarding') {
      setLocation('/onboarding', { replace: true });
    }
  }, [onboarding?.state, location, isLoading, isError, setLocation]);

  if (isLoading) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground" role="status">Loading workspace state…</div>;
  }

  if (isError) {
    return <FullScreenError message="Failed to load workspace state." onRetry={() => void queryClient.refetchQueries({ queryKey: getGetOnboardingQueryKey() })} />;
  }

  if (!onboarding) return null;

  if (onboarding.state !== 'active') {
    return <OnboardingFlow onboarding={onboarding} />;
  }

  return (
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/videos" component={Videos} />
          <Route path="/videos/:id" component={VideoDetail} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/members" component={Members} />
          <Route path="/customization" component={Customization} />
          <Route path="/audit" component={Audit} />
          <Route path="/settings" component={Settings} />
          <Route path="/onboarding" component={() => null} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function FullScreenError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center" role="alert">
      <p className="text-destructive font-medium">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border px-4 py-2 text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="button-retry-shell"
      >
        Try again
      </button>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TenantTransitionProvider>
          <ProductMetadata />
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </TenantTransitionProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
