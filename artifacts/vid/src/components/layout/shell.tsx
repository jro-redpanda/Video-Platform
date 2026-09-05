import { type CSSProperties, type ReactNode, useState, useEffect } from "react"
import { useLocation } from "wouter"
import { useGetWorkspace } from "@workspace/api-client-react"
import { Sidebar } from "./sidebar"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet"
import { Menu, RefreshCw } from "lucide-react"
import { Button } from "../ui/button"

export function Shell({ children }: { children: ReactNode }) {
  const { data: workspace, isLoading, isError, isFetching, refetch } = useGetWorkspace()
  const [location] = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Close mobile menu on navigate
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location])

  if (isLoading && !workspace) {
    return (
      <div className="min-h-[100dvh] grid place-items-center text-muted-foreground" role="status">
        Loading workspace…
      </div>
    )
  }

  if (isError || !workspace) {
    return (
      <div className="min-h-[100dvh] grid place-items-center p-6 text-center" role="alert">
        <div>
          <p className="font-medium text-destructive">Failed to load workspace details.</p>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid="button-retry-workspace"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {isFetching ? "Retrying…" : "Try again"}
          </Button>
        </div>
      </div>
    )
  }

  const theme = workspace ? {
    "--player-accent": workspace.playerAccent,
    "--player-control-fg": workspace.playerControlForeground,
    "--player-control-bg": workspace.playerControlBackground,
    "--player-poster-treatment": workspace.posterTreatment,
  } as CSSProperties : undefined

  return (
    <div data-org-theme className="flex min-h-[100dvh] w-full bg-background text-foreground" style={theme}>
      {/* Desktop Sidebar */}
      <div className="hidden md:flex flex-shrink-0">
        <Sidebar />
      </div>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Mobile Header with Hamburger */}
        <header className="md:hidden grid grid-cols-[2.5rem_1fr_2.5rem] items-center h-14 px-4 border-b bg-sidebar shrink-0">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-ml-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" data-testid="button-mobile-menu">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle navigation menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 border-r-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Workspace navigation</SheetTitle>
                <SheetDescription>Navigate to another section of this workspace.</SheetDescription>
              </SheetHeader>
              <Sidebar />
            </SheetContent>
          </Sheet>

          <div className="font-semibold text-sm truncate text-center text-sidebar-foreground">
            {workspace.name}
          </div>
          <div aria-hidden="true" />
        </header>

        {children}
      </main>
    </div>
  )
}
