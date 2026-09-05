import { useEffect, useState } from "react"
import {
  useGetWorkspace,
  useUpdateWorkspace,
  getGetWorkspaceQueryKey,
} from "@workspace/api-client-react"
import type { WorkspaceUpdatePosterTreatment } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Player } from "@/components/player"
import { ShieldCheck, AlertCircle } from "lucide-react"
import { CustomDomainManager } from "@/components/custom-domain-manager"
import { useToast } from "@/hooks/use-toast"

const SWATCHES = ["#4f46e5", "#0ea5e9", "#10b981", "#f97316", "#ef4444", "#a855f7"]
const cssPoster = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%231a1a2e" /><stop offset="100%" stop-color="%2316213e" /></linearGradient></defs><rect width="100%" height="100%" fill="url(%23g)"/></svg>`;

const isValidHex = (hex: string) => /^#[0-9A-Fa-f]{6}$/i.test(hex)

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function getLuminance(r: number, g: number, b: number) {
  const a = [r, g, b].map(function (v) {
    v /= 255;
    return v <= 0.03928
      ? v / 12.92
      : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function getContrastRatio(hex1: string, hex2: string) {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return 0;
  const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
  const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

export default function Customization() {
  const { data: workspace, isLoading } = useGetWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [accent, setAccent] = useState("#4f46e5")
  const [foreground, setForeground] = useState("#FFFFFF")
  const [background, setBackground] = useState("#111827")
  const [initials, setInitials] = useState("WS")
  const [posterTreatment, setPosterTreatment] = useState<WorkspaceUpdatePosterTreatment>("default")
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!workspace || dirty) return
    setAccent(workspace.playerAccent)
    setForeground(workspace.playerControlForeground)
    setBackground(workspace.playerControlBackground)
    setInitials(workspace.logoInitials)
    setPosterTreatment(workspace.posterTreatment as WorkspaceUpdatePosterTreatment)
  }, [
    dirty,
    workspace?.id,
    workspace?.playerAccent,
    workspace?.playerControlForeground,
    workspace?.playerControlBackground,
    workspace?.logoInitials,
    workspace?.posterTreatment,
  ])

  if (isLoading) return <div className="p-8"><Skeleton className="h-[400px] w-full" /></div>
  if (!workspace) return null

  const entitled = (key: string) => workspace.entitlements[key] === true
  const playerColors = entitled("branding.player_colors")
  const logo = entitled("branding.logo")
  const watermark = entitled("branding.watermark")
  const domain = entitled("branding.custom_domain")
  const colorsValid = isValidHex(accent) && isValidHex(foreground) && isValidHex(background)
  const contrastValid = colorsValid && getContrastRatio(foreground, background) >= 4.5
  const initialsValid = /^[A-Z0-9]{1,3}$/.test(initials)

  const handleSaveVisuals = () => {
    let hasError = false;
    if (playerColors) {
      if (!colorsValid) {
        toast({ title: "Invalid colors", description: "Please use valid 6-character hex codes (e.g., #FFFFFF).", variant: "destructive" })
        hasError = true;
      } else if (!contrastValid) {
        toast({ title: "Insufficient contrast", description: "Player controls must meet WCAG AA contrast of at least 4.5:1.", variant: "destructive" })
        hasError = true;
      }
    }
    if (logo && !initialsValid) {
      toast({ title: "Invalid initials", description: "Initials must be 1 to 3 letters or numbers.", variant: "destructive" })
      hasError = true;
    }
    if (hasError) return;

    updateWorkspace.mutate({
      data: {
        ...(playerColors ? { playerAccent: accent, playerControlForeground: foreground, playerControlBackground: background, posterTreatment } : {}),
        ...(logo ? { logoInitials: initials.toUpperCase() } : {}),
      },
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetWorkspaceQueryKey(), data)
        setAccent(data.playerAccent)
        setForeground(data.playerControlForeground)
        setBackground(data.playerControlBackground)
        setInitials(data.logoInitials)
        setPosterTreatment(data.posterTreatment as WorkspaceUpdatePosterTreatment)
        setDirty(false)
        toast({ title: "Visuals saved", description: "Your branding changes have been applied successfully." })
      },
      onError: () => {
        toast({ title: "Failed to save", description: "Your branding changes were not saved. Please try again.", variant: "destructive" })
      }
    })
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Customization</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-lg">
            Player styling changes apply immediately. Custom domain changes require verification and external setup.
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
          <div className="xl:col-span-7 space-y-10">
            {/* Visual Customization */}
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-medium">Visual Identity</h2>
              </div>

              <div className="bg-card rounded-xl shadow-sm border overflow-hidden divide-y divide-border">
                <section className="p-6 space-y-6">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <h3 className="font-medium">Player colors</h3>
                      <p className="text-sm text-muted-foreground mt-1">Accent and control UI colors. Must meet WCAG AA contrast.</p>
                    </div>
                    {!playerColors && <PlanBadge />}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <ColorField label="Accent" value={accent} onChange={(value) => { setAccent(value); setDirty(true) }} disabled={!playerColors} />
                    <ColorField label="Foreground" value={foreground} onChange={(value) => { setForeground(value); setDirty(true) }} disabled={!playerColors} />
                    <ColorField label="Background" value={background} onChange={(value) => { setBackground(value); setDirty(true) }} disabled={!playerColors} />
                  </div>
                  {playerColors && colorsValid && !contrastValid && (
                    <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400 bg-amber-500/10 p-3 rounded-md border border-amber-500/20">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>
                        <strong>Low contrast:</strong> The contrast ratio between foreground and background is below 4.5:1.
                        This may be hard to read and fails WCAG AA accessibility standards.
                      </p>
                    </div>
                  )}
                  <div className="flex gap-2 pt-2">
                    {SWATCHES.map((c) => (
                      <button
                        type="button"
                        key={c}
                        disabled={!playerColors}
                        onClick={() => { setAccent(c); setDirty(true) }}
                        className="w-8 h-8 rounded-full shadow-sm ring-1 ring-inset ring-black/10 dark:ring-white/10 disabled:opacity-40 cursor-pointer transition-transform hover:scale-110 active:scale-95"
                        style={{ backgroundColor: c }}
                        aria-label={`Select ${c}`}
                      />
                    ))}
                  </div>
                  <div className="space-y-2 pt-2">
                    <Label>Poster treatment</Label>
                    <select
                      value={posterTreatment}
                      disabled={!playerColors}
                      onChange={(e) => {
                        setPosterTreatment(e.target.value as WorkspaceUpdatePosterTreatment)
                        setDirty(true)
                      }}
                      className="h-10 w-full rounded-lg border bg-input/20 px-3 text-sm disabled:opacity-50"
                    >
                      <option value="default">Default</option>
                      <option value="darken">Darken</option>
                      <option value="gradient">Gradient</option>
                    </select>
                  </div>
                </section>

                <section className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div className="flex justify-between items-start">
                      <h3 className="font-medium">Workspace logo</h3>
                      {!logo && <PlanBadge />}
                    </div>
                    <p className="text-sm text-muted-foreground">Logo upload is not implemented yet. Any existing asset remains read-only here.</p>
                    <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border">
                      {workspace.hasLogoAsset ? "Existing logo connected" : "No logo connected"}
                    </p>
                    <div className="space-y-2 pt-2">
                      <Label>Fallback initials</Label>
                      <Input
                        disabled={!logo}
                        value={initials}
                        onChange={(e) => {
                          setInitials(e.target.value.replace(/[^A-Za-z0-9]/g, "").substring(0, 3).toUpperCase())
                          setDirty(true)
                        }}
                        maxLength={3}
                        className={`w-24 uppercase font-bold text-center tracking-widest ${logo && !/^[A-Z0-9]{1,3}$/i.test(initials) ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-start">
                      <h3 className="font-medium">Player watermark</h3>
                      {!watermark && <PlanBadge />}
                    </div>
                    <p className="text-sm text-muted-foreground">Watermark upload is not implemented yet. Any existing asset remains read-only here.</p>
                    <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border">
                      {workspace.hasWatermarkAsset ? "Existing watermark connected" : "No watermark connected"}
                    </p>
                  </div>
                </section>

                <div className="p-4 bg-muted/20 flex justify-end">
                  <Button
                    onClick={handleSaveVisuals}
                    disabled={updateWorkspace.isPending || !dirty || (playerColors && (!colorsValid || !contrastValid)) || (logo && !initialsValid)}
                    className="min-w-32"
                  >
                    {updateWorkspace.isPending ? "Saving..." : "Save Visuals"}
                  </Button>
                </div>
              </div>
            </div>

            {/* Custom Domain Management */}
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-medium">Network & Delivery</h2>
              </div>
              <CustomDomainManager entitled={domain} />
            </div>
          </div>

          <div className="xl:col-span-5 relative">
            <div className="sticky top-8 space-y-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <ShieldCheck className="w-5 h-5 text-emerald-500" />
                <h2 className="font-medium text-foreground">Live Preview</h2>
              </div>
              <div className="rounded-xl shadow-2xl ring-1 ring-border bg-black overflow-hidden relative">
                <Player
                  title="Preview Visuals"
                  src={null}
                  poster={cssPoster}
                  accentColor={playerColors ? (isValidHex(accent) ? accent : workspace.playerAccent) : "#4f46e5"}
                  controlForegroundColor={playerColors ? (isValidHex(foreground) ? foreground : workspace.playerControlForeground) : "#ffffff"}
                  controlBackgroundColor={playerColors ? (isValidHex(background) ? background : workspace.playerControlBackground) : "#111827"}
                  posterTreatment={playerColors ? posterTreatment : "default"}
                  logoInitials={logo
                    ? (initials || workspace.logoInitials || workspace.name.slice(0, 2).toUpperCase())
                    : (workspace.logoInitials || workspace.name.slice(0, 2).toUpperCase())}
                  className="rounded-xl"
                />
              </div>
              <p className="text-sm text-muted-foreground text-center px-4">
                This preview represents visual styling only. Interactivity and domain changes apply when content is embedded.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PlanBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border whitespace-nowrap">
      Upgrade required
    </span>
  )
}

function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const isValid = isValidHex(value);
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <div className={`w-10 h-10 rounded border shrink-0 ${!isValid ? 'bg-muted' : ''}`} style={{ backgroundColor: isValid ? value : undefined }} />
        <Input
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const val = event.target.value;
            if (val.length <= 7) onChange(val);
          }}
          className={`font-mono uppercase ${!isValid ? 'border-destructive focus-visible:ring-destructive' : ''}`}
        />
      </div>
    </div>
  )
}
