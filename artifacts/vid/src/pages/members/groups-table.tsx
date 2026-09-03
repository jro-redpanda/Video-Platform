import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getListPermissionGroupsQueryKey,
  getGetWorkspaceQueryKey,
  getListMembersQueryKey,
  useCreatePermissionGroup,
  useUpdatePermissionGroup,
  useDeletePermissionGroup,
  useListPermissions,
  type PermissionGroup,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Shield, MoreHorizontal, Edit, Trash2, Info, Plus } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { apiErrorStatus } from "@/lib/api-error"

export function GroupsTable({ groups, isLoading, isError }: { groups: PermissionGroup[], isLoading: boolean, isError: boolean }) {
  const [editingGroup, setEditingGroup] = useState<PermissionGroup | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<PermissionGroup | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const permissionsQuery = useListPermissions()
  const permissions = permissionsQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setIsCreateOpen(true)} className="gap-2" data-testid="button-create-group">
          <Plus className="h-4 w-4" /> Create Group
        </Button>
      </div>

      <div className="border rounded-lg bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading || permissionsQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  Loading groups…
                </TableCell>
              </TableRow>
            ) : isError || permissionsQuery.isError ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-destructive">
                  Groups could not be loaded.
                </TableCell>
              </TableRow>
            ) : groups.length ? groups.map((group) => (
              <TableRow key={group.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{group.name}</span>
                    {group.systemKey && <Badge variant="secondary" className="ml-2 text-[10px] uppercase tracking-wider">System</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{group.description}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {group.permissions.length === 0 ? (
                      <span className="text-muted-foreground text-sm">None</span>
                    ) : group.permissions.length > 3 ? (
                      <>
                        <Badge variant="outline" className="text-xs font-normal">{group.permissions[0]}</Badge>
                        <Badge variant="outline" className="text-xs font-normal">{group.permissions[1]}</Badge>
                        <Badge variant="outline" className="text-xs font-normal">+{group.permissions.length - 2} more</Badge>
                      </>
                    ) : (
                      group.permissions.map(p => (
                        <Badge key={p} variant="outline" className="text-xs font-normal">{p}</Badge>
                      ))
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" data-testid={`button-group-actions-${group.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingGroup(group)} className="gap-2 cursor-pointer">
                        <Edit className="h-4 w-4" /> Edit Group
                      </DropdownMenuItem>
                      {!group.systemKey && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => setDeletingGroup(group)} className="gap-2 cursor-pointer text-destructive focus:text-destructive">
                            <Trash2 className="h-4 w-4" /> Delete Group
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  No permission groups found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <GroupDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        permissions={permissions}
      />
      <GroupDialog
        open={!!editingGroup}
        onOpenChange={(v) => !v && setEditingGroup(null)}
        group={editingGroup}
        permissions={permissions}
      />
      <DeleteGroupDialog
        group={deletingGroup}
        onOpenChange={(v) => !v && setDeletingGroup(null)}
      />
    </div>
  )
}

function GroupDialog({ open, onOpenChange, group, permissions }: { open: boolean, onOpenChange: (open: boolean) => void, group?: PermissionGroup | null, permissions: {key: string, description: string}[] }) {
  const isEditing = !!group
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set())
  const { toast } = useToast()
  const queryClient = useQueryClient()

  // Reset state on open
  useEffect(() => {
    if (open) {
      setName(group?.name || "")
      setDescription(group?.description || "")
      setSelectedPerms(new Set(group?.permissions || []))
    }
  }, [open, group])

  const createGroup = useCreatePermissionGroup({
    mutation: {
      onSuccess: () => {
        toast({ title: "Group created" })
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListPermissionGroupsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() }),
        ])
        onOpenChange(false)
      },
      onError: (error) => {
        const status = apiErrorStatus(error)
        const description = status === 409 ? "A group with this name already exists."
          : status === 403 ? "You do not have permission to create groups."
          : "The group could not be created."
        toast({ title: "Failed to create group", description, variant: "destructive" })
      }
    }
  })

  const updateGroup = useUpdatePermissionGroup({
    mutation: {
      onSuccess: () => {
        toast({ title: "Group updated" })
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListPermissionGroupsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() }),
        ])
        onOpenChange(false)
      },
      onError: (error) => {
        const status = apiErrorStatus(error)
        const description = status === 409 ? "This change would remove the workspace's final member administrator, or the group name is already in use."
          : status === 403 ? "You do not have permission to update groups."
          : "The group could not be updated."
        toast({ title: "Failed to update group", description, variant: "destructive" })
      }
    }
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    const data = { name, description, permissions: Array.from(selectedPerms) }
    if (isEditing) {
      updateGroup.mutate({ groupId: group.id, data })
    } else {
      createGroup.mutate({ data })
    }
  }

  const isPending = createGroup.isPending || updateGroup.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <DialogHeader className="shrink-0">
            <DialogTitle>{isEditing ? "Edit Permission Group" : "Create Permission Group"}</DialogTitle>
          </DialogHeader>
          <div className="py-6 space-y-6 overflow-y-auto pr-2">
            {group?.systemKey && (
              <div className="flex items-start gap-3 p-3 rounded-md bg-secondary text-secondary-foreground text-sm">
                <Info className="h-5 w-5 shrink-0 mt-0.5" />
                <p>This is a system group. Its name and core capabilities are managed by the platform, but you can adjust permissions.</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Content Editors"
                  disabled={!!group?.systemKey}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What can members of this group do?"
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <Label>Permissions</Label>
                <div className="text-xs text-muted-foreground">{selectedPerms.size} selected</div>
              </div>
              <div className="border rounded-md divide-y">
                {permissions.map((p) => {
                  const id = `perm-${p.key}`
                  const checked = selectedPerms.has(p.key)
                  return (
                    <div key={p.key} className="flex items-center space-x-3 p-3 hover:bg-muted/50 transition-colors">
                      <Checkbox 
                        id={id} 
                        checked={checked}
                        onCheckedChange={(c) => {
                          const next = new Set(selectedPerms)
                          if (c) next.add(p.key)
                          else next.delete(p.key)
                          setSelectedPerms(next)
                        }}
                      />
                      <div className="space-y-1 leading-none">
                        <label htmlFor={id} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">
                          {p.key}
                        </label>
                        <p className="text-xs text-muted-foreground">
                          {p.description}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || isPending} data-testid="button-save-group">
              {isPending ? "Saving…" : "Save Group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteGroupDialog({ group, onOpenChange }: { group: PermissionGroup | null, onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const deleteGroup = useDeletePermissionGroup({
    mutation: {
      onSuccess: () => {
        toast({ title: "Group deleted" })
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListPermissionGroupsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() }),
        ])
        onOpenChange(false)
      },
      onError: (error) => {
        const status = apiErrorStatus(error);
        const msg = status === 409 ? "This group is currently assigned to members and cannot be deleted." 
                  : status === 403 ? "You do not have permission to delete groups."
                  : "The group could not be deleted.";
        toast({ title: "Failed to delete group", description: msg, variant: "destructive" })
      }
    }
  })

  return (
    <Dialog open={!!group} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Permission Group</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the group <strong>{group?.name}</strong>? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button 
            type="button" 
            variant="destructive" 
            onClick={() => group && deleteGroup.mutate({ groupId: group.id })}
            disabled={deleteGroup.isPending}
            data-testid="button-confirm-delete-group"
          >
            {deleteGroup.isPending ? "Deleting…" : "Delete Group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
