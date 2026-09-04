import { Link } from "wouter"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Play, MoreHorizontal, Trash2, Video as VideoIcon, FolderInput } from "lucide-react"
import { formatDate, formatDuration } from "@/lib/utils"
import type { Video } from "@workspace/api-client-react"

function getStatusVariant(status: string) {
  if (status === 'ready') return 'default'
  if (status === 'error') return 'destructive'
  return 'secondary'
}

interface VideoListProps {
  allVideos: Video[];
  isLoading: boolean;
  canDelete: boolean;
  canUpdate: boolean;
  canCreate: boolean;
  hasActiveFilters: boolean;
  setVideoToDelete: (video: Video) => void;
  setVideoToMove: (video: Video) => void;
  onUploadSuccess: () => void;
  folderId?: string;
  selectedIds?: Set<string>;
  onToggleSelection?: (id: string) => void;
  onSelectAll?: (ids: string[]) => void;
  maxSelection?: number;
}

export function VideoList({
  allVideos,
  isLoading,
  canDelete,
  canUpdate,
  canCreate,
  hasActiveFilters,
  setVideoToDelete,
  setVideoToMove,
  onUploadSuccess,
  folderId,
  selectedIds = new Set(),
  onToggleSelection,
  onSelectAll,
  maxSelection = 50,
}: VideoListProps) {
  const isSelectable = canUpdate || canDelete;
  const allLoadedIds = allVideos.map(v => v.id);
  const selectableLoadedIds = allLoadedIds.slice(0, maxSelection);
  const allSelected = selectableLoadedIds.length > 0 && selectableLoadedIds.every(id => selectedIds.has(id));
  const someSelected = selectableLoadedIds.some(id => selectedIds.has(id));

  const handleSelectAll = (checked: boolean) => {
    if (!onSelectAll) return;
    if (checked) {
      onSelectAll(selectableLoadedIds);
    } else {
      onSelectAll([]);
    }
  };

  return (
    <>
      {/* Desktop Table */}
      <div className="hidden md:block border rounded-xl bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {isSelectable && (
                <TableHead className="w-[40px] pl-4 pr-0">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={handleSelectAll}
                    aria-label={`Select up to ${maxSelection} loaded videos`}
                  />
                </TableHead>
              )}
              <TableHead className="w-[400px]">Video</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead className="text-right">Plays</TableHead>
              <TableHead className="text-right">Added</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && !allVideos.length ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {isSelectable && (
                    <TableCell className="pl-4 pr-0">
                      <Skeleton className="h-4 w-4 rounded-sm" />
                    </TableCell>
                  )}
                  <TableCell><div className="flex gap-4"><Skeleton className="h-12 w-20 rounded-md" /><div className="space-y-2 py-1"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-32" /></div></div></TableCell>
                  <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8 rounded-md ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : (
              allVideos.map((video) => {
                const isSelected = selectedIds.has(video.id);
                return (
                <TableRow
                  key={video.id}
                  data-testid={`row-video-${video.id}`}
                  className={`group hover:bg-muted/50 transition-colors ${isSelected ? 'bg-primary/5' : ''}`}
                >
                  {isSelectable && (
                    <TableCell className="pl-4 pr-0">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleSelection?.(video.id)}
                        disabled={!isSelected && selectedIds.size >= maxSelection}
                        aria-label={`Select ${video.title}`}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex items-center gap-4">
                      <div
                        className="w-20 h-12 rounded-md overflow-hidden flex items-center justify-center text-white flex-shrink-0 shadow-sm relative group/thumb bg-muted"
                        style={video.thumbnailUrl ? {} : { backgroundColor: video.thumbnailColor || '#333' }}
                      >
                        {video.thumbnailUrl && <img src={video.thumbnailUrl} alt={`Thumbnail for ${video.title}`} className="absolute inset-0 w-full h-full object-cover z-0" />}
                        <Play className="h-5 w-5 opacity-40 group-hover:opacity-100 transition-opacity relative z-10" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-foreground truncate max-w-[280px]" title={video.title}>{video.title}</div>
                        {video.description && (
                          <div className="text-xs text-muted-foreground truncate max-w-[280px] mt-0.5" title={video.description}>{video.description}</div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getStatusVariant(video.status)} className="capitalize font-medium shadow-none" data-testid={`badge-status-${video.id}`}>
                      {video.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize text-muted-foreground font-medium bg-background" data-testid={`badge-visibility-${video.id}`}>
                      {video.visibility}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {formatDuration(video.durationSeconds)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {video.plays}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm whitespace-nowrap">
                    {formatDate(video.createdAt)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity" data-testid={`button-video-actions-${video.id}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem asChild>
                          <Link href={`/videos/${video.id}`} className="cursor-pointer">View Details</Link>
                        </DropdownMenuItem>
                        {canUpdate && (
                          <DropdownMenuItem onClick={() => setVideoToMove(video)} className="cursor-pointer">
                            <FolderInput className="h-4 w-4 mr-2" /> Move
                          </DropdownMenuItem>
                        )}
                        {canDelete && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
                              onClick={() => setVideoToDelete(video)}
                              data-testid={`menu-delete-${video.id}`}
                            >
                              <Trash2 className="h-4 w-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile List */}
      <div className="md:hidden flex flex-col gap-3">
        {isSelectable && allVideos.length > 0 && (
          <div className="flex items-center gap-2 px-1 mb-1">
            <Checkbox
              id="select-all-mobile"
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={handleSelectAll}
              aria-label={`Select up to ${maxSelection} loaded videos`}
            />
            <label htmlFor="select-all-mobile" className="text-sm font-medium cursor-pointer">
              Select up to {maxSelection}
            </label>
          </div>
        )}
        {isLoading && !allVideos.length ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="overflow-hidden shadow-sm">
              <div className="flex p-3 gap-3">
                <Skeleton className="w-28 h-16 rounded-md" />
                <div className="flex-1 space-y-2 py-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            </Card>
          ))
        ) : (
          allVideos.map(video => {
            const isSelected = selectedIds.has(video.id);
            return (
            <Card
              key={video.id}
              className={`overflow-hidden shadow-sm border ${isSelected ? 'bg-primary/5 border-primary/20' : ''}`}
              data-testid={`card-video-${video.id}`}
            >
              <div className="flex p-3 gap-4 relative">
                {isSelectable && (
                  <div className="absolute top-2 left-2 z-10 bg-background/80 rounded-sm">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => onToggleSelection?.(video.id)}
                      disabled={!isSelected && selectedIds.size >= maxSelection}
                      aria-label={`Select ${video.title}`}
                    />
                  </div>
                )}
                <div
                  className="w-28 h-16 rounded-md overflow-hidden flex items-center justify-center text-white flex-shrink-0 relative bg-muted"
                  style={video.thumbnailUrl ? {} : { backgroundColor: video.thumbnailColor || '#333' }}
                >
                  {video.thumbnailUrl && <img src={video.thumbnailUrl} alt={`Thumbnail for ${video.title}`} className="absolute inset-0 w-full h-full object-cover z-0" />}
                  <Play className="h-6 w-6 opacity-50 relative z-10" />
                </div>
                <div className="flex-1 min-w-0 py-0.5 flex flex-col justify-between">
                  <div className="flex justify-between items-start gap-2">
                    <div className="font-semibold truncate text-sm leading-tight text-foreground">{video.title}</div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-6 w-6 -mt-1 -mr-2 flex-shrink-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/videos/${video.id}`} className="cursor-pointer">View Details</Link>
                        </DropdownMenuItem>
                        {canUpdate && (
                          <DropdownMenuItem onClick={() => setVideoToMove(video)} className="cursor-pointer">
                            <FolderInput className="h-4 w-4 mr-2" /> Move
                          </DropdownMenuItem>
                        )}
                        {canDelete && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
                              onClick={() => setVideoToDelete(video)}
                            >
                              <Trash2 className="h-4 w-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <Badge variant={getStatusVariant(video.status)} className="text-[10px] px-1.5 py-0 font-medium shadow-none">
                      {video.status}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground font-mono">{formatDuration(video.durationSeconds)}</span>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground font-medium">
                    <span>{video.plays} plays</span>
                    <span>{formatDate(video.createdAt)}</span>
                  </div>
                </div>
              </div>
            </Card>
            )
          })
        )}
      </div>

      {/* Empty States */}
      {!isLoading && allVideos.length === 0 && (
          <div className="py-20 text-center border rounded-xl bg-card border-dashed mt-4 shadow-sm">
            <div className="bg-muted h-16 w-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <VideoIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold tracking-tight text-foreground">No videos found</h3>
            <p className="text-muted-foreground mt-2 max-w-sm mx-auto px-4">
              {hasActiveFilters ? "Try adjusting your filters or search terms to find what you're looking for." : "Upload your first video to get started with your library."}
            </p>
          </div>
      )}
    </>
  )
}