import { useState, useEffect } from "react"
import { useGetWorkspace, useUpdateWorkspace, getGetWorkspaceQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Play, Maximize, Settings2 } from "lucide-react"

const SWATCHES = [
  "#4f46e5", // Indigo
  "#0ea5e9", // Blue
  "#10b981", // Sky
  "#14b8a6", // Teal
  "#22c55e", // Emerald
  "#84cc16", // Mint
  "#eab308", // Yellow
  "#f97316", // Orange
  "#ef4444", // Red
  "#ec4899", // Rose
  "#d946ef", // Pink
  "#a855f7", // Fuchsia
  "#8b5cf6", // Purple
]

export default function Customization() {
  const { data: workspace, isLoading } = useGetWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const queryClient = useQueryClient()

  const [accent, setAccent] = useState("#4f46e5")
  const [initials, setInitials] = useState("VP")

  useEffect(() => {
    if (workspace) {
      setAccent(workspace.playerAccent)
      setInitials(workspace.logoInitials)
    }
  }, [workspace])

  const handleSave = () => {
    updateWorkspace.mutate({ data: { playerAccent: accent, logoInitials: initials } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetWorkspaceQueryKey(), data)
      }
    })
  }

  if (isLoading) {
    return <div className="p-8"><Skeleton className="h-[400px] w-full" /></div>
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-8">
        
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customization</h1>
          <p className="text-muted-foreground mt-1">Brand your video player experience to match your company.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          {/* Controls */}
          <div className="space-y-8">
            
            <div className="space-y-4 border rounded-lg p-6 bg-card">
              <h3 className="text-lg font-semibold border-b pb-2">Player Accent Color</h3>
              <p className="text-sm text-muted-foreground mb-4">Choose a primary color for the timeline, buttons, and focused states in your embedded player.</p>
              
              <div className="flex items-center gap-4">
                <div 
                  className="w-12 h-12 rounded-md shadow-sm border" 
                  style={{ backgroundColor: accent }} 
                />
                <Input 
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  className="w-32 font-mono uppercase"
                  maxLength={7}
                />
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                {SWATCHES.map((color) => (
                  <button
                    key={color}
                    onClick={() => setAccent(color)}
                    className="w-8 h-8 rounded-full border shadow-sm transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-2"
                    style={{ 
                      backgroundColor: color,
                      outlineColor: accent === color ? color : 'transparent' 
                    }}
                    aria-label={`Select color ${color}`}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-4 border rounded-lg p-6 bg-card">
              <h3 className="text-lg font-semibold border-b pb-2">Watermark / Logo</h3>
              <p className="text-sm text-muted-foreground mb-4">Fallback initials displayed in the player when no logo is provided.</p>
              <div className="space-y-2">
                <Label>Initials (1-3 chars)</Label>
                <Input 
                  value={initials}
                  onChange={(e) => setInitials(e.target.value.substring(0, 3).toUpperCase())}
                  className="w-24 uppercase font-bold"
                  maxLength={3}
                />
              </div>
            </div>

            <Button size="lg" onClick={handleSave} disabled={updateWorkspace.isPending}>
              {updateWorkspace.isPending ? "Saving..." : "Save Customization"}
            </Button>
          </div>

          {/* Preview */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-muted-foreground">Live Player Preview</h3>
            
            <div className="rounded-xl overflow-hidden shadow-2xl ring-1 ring-border bg-black aspect-video relative flex flex-col justify-between group">
              {/* // MOCK: replaced at step 11 */}
              <div className="absolute inset-0 bg-gradient-to-br from-zinc-800 to-black flex items-center justify-center pointer-events-none">
                <div className="w-48 h-48 rounded-full border-4 border-white/5 flex items-center justify-center">
                   <div className="w-24 h-24 rounded-full border-4 border-white/10" />
                </div>
              </div>

              {/* Top Bar */}
              <div className="w-full p-4 flex justify-between items-center bg-gradient-to-b from-black/80 to-transparent z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="font-medium text-white shadow-sm flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-white/20 backdrop-blur-md flex items-center justify-center text-sm font-bold" style={{ color: accent }}>
                    {initials}
                  </div>
                  Preview Video Title
                </div>
                <div className="text-white/80 hover:text-white cursor-pointer">
                  <Settings2 className="h-5 w-5" />
                </div>
              </div>

              {/* Center Play Button */}
              <div className="z-10 m-auto flex items-center justify-center">
                <div 
                  className="w-20 h-20 rounded-full flex items-center justify-center cursor-pointer hover:scale-105 transition-transform shadow-xl backdrop-blur-md"
                  style={{ backgroundColor: accent }}
                >
                  <Play className="h-10 w-10 text-white ml-2" />
                </div>
              </div>

              {/* Bottom Bar */}
              <div className="w-full p-4 bg-gradient-to-t from-black/90 to-transparent z-10 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {/* Scrubber */}
                <div className="w-full h-1.5 bg-white/30 rounded-full cursor-pointer overflow-hidden flex relative">
                   <div className="h-full w-1/3" style={{ backgroundColor: accent }} />
                   <div className="w-3 h-3 rounded-full absolute top-1/2 -translate-y-1/2 shadow-sm left-1/3 -ml-1.5" style={{ backgroundColor: accent }} />
                </div>
                
                {/* Controls */}
                <div className="flex justify-between items-center text-white/90">
                  <div className="flex gap-4 items-center">
                    <Play className="h-5 w-5 cursor-pointer hover:text-white" />
                    <span className="text-xs font-mono">01:23 / 04:56</span>
                  </div>
                  <div>
                    <Maximize className="h-4 w-4 cursor-pointer hover:text-white" />
                  </div>
                </div>
              </div>
            </div>
            
            <p className="text-xs text-center text-muted-foreground mt-4">
              Interact with the preview to see hover states and colors.
            </p>
          </div>
          
        </div>
      </div>
    </div>
  )
}
