import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Search, X } from "lucide-react"
import type { ListVideosStatus, ListVideosVisibility, ListVideosSort } from "@workspace/api-client-react"

interface VideoFiltersBarProps {
  searchInput: string;
  setSearchInput: (val: string) => void;
  filters: {
    status?: ListVideosStatus;
    visibility?: ListVideosVisibility;
    sort: ListVideosSort;
  };
  setFilter: (key: string, value: any) => void;
  hasActiveFilters: boolean;
  clearFilters: () => void;
}

export function VideoFiltersBar({
  searchInput,
  setSearchInput,
  filters,
  setFilter,
  hasActiveFilters,
  clearFilters
}: VideoFiltersBarProps) {
  return (
    <div className="flex flex-col md:flex-row gap-3 mb-6 p-4 rounded-xl border bg-card shadow-sm">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search videos..."
          className="pl-9 bg-background h-10"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          data-testid="input-search-videos"
        />
      </div>

      <div className="flex flex-wrap sm:flex-nowrap gap-3">
        <Select value={filters.status || "all"} onValueChange={(v) => setFilter("status", v === "all" ? undefined : v as ListVideosStatus)}>
          <SelectTrigger className="w-full sm:w-[140px] bg-background h-10" data-testid="select-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="ready">Ready</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="uploading">Uploading</SelectItem>
            <SelectItem value="created">Created</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.visibility || "all"} onValueChange={(v) => setFilter("visibility", v === "all" ? undefined : v as ListVideosVisibility)}>
          <SelectTrigger className="w-full sm:w-[140px] bg-background h-10" data-testid="select-visibility">
            <SelectValue placeholder="Visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Visibilities</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="unlisted">Unlisted</SelectItem>
            <SelectItem value="private">Private</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.sort || "newest"} onValueChange={(v) => setFilter("sort", v as ListVideosSort)}>
          <SelectTrigger className="w-full sm:w-[160px] bg-background h-10" data-testid="select-sort">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest First</SelectItem>
            <SelectItem value="oldest">Oldest First</SelectItem>
            <SelectItem value="title_asc">Title (A-Z)</SelectItem>
            <SelectItem value="title_desc">Title (Z-A)</SelectItem>
            <SelectItem value="plays_desc">Most Plays</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" onClick={clearFilters} className="px-3 h-10" data-testid="button-clear-filters">
            <X className="h-4 w-4 md:mr-2" />
            <span className="hidden md:inline">Clear</span>
          </Button>
        )}
      </div>
    </div>
  )
}
