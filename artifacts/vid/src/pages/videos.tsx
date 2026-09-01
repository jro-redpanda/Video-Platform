import { useEffect, useRef, useState, useMemo, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useListVideos, useGetWorkspace, getListVideosQueryKey } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Loader2 } from "lucide-react"
import type { Video } from "@workspace/api-client-react"

import { useVideoFilters } from "@/components/video-library/use-video-filters"
import { VideoFiltersBar } from "@/components/video-library/video-filters-bar"
import { VideoList } from "@/components/video-library/video-list"
import { UploadVideoDialog } from "@/components/video-library/upload-video-dialog"
import { DeleteVideoDialog } from "@/components/video-library/delete-video-dialog"

export default function Videos() {
  const { data: workspace } = useGetWorkspace()
  const canCreate = workspace?.permissions?.includes("videos.create") ?? false
  const canDelete = workspace?.permissions?.includes("videos.delete") ?? false

  const { filters, setFilter, clearFilters, hasActiveFilters } = useVideoFilters()
  const [searchInput, setSearchInput] = useState(filters.search)
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined)
  const [allVideos, setAllVideos] = useState<Video[]>([])

  const [resetGeneration, setResetGeneration] = useState(0)

  const prevFiltersStr = useRef(JSON.stringify(filters))
  const [videoToDelete, setVideoToDelete] = useState<Video | null>(null)

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter("search", searchInput)
    }, 500)
    return () => clearTimeout(timer)
  }, [searchInput, setFilter])

  // Reset pagination on filter change
  useEffect(() => {
    const currStr = JSON.stringify(filters)
    if (prevFiltersStr.current !== currStr) {
      setAllVideos([])
      setCurrentCursor(undefined)
      setResetGeneration(g => g + 1)
      prevFiltersStr.current = currStr
    }
  }, [filters])

  const queryParams = useMemo(() => ({
    search: filters.search || undefined,
    status: filters.status,
    visibility: filters.visibility,
    sort: filters.sort,
    limit: 20,
    cursor: currentCursor
  }), [filters, currentCursor])

  const { data, isLoading, error, isFetching } = useListVideos(queryParams)

  const queryClient = useQueryClient()

  const resetAndRefetch = useCallback(() => {
    setCurrentCursor(undefined)
    setResetGeneration(g => g + 1)
    queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() })
  }, [queryClient])

  // Append items for pagination without duplicates
  useEffect(() => {
    if (data?.items) {
      setAllVideos(prev => {
        if (!currentCursor) return data.items
        const newItems = data.items.filter(item => !prev.some(p => p.id === item.id))
        if (newItems.length > 0) return [...prev, ...newItems]
        return prev
      })
    }
  }, [data, currentCursor, resetGeneration])

  const handleLoadMore = () => {
    if (data?.nextCursor) {
      setCurrentCursor(data.nextCursor)
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 p-4 md:p-8 overflow-y-auto">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Library</h1>
            <p className="text-muted-foreground mt-1">Manage and organize your video content.</p>
          </div>
          {canCreate && <UploadVideoDialog onSuccess={resetAndRefetch} />}
        </div>

        <VideoFiltersBar
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          filters={filters}
          setFilter={setFilter}
          hasActiveFilters={hasActiveFilters}
          clearFilters={() => {
            setSearchInput("")
            clearFilters()
          }}
        />

        {error ? (
          <div className="p-12 text-center border rounded-xl bg-destructive/5 text-destructive mt-4">
            <p className="font-semibold text-lg mb-2">Failed to load library</p>
            <p className="text-sm opacity-90">Please try refreshing the page or check your connection.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm text-muted-foreground mb-4 px-1">
              {data?.total !== undefined ? (
                <span data-testid="text-total-videos" className="font-medium">
                  {data.total} {data.total === 1 ? 'video' : 'videos'}
                </span>
              ) : (
                <Skeleton className="h-5 w-24" />
              )}
            </div>

            <VideoList
              allVideos={allVideos}
              isLoading={isLoading}
              canDelete={canDelete}
              canCreate={canCreate}
              hasActiveFilters={hasActiveFilters}
              setVideoToDelete={setVideoToDelete}
              onUploadSuccess={resetAndRefetch}
            />

            {/* Load More */}
            {data?.nextCursor && (
              <div className="mt-8 mb-4 flex justify-center">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={isFetching}
                  className="min-w-[160px] bg-card shadow-sm"
                  data-testid="button-load-more"
                >
                  {isFetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  {isFetching ? "Loading..." : "Load More"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <DeleteVideoDialog
        video={videoToDelete}
        open={!!videoToDelete}
        onOpenChange={(open) => !open && setVideoToDelete(null)}
        onSuccess={resetAndRefetch}
      />
    </div>
  )
}
