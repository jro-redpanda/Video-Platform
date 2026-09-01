import { useEffect, useRef, useState, useMemo, useCallback, Fragment } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useListVideos, useGetWorkspace, getListVideosQueryKey, useListFolders, useGetFolder, getListFoldersQueryKey, getGetFolderQueryKey } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Loader2, Home, ChevronRight, MoreHorizontal, FolderPlus, Pencil, FolderInput, Trash2 } from "lucide-react"
import type { Video, Folder, FolderDetail } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"

import { useVideoFilters } from "@/components/video-library/use-video-filters"
import { VideoFiltersBar } from "@/components/video-library/video-filters-bar"
import { VideoList } from "@/components/video-library/video-list"
import { UploadVideoDialog } from "@/components/video-library/upload-video-dialog"
import { DeleteVideoDialog } from "@/components/video-library/delete-video-dialog"
import { MoveVideoDialog } from "@/components/video-library/move-video-dialog"
import { FolderGrid } from "@/components/folders/folder-grid"
import { CreateFolderDialog, RenameFolderDialog, MoveFolderDialog, DeleteFolderDialog } from "@/components/folders/folder-dialogs"

export default function Videos() {
  const { data: workspace } = useGetWorkspace()
  const canCreate = workspace?.permissions?.includes("videos.create") ?? false
  const canDelete = workspace?.permissions?.includes("videos.delete") ?? false
  const canUpdate = workspace?.permissions?.includes("videos.update") ?? false

  const { filters, setFilter, clearFilters, hasActiveFilters } = useVideoFilters()
  const [searchInput, setSearchInput] = useState(filters.search)
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined)
  const [allVideos, setAllVideos] = useState<Video[]>([])

  const [resetGeneration, setResetGeneration] = useState(0)

  const prevFiltersStr = useRef(JSON.stringify(filters))

  // Dialog states
  const [videoToDelete, setVideoToDelete] = useState<Video | null>(null)
  const [videoToMove, setVideoToMove] = useState<Video | null>(null)

  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderToRename, setFolderToRename] = useState<Folder | FolderDetail | null>(null)
  const [folderToMove, setFolderToMove] = useState<Folder | FolderDetail | null>(null)
  const [folderToDelete, setFolderToDelete] = useState<Folder | FolderDetail | null>(null)

  // Fetch current folder if not root
  const { data: folderDetail, isLoading: isFolderLoading, error: folderError } = useGetFolder(filters.folder, {
    query: {
      enabled: filters.folder !== "root",
      queryKey: getGetFolderQueryKey(filters.folder)
    }
  })

  // Fetch child folders
  const { data: childFolders, isLoading: isChildFoldersLoading, error: childFoldersError } = useListFolders({ parentId: filters.folder }, {
    query: { queryKey: getListFoldersQueryKey({ parentId: filters.folder }) }
  })

  // Sync search input when filters.search changes externally (e.g., via popstate or clear)
  useEffect(() => {
    if (searchInput !== filters.search) {
      setSearchInput(filters.search)
    }
  }, [filters.search])

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
    folderId: filters.folder,
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

  const isRoot = filters.folder === "root";
  const currentTitle = isRoot ? "Library" : folderDetail?.name || "Loading...";

  const handleDeleteCurrentFolderSuccess = () => {
    setFilter('folder', folderDetail?.parentId || 'root')
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 p-4 md:p-8 overflow-y-auto">

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-sm font-medium mb-6 overflow-x-auto whitespace-nowrap scrollbar-hide pb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter('folder', 'root')}
            className={cn("px-2 shrink-0 text-muted-foreground", isRoot && "bg-muted text-foreground pointer-events-none")}
          >
            <Home className="h-4 w-4 mr-2" /> Library
          </Button>
          {folderDetail?.ancestors.map(anc => (
            <div key={anc.id} className="flex items-center shrink-0">
              <ChevronRight className="h-4 w-4 text-muted-foreground mx-1" />
              <Button variant="ghost" size="sm" onClick={() => setFilter('folder', anc.id)} className="px-2 text-muted-foreground hover:text-foreground">
                {anc.name}
              </Button>
            </div>
          ))}
          {folderDetail && (
            <div className="flex items-center shrink-0">
              <ChevronRight className="h-4 w-4 text-muted-foreground mx-1" />
              <Button variant="ghost" size="sm" className="px-2 bg-muted text-foreground pointer-events-none" disabled>
                {folderDetail.name}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight truncate max-w-[400px]">
              {folderError ? "Folder not found" : currentTitle}
            </h1>
            {!isRoot && canUpdate && folderDetail && !folderError && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="h-8 w-8 rounded-full border-dashed">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setFolderToRename(folderDetail)}>
                    <Pencil className="h-4 w-4 mr-2" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setFolderToMove(folderDetail)}>
                    <FolderInput className="h-4 w-4 mr-2" /> Move
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setFolderToDelete(folderDetail)} className="text-destructive focus:text-destructive focus:bg-destructive/10">
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canUpdate && !folderError && (
              <Button variant="secondary" onClick={() => setCreateFolderOpen(true)} className="gap-2 shadow-sm">
                <FolderPlus className="h-4 w-4" /> New Folder
              </Button>
            )}
            {canCreate && !folderError && (
              <UploadVideoDialog onSuccess={resetAndRefetch} folderId={isRoot ? null : filters.folder} />
            )}
          </div>
        </div>

        {folderError ? (
          <div className="p-12 text-center border rounded-xl bg-card shadow-sm mt-4">
            <p className="font-semibold text-lg mb-2">Folder not found</p>
            <p className="text-sm text-muted-foreground mb-6">The folder you are looking for does not exist or you don't have access.</p>
            <Button onClick={() => setFilter('folder', 'root')} className="min-w-[120px]">
              Go to Root Library
            </Button>
          </div>
        ) : (
          <>
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

            {/* Child Folders */}
            {!hasActiveFilters && (isChildFoldersLoading || childFoldersError || (childFolders && childFolders.length > 0)) && (
              <div className="mb-8 mt-6">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Folders</h2>

                {isChildFoldersLoading ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 p-3 border rounded-lg bg-card overflow-hidden">
                        <Skeleton className="h-10 w-10 rounded shrink-0" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-3 w-1/2" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : childFoldersError ? (
                  <div className="p-4 text-center border rounded-lg bg-destructive/5 text-destructive text-sm">
                    Failed to load folders. Please try again.
                  </div>
                ) : childFolders && (
                  <FolderGrid
                    folders={childFolders}
                    onNavigate={(id) => setFilter('folder', id)}
                    onRename={setFolderToRename}
                    onMove={setFolderToMove}
                    onDelete={setFolderToDelete}
                    canUpdate={canUpdate}
                  />
                )}
              </div>
            )}

            {error ? (
              <div className="p-12 text-center border rounded-xl bg-destructive/5 text-destructive mt-4">
                <p className="font-semibold text-lg mb-2">Failed to load videos</p>
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
                  canUpdate={canUpdate}
                  canCreate={canCreate}
                  hasActiveFilters={hasActiveFilters}
                  setVideoToDelete={setVideoToDelete}
                  setVideoToMove={setVideoToMove}
                  onUploadSuccess={resetAndRefetch}
                  folderId={filters.folder}
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
          </>
        )}
      </div>

      <DeleteVideoDialog
        video={videoToDelete}
        open={!!videoToDelete}
        onOpenChange={(open) => !open && setVideoToDelete(null)}
        onSuccess={resetAndRefetch}
      />

      <MoveVideoDialog
        video={videoToMove}
        open={!!videoToMove}
        onOpenChange={(open) => !open && setVideoToMove(null)}
        onSuccess={resetAndRefetch}
      />

      <CreateFolderDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        parentId={filters.folder}
      />

      <RenameFolderDialog
        folder={folderToRename}
        open={!!folderToRename}
        onOpenChange={(open) => !open && setFolderToRename(null)}
        onSuccess={() => {
          if (folderToRename?.id === filters.folder) {
            queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(filters.folder) })
          }
        }}
      />

      <MoveFolderDialog
        folder={folderToMove}
        open={!!folderToMove}
        onOpenChange={(open) => !open && setFolderToMove(null)}
        onSuccess={() => {
          if (folderToMove?.id === filters.folder) {
             queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(filters.folder) })
          }
        }}
      />

      <DeleteFolderDialog
        folder={folderToDelete}
        open={!!folderToDelete}
        onOpenChange={(open) => !open && setFolderToDelete(null)}
        onSuccess={() => {
          if (folderToDelete?.id === filters.folder) {
            handleDeleteCurrentFolderSuccess()
          }
        }}
      />
    </div>
  )
}
