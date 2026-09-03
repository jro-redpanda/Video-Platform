import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getListMembersQueryKey,
  getListPermissionGroupsQueryKey,
  getGetWorkspaceQueryKey,
  useCreateInvitation,
  useGetWorkspace,
  useListMembers,
  useListPermissionGroups,
  type PermissionGroup,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { UserPlus } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { MembersTable } from "./members/members-table"
import { GroupsTable } from "./members/groups-table"
import { apiErrorStatus } from "@/lib/api-error"

export default function Members() {
  const workspaceQuery = useGetWorkspace()
  const canManageMembers = workspaceQuery.data?.permissions.includes("members.manage") ?? false
  const membersQuery = useListMembers({
    query: { queryKey: getListMembersQueryKey(), enabled: canManageMembers },
  })
  const groupsQuery = useListPermissionGroups({
    query: { queryKey: getListPermissionGroupsQueryKey(), enabled: canManageMembers },
  })

  const members = membersQuery.data ?? []
  const groups = groupsQuery.data ?? []

  if (workspaceQuery.isLoading) {
    return <div className="flex-1 grid place-items-center text-muted-foreground" role="status">Loading access…</div>
  }

  if (workspaceQuery.isError) {
    return <div className="flex-1 grid place-items-center text-destructive" role="alert">Workspace access could not be loaded.</div>
  }

  if (!canManageMembers) {
    return (
      <div className="flex-1 grid place-items-center p-8">
        <div className="max-w-md text-center space-y-2" role="alert">
          <h1 className="text-2xl font-semibold">Member administration is restricted</h1>
          <p className="text-muted-foreground">You do not have permission to manage members or permission groups in this workspace.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Members</h1>
          <p className="text-muted-foreground mt-1">Manage team access and roles for this workspace.</p>
        </div>
        <InviteDialog groups={groups} />
      </div>

      <Tabs defaultValue="members" className="w-full">
        <TabsList className="mb-6">
          <TabsTrigger value="members">Members & Invitations</TabsTrigger>
          <TabsTrigger value="groups">Permission Groups</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="outline-none">
          <MembersTable
            members={members}
            groups={groups}
            isLoading={membersQuery.isLoading || groupsQuery.isLoading}
            isError={membersQuery.isError || groupsQuery.isError}
          />
        </TabsContent>

        <TabsContent value="groups" className="outline-none">
          <GroupsTable
            groups={groups}
            isLoading={groupsQuery.isLoading}
            isError={groupsQuery.isError}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function InviteDialog({ groups }: { groups: PermissionGroup[] }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [groupId, setGroupId] = useState("")
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invitation = useCreateInvitation({
    mutation: {
      onSuccess: (created) => {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() }),
        ])
        toast({ title: "Invitation created", description: `Invited ${created.email} as ${created.role}.` })
        setOpen(false)
        setEmail("")
        setGroupId("")
      },
      onError: (error) => {
        const status = apiErrorStatus(error)
        const desc = status === 503 ? "Invitation delivery is not configured or is temporarily unavailable."
                   : status === 409 ? "This invitation cannot be created. The person may already be a member, have a pending invitation, or the workspace member limit may be reached."
                   : status === 403 ? "You do not have permission to invite members."
                   : "Check the address and permission group, then try again."
        toast({ title: "Invitation failed", description: desc, variant: "destructive" })
      },
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !groupId) return
    invitation.mutate({ data: { email, groupId } })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid="button-invite">
          <UserPlus className="h-4 w-4" /> Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Invite Team Member</DialogTitle>
          </DialogHeader>
          <div className="py-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="colleague@example.com"
                autoFocus
                data-testid="input-invite-email"
              />
            </div>
            <div className="space-y-2">
              <Label>Permission group</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger data-testid="select-invite-group">
                  <SelectValue placeholder="Choose a group" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!email || !groupId || invitation.isPending} data-testid="button-send-invite">
              {invitation.isPending ? "Creating…" : "Create invitation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
