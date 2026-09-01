import { Folder as FolderIcon, MoreHorizontal, Pencil, Trash2, FolderInput } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import type { Folder } from "@workspace/api-client-react"

export function FolderGrid({ folders, onNavigate, onRename, onMove, onDelete, canUpdate }: {
  folders: Folder[];
  onNavigate: (id: string) => void;
  onRename: (folder: Folder) => void;
  onMove: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
  canUpdate: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" role="list" aria-label="Folders">
      {folders.map(folder => (
        <div
          key={folder.id}
          className="group flex items-stretch border rounded-lg bg-card hover:border-primary/50 hover:shadow-sm transition-all overflow-hidden"
          role="listitem"
        >
          <button
            type="button"
            onClick={() => onNavigate(folder.id)}
            className="flex-1 flex items-center gap-3 p-3 min-w-0 text-left cursor-pointer focus:outline-none focus:bg-muted"
            aria-label={`Open folder ${folder.name}`}
          >
            <div className="h-10 w-10 rounded bg-blue-500/10 flex items-center justify-center shrink-0">
              <FolderIcon className="h-5 w-5 text-blue-500" fill="currentColor" fillOpacity={0.2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm truncate text-foreground">{folder.name}</div>
              <div className="text-xs text-muted-foreground">{folder.childFolderCount} folders, {folder.videoCount} videos</div>
            </div>
          </button>
          {canUpdate && (
            <div className="flex items-center pr-3 shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity text-muted-foreground hover:text-foreground" aria-label={`Folder options for ${folder.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onRename(folder)}>
                    <Pencil className="h-4 w-4 mr-2" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onMove(folder)}>
                    <FolderInput className="h-4 w-4 mr-2" /> Move
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                    onClick={() => onDelete(folder)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
