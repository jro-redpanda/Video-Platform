import { type CSSProperties, type ReactNode, useState, useEffect } from "react"
import { useLocation } from "wouter"
import { useGetWorkspace } from "@workspace/api-client-react"
import { Sidebar } from "./sidebar"
import { Sheet, SheetContent, SheetTrigger } from "../ui/sheet"
import { Menu } from "lucide-react"
import { Button } from "../ui/button"

export function Shell({ children }: { children: ReactNode }) {
  const { data: workspace } = useGetWorkspace()
  const [location] = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Close mobile menu on navigate
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location])

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
        <header className="md:hidden flex items-center h-14 px-4 border-b bg-sidebar shrink-0 gap-4">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-ml-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" data-testid="button-mobile-menu">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle navigation menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 border-r-0">
              <Sidebar />
            </SheetContent>
          </Sheet>

          <div className="font-semibold text-sm truncate flex-1 text-sidebar-foreground flex justify-center pr-8">
            {workspace?.name || "Workspace"}
          </div>
        </header>

        {children}
      </main>
    </div>
  )
}
