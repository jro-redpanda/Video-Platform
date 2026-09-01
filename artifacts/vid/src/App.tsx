import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import Settings from "@/pages/settings";
import EmbedPlayer from "@/pages/embed-player";
import Login from "@/pages/login";
import { authClient } from "@/lib/auth-client";

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
  if (session.isPending) {
    return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading workspace…</div>;
  }
  if (!session.data) {
    return <Login />;
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
          <Route path="/settings" component={Settings} />
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
