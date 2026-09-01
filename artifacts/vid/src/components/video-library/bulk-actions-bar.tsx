import { Button } from "@/components/ui/button"
import { FolderInput, Eye, Trash2, X } from "lucide-react"

interface BulkActionsBarProps {
  selectedCount: number;
  onClear: () => void;
  onMove: () => void;
  onVisibility: () => void;
  onDelete: () => void;
  canUpdate: boolean;
  canDelete: boolean;
}

export function BulkActionsBar({
  selectedCount,
  onClear,
  onMove,
  onVisibility,
  onDelete,
  canUpdate,
  canDelete
}: BulkActionsBarProps) {
  if (selectedCount === 0) return null;

  const maxUpdate = 50;
  const maxDelete = 25;

  const canMoveCurrent = canUpdate && selectedCount <= maxUpdate;
  const canVisibilityCurrent = canUpdate && selectedCount <= maxUpdate;
  const canDeleteCurrent = canDelete && selectedCount <= maxDelete;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10 fade-in shadow-lg border bg-card text-card-foreground rounded-full px-4 py-3 flex items-center gap-4">
      <div className="flex items-center gap-2 pr-4 border-r border-border">
        <span className="text-sm font-semibold bg-primary/10 text-primary px-2 py-0.5 rounded-full">
          {selectedCount}
        </span>
        <span className="text-sm font-medium">selected</span>
        <Button variant="ghost" size="icon" className="h-6 w-6 ml-1 rounded-full text-muted-foreground hover:text-foreground" onClick={onClear} aria-label="Clear selection">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        {canUpdate && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onMove}
              disabled={!canMoveCurrent}
              title={selectedCount > maxUpdate ? `Max ${maxUpdate} allowed for move` : undefined}
              className="gap-2 rounded-full h-8"
            >
              <FolderInput className="h-4 w-4" />
              <span className="hidden sm:inline">Move</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onVisibility}
              disabled={!canVisibilityCurrent}
              title={selectedCount > maxUpdate ? `Max ${maxUpdate} allowed for visibility` : undefined}
              className="gap-2 rounded-full h-8"
            >
              <Eye className="h-4 w-4" />
              <span className="hidden sm:inline">Visibility</span>
            </Button>
          </>
        )}
        {canDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={!canDeleteCurrent}
            title={selectedCount > maxDelete ? `Max ${maxDelete} allowed for delete` : undefined}
            className="gap-2 rounded-full h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">Delete</span>
          </Button>
        )}
      </div>
    </div>
  )
}
