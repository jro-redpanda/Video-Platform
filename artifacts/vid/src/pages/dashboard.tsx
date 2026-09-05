import { useGetDashboard, useListActivity } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber, formatDuration } from "@/lib/utils"
import { PlayCircle, Clock, CheckCircle2, TrendingUp, Activity, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getHttpStatus } from "@/lib/frontend-safety"

export default function Dashboard() {
  const dashboardQuery = useGetDashboard()
  const activityQuery = useListActivity()
  const {
    data: dashboard,
    isLoading: isLoadingDash,
    isError: isDashboardError,
    isFetching: isDashboardFetching,
    refetch: refetchDashboard,
  } = dashboardQuery
  const {
    data: activity,
    error: activityError,
    isLoading: isLoadingActivity,
    isError: isActivityError,
    isFetching: isActivityFetching,
    refetch: refetchActivity,
  } = activityQuery
  const activityDenied = getHttpStatus(activityError) === 403

  return (
    <div className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">Metrics and recent activity across your workspaces.</p>
        </div>
      </div>

      {isDashboardError ? (
        <QueryError
          message="Dashboard metrics could not be loaded."
          isRetrying={isDashboardFetching}
          onRetry={() => void refetchDashboard()}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
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
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top Performing Content</CardTitle>
            <CardDescription>Videos with the highest engagement.</CardDescription>
          </CardHeader>
          <CardContent>
            {isDashboardError ? (
              <div className="py-8 text-center text-muted-foreground">Top content is unavailable.</div>
            ) : isLoadingDash ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : dashboard?.topVideos.length ? (
              <div className="space-y-4">
                {dashboard.topVideos.map((video) => (
                  <div key={video.id} className="flex flex-col gap-2 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors sm:flex-row sm:items-center sm:justify-between">
                    <div className="font-medium truncate sm:pr-4">{video.title}</div>
                    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground sm:justify-end sm:flex-shrink-0">
                      <div>{formatNumber(video.plays)} plays</div>
                      <div>{video.completionRate}%</div>
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
            ) : isActivityError ? (
              <div className="py-8 text-center">
                <p className="text-muted-foreground">Recent activity could not be loaded.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void refetchActivity()}
                  disabled={isActivityFetching}
                  data-testid="button-retry-activity"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {isActivityFetching ? "Retrying…" : "Try again"}
                </Button>
              </div>
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

function QueryError({
  message,
  isRetrying,
  onRetry,
}: {
  message: string
  isRetrying: boolean
  onRetry: () => void
}) {
  return (
    <Card className="mb-8 border-destructive/30">
      <CardContent className="py-8 text-center">
        <p className="text-destructive font-medium">{message}</p>
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          onClick={onRetry}
          disabled={isRetrying}
          data-testid="button-retry-dashboard"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {isRetrying ? "Retrying…" : "Try again"}
        </Button>
      </CardContent>
    </Card>
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
