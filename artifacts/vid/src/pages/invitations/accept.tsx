import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAcceptInvitation } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, CheckCircle2, AlertCircle } from "lucide-react";

export default function AcceptInvitation() {
  const [location, setLocation] = useLocation();
  const search = new URLSearchParams(window.location.search);
  const token = search.get("token");
  const queryClient = useQueryClient();
  
  const acceptMutation = useAcceptInvitation({
    mutation: {
      onSuccess: async () => {
        await queryClient.cancelQueries();
        queryClient.clear();
        setLocation("/", { replace: true });
        window.location.reload();
      }
    }
  });

  const didRun = useRef(false);

  useEffect(() => {
    if (!token) return;
    if (didRun.current) return;
    didRun.current = true;
    
    acceptMutation.mutate({ data: { token } });
  }, [token, acceptMutation]);

  if (!token) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center max-w-md p-6">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold tracking-tight">Invalid Invitation</h1>
          <p className="text-muted-foreground">This invitation link is missing a token. Please check the link and try again.</p>
        </div>
      </div>
    );
  }

  if (acceptMutation.isError) {
    let message = "Failed to accept the invitation. It may have expired or been revoked.";

    return (
      <div className="min-h-screen grid place-items-center bg-background" data-testid="invitation-acceptance-error">
        <div className="flex flex-col items-center gap-4 text-center max-w-md p-6">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold tracking-tight">Cannot Accept Invitation</h1>
          <p className="text-muted-foreground" role="alert">{message}</p>
          <button onClick={() => setLocation("/")} className="mt-4 text-sm font-medium text-primary hover:underline">
            Go to your workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background" data-testid="invitation-acceptance-pending">
      <div className="flex flex-col items-center gap-6 text-center max-w-md p-6">
        <LoaderCircle className="h-10 w-10 text-primary animate-spin" />
        <div role="status" aria-live="polite">
          <h1 className="text-2xl font-bold tracking-tight">Accepting Invitation...</h1>
          <p className="text-muted-foreground mt-2">Joining the workspace, please wait.</p>
        </div>
      </div>
    </div>
  );
}
