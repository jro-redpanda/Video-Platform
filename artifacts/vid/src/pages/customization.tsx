import { useEffect, useState } from "react"
import { useGetWorkspace, useUpdateWorkspace, getGetWorkspaceQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Player } from "@/components/player"

const SWATCHES = ["#4f46e5", "#0ea5e9", "#10b981", "#f97316", "#ef4444", "#a855f7"]

// Simple SVG gradient placeholder for preview poster
const cssPoster = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%231a1a2e" /><stop offset="100%" stop-color="%2316213e" /></linearGradient></defs><rect width="100%" height="100%" fill="url(%23g)"/></svg>`;

export default function Customization() {
  const { data: workspace, isLoading } = useGetWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const queryClient = useQueryClient()
  const [accent, setAccent] = useState("#4f46e5")
  const [foreground, setForeground] = useState("#FFFFFF")
  const [background, setBackground] = useState("#111827")
  const [initials, setInitials] = useState("VP")
  const [posterTreatment, setPosterTreatment] = useState<"default" | "darken" | "gradient">("default")
  const [customDomain, setCustomDomain] = useState("")

  useEffect(() => {
    if (!workspace) return
    setAccent(workspace.playerAccent)
    setForeground(workspace.playerControlForeground)
    setBackground(workspace.playerControlBackground)
    setInitials(workspace.logoInitials)
    setPosterTreatment(workspace.posterTreatment as any)
    setCustomDomain(workspace.customDomain ?? "")
  }, [workspace])

  if (isLoading) return <div className="p-8"><Skeleton className="h-[400px] w-full" /></div>
  if (!workspace) return null

  const entitled = (key: string) => workspace.entitlements[key] === true
  const playerColors = entitled("branding.player_colors")
  const logo = entitled("branding.logo")
  const watermark = entitled("branding.watermark")
  const domain = entitled("branding.custom_domain")
  const restriction = (enabled: boolean) => !enabled && <p className="text-xs text-muted-foreground">Available on a plan that includes this branding feature.</p>
  const handleSave = () => {
    updateWorkspace.mutate({
      data: {
        ...(playerColors ? { playerAccent: accent, playerControlForeground: foreground, playerControlBackground: background, posterTreatment } : {}),
        ...(logo ? { logoInitials: initials } : {}),
        ...(domain ? { customDomain: customDomain || null } : {}),
      },
    }, {
      onSuccess: (data) => queryClient.setQueryData(getGetWorkspaceQueryKey(), data),
    })
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-8">
        <div><h1 className="text-3xl font-bold tracking-tight">Customization</h1><p className="text-muted-foreground mt-1">Add workspace identity and limited player styling. Product layout, navigation, and brand remain unchanged.</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          <div className="space-y-6">
            <section className="space-y-4 border rounded-lg p-6 bg-card">
              <h2 className="text-lg font-semibold">Player colors</h2>
              <p className="text-sm text-muted-foreground">Accent and player controls only. Control colors must meet WCAG AA contrast.</p>
              {restriction(playerColors)}
              <div className="grid gap-3 sm:grid-cols-3">
                <ColorField label="Accent" value={accent} onChange={setAccent} disabled={!playerColors} />
                <ColorField label="Control foreground" value={foreground} onChange={setForeground} disabled={!playerColors} />
                <ColorField label="Control background" value={background} onChange={setBackground} disabled={!playerColors} />
              </div>
              <div className="flex flex-wrap gap-2">{SWATCHES.map((color) => <button type="button" key={color} disabled={!playerColors} onClick={() => setAccent(color)} className="w-7 h-7 rounded-full border disabled:opacity-40 cursor-pointer" style={{ backgroundColor: color }} aria-label={`Select ${color}`} />)}</div>
              <div className="space-y-2"><Label>Poster treatment</Label><select value={posterTreatment} disabled={!playerColors} onChange={(event) => setPosterTreatment(event.target.value as any)} className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50"><option value="default">Default</option><option value="darken">Darken</option><option value="gradient">Gradient</option></select></div>
            </section>
            <section className="space-y-3 border rounded-lg p-6 bg-card">
              <h2 className="text-lg font-semibold">Workspace logo</h2>{restriction(logo)}
              <p className="text-sm text-muted-foreground">Logo assets are connected through the media asset flow; uploads are not available here.</p>
              <p className="text-xs text-muted-foreground">Current reference: {workspace.logoObjectKey ?? "No logo asset connected"}</p>
              <Label htmlFor="initials">Fallback initials</Label><Input id="initials" disabled={!logo} value={initials} onChange={(event) => setInitials(event.target.value.substring(0, 3).toUpperCase())} maxLength={3} className="w-24 uppercase font-bold" />
            </section>
            <section className="space-y-3 border rounded-lg p-6 bg-card">
              <h2 className="text-lg font-semibold">Player watermark</h2>{restriction(watermark)}
              <p className="text-sm text-muted-foreground">Watermark assets are connected through the media asset flow; uploads are not available here.</p>
              <p className="text-xs text-muted-foreground">Current reference: {workspace.watermarkObjectKey ?? "No watermark asset connected"}</p>
            </section>
            <section className="space-y-3 border rounded-lg p-6 bg-card">
              <h2 className="text-lg font-semibold">Custom domain</h2>{restriction(domain)}
              <Label htmlFor="domain">Domain</Label><Input id="domain" disabled={!domain} placeholder="video.example.com" value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} />
              {workspace.customDomain && <p className="text-xs text-muted-foreground">{workspace.customDomainVerified ? "Verified" : "Awaiting verification"}</p>}
            </section>
            <Button size="lg" onClick={handleSave} disabled={updateWorkspace.isPending}>{updateWorkspace.isPending ? "Saving..." : "Save Customization"}</Button>
          </div>
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-muted-foreground">Live Player Preview</h2>
            <div className="rounded-xl shadow-2xl ring-1 ring-border bg-black overflow-hidden relative">
              <Player
                title="Preview Visuals"
                src={null}
                poster={cssPoster}
                accentColor={accent}
                controlForegroundColor={foreground}
                controlBackgroundColor={background}
                posterTreatment={posterTreatment}
                logoInitials={initials}
                className="rounded-xl"
              />
            </div>
            <p className="text-sm text-muted-foreground text-center mt-2">
              Preview represents visual styling only; interactivity requires an active video source.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  return <div className="space-y-2"><Label>{label}</Label><Input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} maxLength={7} className="font-mono uppercase" /></div>
}