import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getListMembersQueryKey,
  useCreateInvitation,
  useListMembers,
  useListPermissionGroups,
  type PermissionGroup,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { UserPlus, MoreHorizontal, Search } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

export default function Members() {
  const [search, setSearch] = useState("")
  const membersQuery = useListMembers()
  const groupsQuery = useListPermissionGroups()
  const members = membersQuery.data ?? []
  
  const filtered = members.filter(m => 
    m.name.toLowerCase().includes(search.toLowerCase()) || 
    m.email.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Members</h1>
          <p className="text-muted-foreground mt-1">Manage team access and roles for this workspace.</p>
        </div>
        <InviteDialog groups={groupsQuery.data ?? []} />
      </div>

      <div className="flex items-center gap-4 mb-6">
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

      <div className="border rounded-lg bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {membersQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  Loading members…
                </TableCell>
              </TableRow>
            ) : membersQuery.isError ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-destructive">
                  Members could not be loaded.
                </TableCell>
              </TableRow>
            ) : filtered.length ? filtered.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarFallback className="bg-primary/10 text-primary">
                        {member.name.split(' ').map(n => n[0]).join('')}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium">{member.name}</div>
                      <div className="text-sm text-muted-foreground">{member.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{member.role}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={member.status === 'active' ? 'success' : 'secondary'}>
                    {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
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

function InviteDialog({ groups }: { groups: PermissionGroup[] }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [groupId, setGroupId] = useState("")
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invitation = useCreateInvitation({
    mutation: {
      onSuccess: (created) => {
        void queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() })
        toast({ title: "Invitation created", description: `Invited ${created.email} as ${created.role}.` })
        setOpen(false)
        setEmail("")
        setGroupId("")
      },
      onError: () => {
        toast({ title: "Invitation failed", description: "Check the address and permission group, then try again.", variant: "destructive" })
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
        <Button className="gap-2">
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
              />
            </div>
            <div className="space-y-2">
              <Label>Permission group</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger>
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
            <Button type="submit" disabled={!email || !groupId || invitation.isPending}>
              {invitation.isPending ? "Creating…" : "Create invitation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
