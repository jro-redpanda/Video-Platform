import { useGetDashboard, useListActivity } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber, formatDuration } from "@/lib/utils"
import { PlayCircle, Clock, CheckCircle2, TrendingUp, Activity } from "lucide-react"

export default function Dashboard() {
  const { data: dashboard, isLoading: isLoadingDash } = useGetDashboard()
  const { data: activity, isLoading: isLoadingActivity, isError: activityDenied } = useListActivity()

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">Metrics and recent activity across your workspaces.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <MetricCard
          title="Total Videos"
          value={dashboard?.totalVideos}
          isLoading={isLoadingDash}
          icon={PlayCircle}
        />
        <MetricCard
          title="Total Plays"
          value={dashboard?.totalPlays}
          formatter={formatNumber}
          isLoading={isLoadingDash}
          icon={TrendingUp}
        />
        <MetricCard
          title="Watch Time"
          value={dashboard?.watchTimeHours}
          suffix=" hrs"
          formatter={formatNumber}
          isLoading={isLoadingDash}
          icon={Clock}
        />
        <MetricCard
          title="Avg Completion"
          value={dashboard?.completionRate}
          suffix="%"
          isLoading={isLoadingDash}
          icon={CheckCircle2}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top Performing Content</CardTitle>
            <CardDescription>Videos with the highest engagement.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDash ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : dashboard?.topVideos.length ? (
              <div className="space-y-4">
                {dashboard.topVideos.map((video) => (
                  <div key={video.id} className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
                    <div className="font-medium truncate pr-4">{video.title}</div>
                    <div className="flex items-center gap-6 text-sm text-muted-foreground flex-shrink-0">
                      <div className="w-20 text-right">{formatNumber(video.plays)} plays</div>
                      <div className="w-16 text-right">{video.completionRate}%</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">No video data yet.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" /> Activity Feed
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingActivity ? (
               <div className="space-y-4">
                 {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
               </div>
            ) : activityDenied ? (
              <div className="py-8 text-center text-muted-foreground">Activity is not available for your role.</div>
            ) : activity?.length ? (
              <div className="space-y-5 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-px before:bg-border">
                {activity.map((item) => (
                  <div key={item.id} className="relative flex items-start gap-3">
                    <div className="flex items-center justify-center w-5 h-5 rounded-full border border-background bg-primary/20 text-primary shrink-0 z-10 mt-0.5">
                      <div className="w-1.5 h-1.5 bg-primary rounded-full"></div>
                    </div>
                    <div className="min-w-0 flex-1 pb-1">
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-sm font-semibold capitalize text-primary">{item.action}</span>
                        <time className="text-[11px] text-muted-foreground font-mono shrink-0">{new Date(item.createdAt).toLocaleDateString()}</time>
                      </div>
                      <div className="text-sm leading-5 text-muted-foreground mt-0.5">
                        <span className="font-medium">{item.actor}</span> {item.action} <span className="font-medium">{item.subject}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">No recent activity.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function MetricCard({
  title,
  value,
  isLoading,
  icon: Icon,
  formatter = (v: any) => v,
  suffix = ""
}: {
  title: string;
  value?: number;
  isLoading: boolean;
  icon: React.ElementType;
  formatter?: (val: number) => string;
  suffix?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="text-3xl font-bold tracking-tight">
            {value !== undefined ? formatter(value) : '0'}{suffix}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
