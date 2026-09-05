import * as React from "react"
import { Link, useLocation } from "wouter"
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  PlaySquare,
  BarChart2,
  Users,
  Palette,
  Settings,
  ClipboardList
} from "lucide-react"

import { useGetWorkspace } from "@workspace/api-client-react"
import { Skeleton } from "../ui/skeleton"
import { WorkspaceSwitcher } from "../workspace-switcher"

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/videos", label: "Library", icon: PlaySquare },
  { href: "/analytics", label: "Analytics", icon: BarChart2 },
  { href: "/members", label: "Members", icon: Users },
  { href: "/customization", label: "Customization", icon: Palette },
  { href: "/audit", label: "Audit Log", icon: ClipboardList },
  { href: "/settings", label: "Settings", icon: Settings },
]

export function Sidebar() {
  const [location] = useLocation()
  const { data: workspace, isLoading } = useGetWorkspace()

  return (
    <aside className="w-64 border-r bg-sidebar flex-shrink-0 flex flex-col h-[100dvh] sticky top-0">
      <div className="h-[72px] flex items-center px-4 border-b">
        <WorkspaceSwitcher />
      </div>

      <nav className="flex-1 overflow-y-auto p-4 space-y-1">
        <div className="text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider mb-2 mt-2 px-2">
          Operations
        </div>
        {navItems.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href))
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              data-testid={`link-navigation-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="p-4 border-t border-sidebar-border">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-2 w-full bg-sidebar-accent" />
            <Skeleton className="h-2 w-2/3 bg-sidebar-accent" />
          </div>
        ) : workspace ? (
          <div className="text-xs text-sidebar-foreground/70 space-y-2">
            <div className="flex justify-between items-center">
              <span>Storage</span>
              <span className="font-medium text-sidebar-foreground">{workspace.storageUsedGb} / {workspace.storageLimitGb} GB</span>
            </div>
            <div className="h-1.5 w-full bg-sidebar-accent rounded-full overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{ width: `${workspace.storageLimitGb > 0 ? Math.min(100, (workspace.storageUsedGb / workspace.storageLimitGb) * 100) : 0}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
