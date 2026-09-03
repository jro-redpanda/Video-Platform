import { type ReactNode, useEffect, useRef } from 'react';
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
import { useGetOnboarding, getGetOnboardingQueryKey } from "@workspace/api-client-react";

const queryClient = new QueryClient();

function Router() {
  const [location] = useLocation();
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

  if (session.isPending) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading workspace…</div>;
  }

  const isInvitationRoute = location === '/invitations/accept';

  if (!session.data) {
    return <Login isInvitation={isInvitationRoute} />;
  }

  if (isInvitationRoute) {
    return <AcceptInvitation />;
  }

  return <OnboardingGate />;
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
    return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading workspace state…</div>;
  }

  if (isError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center space-y-4">
        <p className="text-destructive font-medium">Failed to load workspace state.</p>
        <button onClick={() => window.location.reload()} className="text-sm underline hover:text-foreground text-muted-foreground transition-colors">Retry</button>
      </div>
    );
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
