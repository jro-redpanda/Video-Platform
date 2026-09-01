import { useState } from "react"
import { useListFolders, useGetFolder, getListFoldersQueryKey, getGetFolderQueryKey } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Home, ChevronRight, Check, Folder as FolderIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface FolderBrowserProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  excludeFolderId?: string;
}

export function FolderBrowser({ selectedId, onSelect, excludeFolderId }: FolderBrowserProps) {
  const [viewId, setViewId] = useState<string>("root")

  const { data: childFolders, isLoading } = useListFolders({ parentId: viewId }, {
    query: { queryKey: getListFoldersQueryKey({ parentId: viewId }) }
  })

  const { data: viewFolder } = useGetFolder(viewId, {
    query: {
      enabled: viewId !== "root",
      queryKey: getGetFolderQueryKey(viewId)
    }
  })

  return (
    <div className="border rounded-md flex flex-col h-[300px] overflow-hidden bg-background">
      <div className="flex items-center gap-1 p-2 border-b bg-muted/30 overflow-x-auto whitespace-nowrap scrollbar-hide text-sm">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 font-medium shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setViewId("root")}
        >
          <Home className="h-4 w-4 mr-1" /> Root
        </Button>
        {viewFolder?.ancestors.map(anc => (
          <div key={anc.id} className="flex items-center shrink-0">
            <ChevronRight className="h-4 w-4 text-muted-foreground mx-0.5" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setViewId(anc.id)}
            >
              {anc.name}
            </Button>
          </div>
        ))}
        {viewFolder && (
          <div className="flex items-center shrink-0">
            <ChevronRight className="h-4 w-4 text-muted-foreground mx-0.5" />
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 font-medium bg-muted text-foreground pointer-events-none" disabled>
              {viewFolder.name}
            </Button>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1" role="list">
          {viewId === "root" && (
            <button
              type="button"
              className={cn(
                "w-full flex items-center justify-between p-2 rounded-md hover:bg-muted/50 transition-colors group border border-transparent cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring",
                selectedId === null && "bg-primary/5 border-primary/20 text-primary"
              )}
              onClick={() => onSelect(null)}
              role="listitem"
              aria-label="Select Root Directory"
            >
              <div className="flex items-center gap-2">
                <Home className="h-4 w-4 text-primary" />
                <span className="font-medium text-sm">Root Directory</span>
              </div>
              {selectedId === null && <Check className="h-4 w-4 text-primary" />}
            </button>
          )}

          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 p-2">
                <Skeleton className="h-4 w-4 rounded-sm" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))
          ) : (
            childFolders?.map(folder => {
              if (folder.id === excludeFolderId) return null;
              const isSelected = selectedId === folder.id;
              return (
                <div
                  key={folder.id}
                  className={cn(
                    "flex items-center justify-between p-1 rounded-md hover:bg-muted/50 transition-colors group border border-transparent",
                    isSelected && "bg-primary/5 border-primary/20 text-primary"
                  )}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="flex-1 flex items-center gap-2 min-w-0 p-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring rounded-sm text-left"
                    onClick={() => onSelect(folder.id)}
                    aria-label={`Select folder ${folder.name}`}
                  >
                    <FolderIcon className="h-4 w-4 text-blue-500 shrink-0" fill="currentColor" fillOpacity={0.2} />
                    <span className="font-medium text-sm truncate text-foreground">{folder.name}</span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0 px-1">
                    {isSelected && <Check className="h-4 w-4 text-primary" />}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity focus:opacity-100"
                      onClick={() => setViewId(folder.id)}
                      title="Open folder"
                      aria-label={`Open folder ${folder.name}`}
                    >
                      <ChevronRight className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}

          {!isLoading && childFolders?.length === 0 && viewId !== "root" && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              This folder is empty.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
