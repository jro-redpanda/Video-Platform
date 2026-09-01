import { useState, useEffect } from "react"
import { useCreateFolder, useUpdateFolder, useDeleteFolder, getListFoldersQueryKey, getGetFolderQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { FolderBrowser } from "./folder-browser"
import type { Folder, FolderDetail } from "@workspace/api-client-react"

export function CreateFolderDialog({ open, onOpenChange, parentId, onSuccess }: { open: boolean, onOpenChange: (o: boolean) => void, parentId: string, onSuccess?: () => void }) {
  const [name, setName] = useState("")
  const createFolder = useCreateFolder()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  useEffect(() => { if (!open) setName("") }, [open])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createFolder.mutate({ data: { name: name.trim(), parentId: parentId === "root" ? null : parentId } }, {
      onSuccess: () => {
        toast({ title: "Folder created" })
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() })
        onSuccess?.()
        onOpenChange(false)
      },
      onError: (err: any) => {
        toast({ title: "Failed to create folder", description: err.message, variant: "destructive" })
      }
    })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader><DialogTitle>Create Folder</DialogTitle></DialogHeader>
          <div className="py-4 space-y-2">
            <Label htmlFor="folder-name">Name</Label>
            <Input id="folder-name" value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. Project Assets" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || createFolder.isPending}>
              {createFolder.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RenameFolderDialog({ folder, open, onOpenChange, onSuccess }: { folder: Folder | FolderDetail | null, open: boolean, onOpenChange: (o: boolean) => void, onSuccess?: () => void }) {
  const [name, setName] = useState("")
  const updateFolder = useUpdateFolder()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  useEffect(() => { if (open && folder) setName(folder.name) }, [open, folder])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !folder) return
    updateFolder.mutate({ folderId: folder.id, data: { name: name.trim() } }, {
      onSuccess: () => {
        toast({ title: "Folder renamed" })
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() })
        // Invalidate getFolder for this specifically, too
        queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(folder.id) })
        onSuccess?.()
        onOpenChange(false)
      },
      onError: (err: any) => {
        toast({ title: "Failed to rename folder", description: err.message, variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader><DialogTitle>Rename Folder</DialogTitle></DialogHeader>
          <div className="py-4 space-y-2">
            <Label htmlFor="rename-name">Name</Label>
            <Input id="rename-name" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || name === folder?.name || updateFolder.isPending}>
              {updateFolder.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteFolderDialog({ folder, open, onOpenChange, onSuccess }: { folder: Folder | FolderDetail | null, open: boolean, onOpenChange: (o: boolean) => void, onSuccess?: () => void }) {
  const deleteFolder = useDeleteFolder()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => { if (open) setErrorMsg(null) }, [open])

  const handleDelete = () => {
    if (!folder) return
    setErrorMsg(null)
    deleteFolder.mutate({ folderId: folder.id }, {
      onSuccess: () => {
        toast({ title: "Folder deleted" })
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() })
        onSuccess?.()
        onOpenChange(false)
      },
      onError: (err: any) => {
        if (err.status === 409) {
          setErrorMsg("Folder is not empty. Please move or delete its contents first.")
        } else {
          setErrorMsg(err.message || "Failed to delete folder.")
        }
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Folder</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{folder?.name}</strong>? This action cannot be undone.
            Only empty folders can be deleted.
          </DialogDescription>
        </DialogHeader>
        {errorMsg && (
          <div className="p-3 text-sm rounded-md bg-destructive/10 text-destructive border border-destructive/20 mt-2">
            {errorMsg}
          </div>
        )}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteFolder.isPending}>
            {deleteFolder.isPending ? "Deleting..." : "Delete Folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MoveFolderDialog({ folder, open, onOpenChange, onSuccess }: { folder: Folder | FolderDetail | null, open: boolean, onOpenChange: (o: boolean) => void, onSuccess?: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const updateFolder = useUpdateFolder()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (open && folder) {
      setSelectedId(folder.parentId)
    }
  }, [open, folder])

  const handleMove = () => {
    if (!folder) return
    updateFolder.mutate({ folderId: folder.id, data: { parentId: selectedId } }, {
      onSuccess: () => {
        toast({ title: "Folder moved successfully" })
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() })
        queryClient.invalidateQueries({
          predicate: ({ queryKey }) => (
            typeof queryKey[0] === "string"
            && queryKey[0].startsWith("/api/folders/")
          )
        })
        onSuccess?.()
        onOpenChange(false)
      },
      onError: (err: any) => {
        toast({ title: "Failed to move folder", description: err.message, variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Move Folder</DialogTitle></DialogHeader>
        <div className="py-4">
          {folder && (
            <FolderBrowser
              selectedId={selectedId}
              onSelect={setSelectedId}
              excludeFolderId={folder.id}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleMove} disabled={selectedId === folder?.parentId || updateFolder.isPending}>
            {updateFolder.isPending ? "Moving..." : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
