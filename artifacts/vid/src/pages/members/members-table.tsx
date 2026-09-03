import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getListMembersQueryKey,
  getGetWorkspaceQueryKey,
  useUpdateMember,
  useRevokeInvitation,
  useReissueInvitation,
  type Member,
  type PermissionGroup,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { MoreHorizontal, Search, Mail, RotateCw, Trash2, Ban, CheckCircle } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/components/ui/use-toast"
import { apiErrorStatus } from "@/lib/api-error"

export function MembersTable({ members, groups, isLoading, isError }: { members: Member[], groups: PermissionGroup[], isLoading: boolean, isError: boolean }) {
  const [search, setSearch] = useState("")

  const filtered = members.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.email.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search members..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="border rounded-lg bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Group / Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  Loading members…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-destructive">
                  Members could not be loaded.
                </TableCell>
              </TableRow>
            ) : filtered.length ? filtered.map((member) => (
              <MemberRow key={member.id} member={member} groups={groups} />
            )) : (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  No members found matching "{search}".
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function MemberRow({ member, groups }: { member: Member, groups: PermissionGroup[] }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  
  const updateMember = useUpdateMember({
    mutation: {
      onSuccess: () => {
        toast({ title: "Member updated" })
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceQueryKey() }),
        ])
      },
      onError: (error) => {
        const status = apiErrorStatus(error);
        const msg = status === 409 ? "Cannot modify the last active admin." : status === 403 ? "You do not have permission to do this." : "An error occurred.";
        toast({ title: "Failed to update member", description: msg, variant: "destructive" })
      }
    }
  })

  const revokeInv = useRevokeInvitation({
    mutation: {
      onSuccess: () => {
        toast({ title: "Invitation revoked" })
        void queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() })
      },
      onError: () => {
        toast({ title: "Failed to revoke", variant: "destructive" })
      }
    }
  })

  const reissueInv = useReissueInvitation({
    mutation: {
      onSuccess: () => {
        toast({ title: "Invitation reissued" })
        queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() })
      },
      onError: (error) => {
        const status = apiErrorStatus(error)
        const description = status === 503
          ? "Invitation delivery is not configured or is temporarily unavailable."
          : status === 409
            ? "This invitation can no longer be reissued."
            : "The invitation could not be reissued."
        toast({ title: "Failed to reissue", description, variant: "destructive" })
      }
    }
  })

  const handleStatusChange = (status: "active" | "suspended") => {
    updateMember.mutate({ membershipId: member.id, data: { status } })
  }

  const handleGroupChange = (groupId: string) => {
    updateMember.mutate({ membershipId: member.id, data: { groupId } })
  }

  const isPending = updateMember.isPending || revokeInv.isPending || reissueInv.isPending

  return (
    <TableRow className={isPending ? "opacity-50 pointer-events-none" : ""}>
      <TableCell>
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback className="bg-primary/10 text-primary">
              {member.name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase() || <Mail className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="font-medium">{member.name || "Pending user"}</div>
            <div className="text-sm text-muted-foreground">{member.email}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Select 
          value={member.groupId} 
          onValueChange={handleGroupChange}
          disabled={isPending || member.status === 'invited'}
        >
          <SelectTrigger className="w-[180px] h-8 bg-transparent border-transparent hover:border-input focus:border-input">
            <span className="sr-only">Change permission group for {member.email}</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map(g => (
              <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Badge 
          variant={member.status === 'active' ? 'default' : member.status === 'invited' ? 'secondary' : 'destructive'}
          className={member.status === 'active' ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400" : ""}
        >
          {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
        </Badge>
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" disabled={isPending} data-testid={`button-member-actions-${member.id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {member.status === 'invited' ? (
              <>
                <DropdownMenuItem onClick={() => reissueInv.mutate({ invitationId: member.id })} className="gap-2 cursor-pointer" data-testid={`button-reissue-invitation-${member.id}`}>
                  <RotateCw className="h-4 w-4" /> Reissue Invitation
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => revokeInv.mutate({ invitationId: member.id })} className="gap-2 cursor-pointer text-destructive focus:text-destructive" data-testid={`button-revoke-invitation-${member.id}`}>
                  <Trash2 className="h-4 w-4" /> Revoke Invitation
                </DropdownMenuItem>
              </>
            ) : (
              <>
                {member.status === 'suspended' ? (
                  <DropdownMenuItem onClick={() => handleStatusChange('active')} className="gap-2 cursor-pointer text-emerald-600 focus:text-emerald-600">
                    <CheckCircle className="h-4 w-4" /> Activate Member
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => handleStatusChange('suspended')} className="gap-2 cursor-pointer text-amber-600 focus:text-amber-600">
                    <Ban className="h-4 w-4" /> Suspend Member
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}
