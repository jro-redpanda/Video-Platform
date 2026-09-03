import { useState } from "react"
import { Film, LoaderCircle } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useGetRuntimeConfig } from "@workspace/api-client-react"

export default function Login() {
  const { data: runtimeConfig } = useGetRuntimeConfig()
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
    const result = mode === "signin"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ name, email, password })
    setPending(false)
    if (result.error) setError(result.error.message ?? "Authentication failed")
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
          <p className="text-4xl font-semibold tracking-tight leading-tight">Your video platform.<br />Your player. Your audience.</p>
          <p className="mt-5 text-white/60">Private workspaces, owned embed URLs, and provider-independent analytics.</p>
        </div>
        <p className="relative text-sm text-white/40">Provider-neutral by design.</p>
      </section>
      <section className="grid place-items-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
            <p className="mt-2 text-muted-foreground">{mode === "signin" ? "Sign in to your workspace." : "Sign up to create your workspace."}</p>
          </div>
          <div className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete={mode === "signin" ? "current-password" : "new-password"} />
              <p className="text-xs text-muted-foreground">At least 10 characters.</p>
            </div>
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button className="w-full" type="submit" disabled={pending}>
            {pending && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
          <button type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError("") }} className="w-full text-sm text-primary hover:underline">
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </form>
      </section>
    </main>
  )
}