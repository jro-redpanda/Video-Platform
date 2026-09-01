import { type CSSProperties, type ReactNode } from "react"
import { useGetWorkspace } from "@workspace/api-client-react"
import { Sidebar } from "./sidebar"

export function Shell({ children }: { children: ReactNode }) {
  const { data: workspace } = useGetWorkspace()
  const theme = workspace ? {
    "--player-accent": workspace.playerAccent,
    "--player-control-fg": workspace.playerControlForeground,
    "--player-control-bg": workspace.playerControlBackground,
    "--player-poster-treatment": workspace.posterTreatment,
  } as CSSProperties : undefined

  return (
    <div data-org-theme className="flex min-h-[100dvh] w-full bg-background text-foreground" style={theme}>
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  )
}
