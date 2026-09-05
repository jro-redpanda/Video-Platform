import { useState } from "react"
import { Film, LoaderCircle } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useGetRuntimeConfig } from "@workspace/api-client-react"

export default function Login({ isInvitation }: { isInvitation?: boolean }) {
  const { data: runtimeConfig } = useGetRuntimeConfig()
  const invitationToken = isInvitation
    ? new URLSearchParams(window.location.search).get("token")
    : null
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError("")
    try {
      const result = mode === "signup" && invitationToken
        ? await authClient.signUp.email({
            name,
            email,
            password,
            invitationToken,
          } as Parameters<typeof authClient.signUp.email>[0] & { invitationToken: string })
        : await authClient.signIn.email({ email, password })
      if (result.error) setError(result.error.message ?? "Authentication failed")
    } catch {
      setError("Authentication could not be completed. Please try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-2 bg-background">
      <section className="hidden lg:flex relative overflow-hidden bg-[#171326] text-white p-12 flex-col justify-between">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(108,92,231,.45),transparent_48%)]" />
        <div className="relative flex items-center gap-3 font-semibold text-xl">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/10"><Film className="h-5 w-5" /></span>
          {runtimeConfig?.productName}
        </div>
        <div className="relative max-w-lg">
          {isInvitation ? (
            <>
              <p className="text-4xl font-semibold tracking-tight leading-tight">You've been invited.</p>
              <p className="mt-5 text-white/60">Join your team's workspace to collaborate on videos, view analytics, and manage settings.</p>
            </>
          ) : (
            <>
              <p className="text-4xl font-semibold tracking-tight leading-tight">Your video platform.<br />Your player. Your audience.</p>
              <p className="mt-5 text-white/60">Private workspaces, owned embed URLs, and provider-independent analytics.</p>
            </>
          )}
        </div>
        <p className="relative text-sm text-white/40">Provider-neutral by design.</p>
      </section>
      <section className="grid place-items-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {isInvitation
                ? mode === "signup" ? "Create your invited account" : "Sign in to accept"
                : "Welcome back"}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {isInvitation
                ? mode === "signup"
                  ? "Use the email address that received this invitation."
                  : "Sign in with the email address that received this invitation."
                : "Sign in to your workspace."}
            </p>
          </div>
          <div className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" data-testid="input-name" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" data-testid="input-email" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete={mode === "signup" ? "new-password" : "current-password"} data-testid="input-password" />
              {mode === "signup" && <p className="text-xs text-muted-foreground">Use at least 10 characters.</p>}
            </div>
          </div>
          {error && <p className="text-sm text-destructive font-medium" role="alert">{error}</p>}
          <Button className="w-full" type="submit" disabled={pending} data-testid="button-submit">
            {pending && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "signup" ? "Create account" : "Sign in"}
          </Button>
          {isInvitation && invitationToken && (
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin")
                setError("")
              }}
              className="w-full text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="button-toggle-invitation-auth-mode"
            >
              {mode === "signin" ? "Need an account? Create your invited account" : "Already have an account? Sign in"}
            </button>
          )}
        </form>
      </section>
    </main>
  )
}