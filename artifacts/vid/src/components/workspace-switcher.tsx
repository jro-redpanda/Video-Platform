import * as React from "react"
import { Check, ChevronsUpDown, LogOut } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"

import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useListWorkspaces, useSelectWorkspace, useGetWorkspace } from "@workspace/api-client-react"
import { authClient } from "@/lib/auth-client"
import { useToast } from "@/components/ui/use-toast"

export function WorkspaceSwitcher() {
  const { data: workspaces } = useListWorkspaces()
  const { data: workspace, isLoading } = useGetWorkspace()
  const selectWorkspace = useSelectWorkspace()
  const queryClient = useQueryClient()
  const [, setLocation] = useLocation()
  const [isSwitching, setIsSwitching] = React.useState(false)
  const { toast } = useToast()

  const activeWorkspace = workspaces?.find(w => w.current) || workspaces?.find(w => w.id === workspace?.id)

  const handleSwitch = async (id: string) => {
    if (id === activeWorkspace?.id) return
    setIsSwitching(true)
    try {
      await selectWorkspace.mutateAsync({ data: { id } })
      await queryClient.cancelQueries()
      queryClient.clear()
      setLocation("/", { replace: true })
      window.location.reload()
    } catch {
      toast({
        title: "Workspace switch failed",
        description: "Your current workspace has not changed. Please try again.",
        variant: "destructive",
      })
      setIsSwitching(false)
    }
  }

  const handleLogout = async () => {
    try {
      await authClient.signOut()
    } finally {
      await queryClient.cancelQueries()
      queryClient.clear()
      setLocation("/", { replace: true })
      window.location.reload()
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-3 w-full px-2 py-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring text-left" data-testid="button-workspace-switcher" disabled={isSwitching}>
        {isLoading || isSwitching ? (
          <Skeleton className="h-8 w-8 rounded bg-sidebar-accent shrink-0" />
        ) : (
          <div
            className="h-8 w-8 rounded flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ backgroundColor: workspace?.playerAccent || 'var(--primary)' }}
          >
            {workspace?.logoInitials || 'VP'}
          </div>
        )}
        <div className="flex flex-col flex-1 overflow-hidden">
          <span className="truncate text-sm font-semibold text-sidebar-foreground">
            {isLoading || isSwitching ? <Skeleton className="h-4 w-24 bg-sidebar-accent" /> : workspace?.name}
          </span>
          <span className="truncate text-xs text-sidebar-foreground/60">
            {workspace?.plan ? workspace.plan.charAt(0).toUpperCase() + workspace.plan.slice(1) : "Free"}
          </span>
        </div>
        <ChevronsUpDown className="h-4 w-4 text-sidebar-foreground/50 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start" side="bottom" sideOffset={8}>
        <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">Workspaces</DropdownMenuLabel>
        {workspaces?.map((ws) => (
          <DropdownMenuItem
            key={ws.id}
            onSelect={() => handleSwitch(ws.id)}
            className="flex items-center gap-2 cursor-pointer"
            data-testid={`menu-item-workspace-${ws.id}`}
          >
            <div className="h-6 w-6 rounded bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
              {ws.name.slice(0, 2).toUpperCase()}
            </div>
            <span className="flex-1 truncate">{ws.name}</span>
            {ws.id === activeWorkspace?.id && <Check className="h-4 w-4 text-primary shrink-0" />}
          </DropdownMenuItem>
        ))}
        
        <DropdownMenuSeparator />
        
        <DropdownMenuItem onSelect={handleLogout} className="text-destructive focus:bg-destructive/10 cursor-pointer gap-2" data-testid="menu-item-logout">
          <LogOut className="h-4 w-4" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
