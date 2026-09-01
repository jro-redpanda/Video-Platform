import { useState, useEffect } from "react"
import { useGetWorkspace, useUpdateWorkspace, getGetWorkspaceQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Server, Shield, CreditCard } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

export default function Settings() {
  const { data: workspace, isLoading } = useGetWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [name, setName] = useState("")

  useEffect(() => {
    if (workspace) {
      setName(workspace.name)
    }
  }, [workspace])

  const handleSave = () => {
    updateWorkspace.mutate({ data: { name } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetWorkspaceQueryKey(), data)
        toast({ title: "Settings saved", description: "Workspace name updated successfully." })
      }
    })
  }

  if (isLoading) {
    return <div className="p-8 space-y-4"><Skeleton className="h-12 w-1/3" /><Skeleton className="h-64 w-full max-w-3xl" /></div>
  }

  if (!workspace) return null

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-8">
        
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">Manage your workspace configuration and billing.</p>
        </div>

        <div className="grid gap-8">
          
          <Card>
            <CardHeader>
              <CardTitle>Workspace Identity</CardTitle>
              <CardDescription>The display name and URL slug for your workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Workspace Name</Label>
                <Input 
                  id="name" 
                  value={name} 
                  onChange={e => setName(e.target.value)} 
                  className="max-w-md"
                />
              </div>
              <div className="space-y-2">
                <Label>Workspace Slug</Label>
                <div className="flex items-center gap-2 max-w-md">
                  <div className="bg-muted px-3 py-2 text-sm rounded-l-md border border-r-0 text-muted-foreground whitespace-nowrap">
                    app.video-platform.com/
                  </div>
                  <Input 
                    value={workspace.slug} 
                    disabled
                    className="rounded-l-none bg-muted/50"
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">The slug cannot be changed after creation.</p>
              </div>
            </CardContent>
            <CardFooter className="border-t px-6 py-4">
              <Button onClick={handleSave} disabled={updateWorkspace.isPending || !name || name === workspace.name}>
                {updateWorkspace.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </CardFooter>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-primary" /> Storage Usage
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-3xl font-bold">{workspace.storageUsedGb} <span className="text-lg text-muted-foreground font-normal">GB</span></div>
                    <div className="text-sm text-muted-foreground mt-1">used of {workspace.storageLimitGb} GB limit</div>
                  </div>
                  <Badge variant={workspace.storageUsedGb / workspace.storageLimitGb > 0.8 ? "warning" : "secondary"}>
                    {Math.round((workspace.storageUsedGb / workspace.storageLimitGb) * 100)}%
                  </Badge>
                </div>
                
                <div className="h-3 w-full bg-secondary rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all ${workspace.storageUsedGb / workspace.storageLimitGb > 0.9 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, (workspace.storageUsedGb / workspace.storageLimitGb) * 100)}%` }}
                  />
                </div>
              </CardContent>
              <CardFooter className="border-t px-6 py-4 bg-muted/20">
                <Button variant="outline" className="w-full">Upgrade Storage</Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5 text-primary" /> Current Plan
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 border rounded-lg bg-primary/5 border-primary/20">
                  <div>
                    <div className="font-semibold text-lg capitalize">{workspace.plan} Plan</div>
                    <div className="text-sm text-muted-foreground">Billed monthly</div>
                  </div>
                  <Badge variant="default">Active</Badge>
                </div>
                <ul className="text-sm space-y-2 text-muted-foreground">
                  <li className="flex items-center gap-2"><Shield className="h-4 w-4 text-emerald-500" /> Advanced privacy controls</li>
                  <li className="flex items-center gap-2"><Shield className="h-4 w-4 text-emerald-500" /> White-label player</li>
                  <li className="flex items-center gap-2"><Shield className="h-4 w-4 text-emerald-500" /> Up to {workspace.memberCount} team members</li>
                </ul>
              </CardContent>
              <CardFooter className="border-t px-6 py-4 bg-muted/20">
                <Button variant="secondary" className="w-full">Manage Billing</Button>
              </CardFooter>
            </Card>
          </div>
          
        </div>
      </div>
    </div>
  )
}
