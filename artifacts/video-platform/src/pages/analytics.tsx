import { useGetDashboard } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { formatNumber } from "@/lib/utils"
import { PlayCircle, Clock } from "lucide-react"

export default function Analytics() {
  const { data: dashboard, isLoading } = useGetDashboard()

  const formatShortDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="flex-1 p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground mt-1">Deep dive into your video performance.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Plays over Time (30 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : dashboard?.playsTrend?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dashboard.playsTrend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorPlays" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={formatShortDate} 
                      tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                      tickLine={false}
                      axisLine={false}
                      dy={10}
                    />
                    <YAxis 
                      tickFormatter={(val) => formatNumber(val)}
                      tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                      tickLine={false}
                      axisLine={false}
                      dx={-10}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                      labelFormatter={formatShortDate}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="plays" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={2}
                      fillOpacity={1} 
                      fill="url(#colorPlays)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                  No trend data available.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top Engagement</CardTitle>
            <CardDescription>Highest completion rates</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : dashboard?.topVideos?.length ? (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboard.topVideos.slice(0, 5)} layout="vertical" margin={{ top: 0, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" domain={[0, 100]} hide />
                    <YAxis dataKey="title" type="category" hide />
                    <Tooltip 
                      cursor={{fill: 'hsl(var(--muted))'}}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      formatter={(val: number) => [`${val}%`, 'Completion']}
                    />
                    <Bar dataKey="completionRate" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]}>
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
               <div className="h-[300px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg">
                  No top engagement data.
                </div>
            )}
          </CardContent>
        </Card>
      </div>
      
      <h2 className="text-xl font-semibold mb-4 mt-12">Performance by Video</h2>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-4 font-medium">Video Title</th>
                <th className="p-4 font-medium text-right">Total Plays</th>
                <th className="p-4 font-medium text-right">Avg Completion</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td className="p-4"><Skeleton className="h-6 w-full" /></td>
                  <td className="p-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                  <td className="p-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                </tr>
              ) : dashboard?.topVideos?.length ? (
                dashboard.topVideos.map(video => (
                  <tr key={video.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                    <td className="p-4 font-medium">{video.title}</td>
                    <td className="p-4 text-right font-mono">{formatNumber(video.plays)}</td>
                    <td className="p-4 text-right font-mono">{video.completionRate}%</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="p-8 text-center text-muted-foreground">
                    No videos available to analyze.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
