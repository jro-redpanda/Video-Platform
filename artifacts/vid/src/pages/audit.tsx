import { useState, useEffect, useMemo, useRef } from "react"
import { useListAuditEvents, exportAuditEvents, getListAuditEventsQueryKey, type AuditEvent } from "@workspace/api-client-react"
import { format } from "date-fns"
import { 
  Search, 
  Download, 
  ChevronLeft, 
  ChevronRight, 
  Filter, 
  ShieldAlert,
  Activity,
  FileJson
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { toast } from "@/hooks/use-toast"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"

export default function AuditPage() {
  const [filters, setFilters] = useState({
    limit: 50,
    search: "",
    category: "all",
    actorKind: "all",
    action: "",
    subjectType: "",
    subjectId: "",
    actorUserId: "",
    from: "",
    to: ""
  });

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(timer);
  }, [filters.search]);

  const queryParams = useMemo(() => {
    const params: any = { limit: filters.limit };
    if (debouncedSearch) params.search = debouncedSearch;
    if (filters.category !== "all") params.category = filters.category;
    if (filters.actorKind !== "all") params.actorKind = filters.actorKind;
    if (filters.action) params.action = filters.action;
    if (filters.subjectType) params.subjectType = filters.subjectType;
    if (filters.subjectId) params.subjectId = filters.subjectId;
    if (filters.actorUserId) params.actorUserId = filters.actorUserId;
    if (filters.from) {
      try { params.from = new Date(filters.from).toISOString(); } catch(e){}
    }
    if (filters.to) {
      try { params.to = new Date(filters.to).toISOString(); } catch(e){}
    }
    return params;
  }, [filters, debouncedSearch]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.category !== "all") count++;
    if (filters.actorKind !== "all") count++;
    if (filters.action) count++;
    if (filters.subjectType) count++;
    if (filters.subjectId) count++;
    if (filters.actorUserId) count++;
    if (filters.from) count++;
    if (filters.to) count++;
    if (filters.search) count++;
    return count;
  }, [filters]);

  const handleClearFilters = () => {
    setDebouncedSearch("");
    setFilters({
      limit: filters.limit,
      search: "",
      category: "all",
      actorKind: "all",
      action: "",
      subjectType: "",
      subjectId: "",
      actorUserId: "",
      from: "",
      to: ""
    });
  };

  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [currentCursorIndex, setCurrentCursorIndex] = useState(0);
  const currentCursor = cursorHistory[currentCursorIndex];

  const prevQueryParams = useRef(queryParams);
  useEffect(() => {
    if (prevQueryParams.current !== queryParams) {
      setCursorHistory([]);
      setCurrentCursorIndex(0);
      prevQueryParams.current = queryParams;
    }
  }, [queryParams]);

  const activeParams = { ...queryParams, cursor: currentCursor || undefined };
  const { data, isLoading, error } = useListAuditEvents(activeParams, {
    query: {
      queryKey: getListAuditEventsQueryKey(activeParams),
      retry: false
    }
  });

  const [exporting, setExporting] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const exportParams = { ...queryParams };
      delete exportParams.limit;
      delete exportParams.cursor;
      const blob = await exportAuditEvents(exportParams);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-export-${new Date().toISOString()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export downloaded successfully" });
    } catch (err: any) {
      toast({ title: "Export failed", description: err?.message || "Could not download audit events.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const handleNext = () => {
    if (data?.nextCursor) {
      setCursorHistory(prev => {
        const next = [...prev];
        next[currentCursorIndex + 1] = data.nextCursor!;
        return next;
      });
      setCurrentCursorIndex(prev => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentCursorIndex > 0) {
      setCurrentCursorIndex(prev => prev - 1);
    }
  };

  const isDenied = (error as any)?.status === 403;

  if (isDenied) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-muted/20">
        <div className="max-w-md text-center space-y-4">
          <div className="w-12 h-12 bg-destructive/10 text-destructive rounded-full flex items-center justify-center mx-auto mb-6">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Access Restricted</h1>
          <p className="text-muted-foreground">
            You do not have permission to view the operational audit history. This area is restricted to workspace owners and administrators.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      <header className="px-6 py-5 border-b shrink-0 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            Audit Log
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Operational history and state changes.
          </p>
        </div>
        <Button 
          variant="outline" 
          onClick={handleExport} 
          disabled={exporting}
          className="gap-2"
        >
          <Download className="w-4 h-4" />
          {exporting ? "Exporting..." : "Export CSV"}
        </Button>
      </header>

      <div className="p-6 shrink-0 border-b bg-muted/10 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search action or subject label..." 
              value={filters.search}
              onChange={(e) => setFilters(f => ({ ...f, search: e.target.value }))}
              className="pl-9 bg-background"
            />
          </div>
          
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <Select value={filters.actorKind} onValueChange={(v) => setFilters(f => ({ ...f, actorKind: v }))}>
              <SelectTrigger className="w-[140px] bg-background shrink-0">
                <SelectValue placeholder="Actor Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Actor</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="webhook">Webhook</SelectItem>
                <SelectItem value="job">Job</SelectItem>
              </SelectContent>
            </Select>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2 bg-background shrink-0">
                  <Filter className="w-4 h-4" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge variant="secondary" className="px-1.5 py-0 h-5 text-xs font-mono ml-1">
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-0" align="end">
                <div className="px-4 py-3 border-b font-medium text-sm flex justify-between items-center bg-muted/30">
                  <span>Advanced Filters</span>
                  {activeFilterCount > 0 && (
                    <span className="text-xs text-muted-foreground">{activeFilterCount} active</span>
                  )}
                </div>
                <ScrollArea className="h-[400px]">
                  <div className="p-4 space-y-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Category</Label>
                      <Select value={filters.category} onValueChange={(v) => setFilters(f => ({ ...f, category: v }))}>
                        <SelectTrigger>
                          <SelectValue placeholder="Any Category" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Any</SelectItem>
                          <SelectItem value="workspace">Workspace</SelectItem>
                          <SelectItem value="content">Content</SelectItem>
                          <SelectItem value="members">Members</SelectItem>
                          <SelectItem value="provider">Provider</SelectItem>
                          <SelectItem value="embed">Embed</SelectItem>
                          <SelectItem value="billing">Billing</SelectItem>
                          <SelectItem value="operations">Operations</SelectItem>
                          <SelectItem value="legacy">Legacy</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="space-y-2">
                      <Label className="text-xs">Action (Exact)</Label>
                      <Input 
                        placeholder="e.g. create, update" 
                        value={filters.action}
                        onChange={(e) => setFilters(f => ({ ...f, action: e.target.value }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Subject Type</Label>
                      <Input 
                        placeholder="e.g. video, workspace" 
                        value={filters.subjectType}
                        onChange={(e) => setFilters(f => ({ ...f, subjectType: e.target.value }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Subject ID</Label>
                      <Input 
                        placeholder="UUID" 
                        value={filters.subjectId}
                        onChange={(e) => setFilters(f => ({ ...f, subjectId: e.target.value }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Actor User ID</Label>
                      <Input 
                        placeholder="UUID" 
                        value={filters.actorUserId}
                        onChange={(e) => setFilters(f => ({ ...f, actorUserId: e.target.value }))}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label className="text-xs">From Date</Label>
                        <Input 
                          type="datetime-local" 
                          value={filters.from}
                          onChange={(e) => setFilters(f => ({ ...f, from: e.target.value }))}
                          className="text-xs h-9 px-2"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">To Date</Label>
                        <Input 
                          type="datetime-local" 
                          value={filters.to}
                          onChange={(e) => setFilters(f => ({ ...f, to: e.target.value }))}
                          className="text-xs h-9 px-2"
                        />
                      </div>
                    </div>
                  </div>
                </ScrollArea>
                <div className="p-3 border-t bg-muted/30 flex justify-end">
                  <Button variant="outline" size="sm" onClick={handleClearFilters} disabled={activeFilterCount === 0}>
                    Clear All
                  </Button>
                </div>
              </PopoverContent>
            </Popover>

            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClearFilters} className="text-muted-foreground hover:text-foreground">
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && !data ? (
          <div className="p-6 space-y-4">
            {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : error ? (
          <div className="p-12 text-center text-destructive">Failed to load audit events.</div>
        ) : data?.items.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-muted-foreground h-full">
            <Activity className="w-12 h-12 mb-4 opacity-20" />
            <p className="text-lg font-medium">No events found</p>
            <p className="text-sm">Try adjusting your filters or search query.</p>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-muted/30 sticky top-0 z-10 shadow-sm">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[180px]">Timestamp</TableHead>
                <TableHead className="w-[180px]">Actor</TableHead>
                <TableHead className="w-[200px]">Action</TableHead>
                <TableHead>Subject</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map(event => (
                <TableRow 
                  key={event.id} 
                  className="cursor-pointer hover:bg-muted/30 group"
                  onClick={() => setSelectedEvent(event)}
                >
                  <TableCell className="font-mono text-[13px] text-muted-foreground whitespace-nowrap">
                    {format(new Date(event.createdAt), "MMM d, yyyy HH:mm:ss")}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-sm truncate">{event.actor.name}</span>
                      <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{event.actor.kind}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 items-start">
                      <Badge variant="secondary" className="font-mono text-[10px] rounded-sm capitalize bg-primary/10 text-primary border-0 hover:bg-primary/10">
                        {event.category}:{event.action}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-sm truncate">{event.subject.label}</span>
                      <span className="text-[11px] text-muted-foreground">{event.subject.type} {event.subject.id ? `(${event.subject.id.substring(0, 8)})` : ''}</span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <footer className="px-6 py-3 border-t bg-muted/10 shrink-0 flex flex-wrap items-center justify-between text-sm gap-4">
        <div className="flex items-center gap-4 text-muted-foreground">
          {data?.snapshotAt && (
            <span className="hidden sm:inline font-mono text-xs">
              Snapshot: {format(new Date(data.snapshotAt), "HH:mm:ss")}
            </span>
          )}
          <div className="flex items-center gap-2">
            <Select value={filters.limit.toString()} onValueChange={(v) => setFilters(f => ({ ...f, limit: parseInt(v) }))}>
              <SelectTrigger className="h-8 w-[110px] bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20 / page</SelectItem>
                <SelectItem value="50">50 / page</SelectItem>
                <SelectItem value="100">100 / page</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleBack} 
            disabled={currentCursorIndex === 0 || isLoading}
            className="w-20"
          >
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleNext} 
            disabled={!data?.nextCursor || isLoading}
            className="w-20"
          >
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </footer>

      <EventDetailSheet 
        event={selectedEvent} 
        open={!!selectedEvent} 
        onOpenChange={(open) => !open && setSelectedEvent(null)} 
      />
    </div>
  );
}

function EventDetailSheet({ event, open, onOpenChange }: { event: AuditEvent | null, open: boolean, onOpenChange: (o: boolean) => void }) {
  if (!event) return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent /></Sheet>;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl md:max-w-2xl p-0 flex flex-col gap-0 border-l">
        <SheetHeader className="p-6 pb-4 border-b shrink-0 text-left">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="outline" className="font-mono text-xs text-primary border-primary/30 bg-primary/5 capitalize">
              {event.category}:{event.action}
            </Badge>
          </div>
          <SheetTitle className="text-xl">Event Detail</SheetTitle>
          <SheetDescription className="font-mono text-xs mt-1">
            ID: {event.id}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-8">
            {/* Overview */}
            <div className="grid grid-cols-2 gap-y-6 gap-x-4 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Timestamp</Label>
                <div className="font-mono">{format(new Date(event.createdAt), "MMM d, yyyy HH:mm:ss.SSS")}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Request ID</Label>
                <div className="font-mono text-xs">{event.requestId || '—'}</div>
              </div>
              
              <div className="p-3 bg-muted/40 rounded-md border border-border/50">
                <Label className="text-xs text-muted-foreground mb-2 block flex items-center gap-2">
                  Actor
                </Label>
                <div className="font-medium">{event.actor.name}</div>
                <div className="text-xs text-muted-foreground mt-1 capitalize">{event.actor.kind}</div>
                {event.actor.userId && <div className="text-xs font-mono text-muted-foreground mt-1">{event.actor.userId}</div>}
              </div>

              <div className="p-3 bg-muted/40 rounded-md border border-border/50">
                <Label className="text-xs text-muted-foreground mb-2 block flex items-center gap-2">
                  Subject
                </Label>
                <div className="font-medium">{event.subject.label}</div>
                <div className="text-xs text-muted-foreground mt-1">{event.subject.type}</div>
                {event.subject.id && <div className="text-xs font-mono text-muted-foreground mt-1">{event.subject.id}</div>}
              </div>
            </div>

            {/* State Diff */}
            {(event.beforeState || event.afterState) && (
              <div className="space-y-3">
                <h3 className="font-semibold text-sm flex items-center gap-2 border-b pb-2">
                  <FileJson className="w-4 h-4 text-muted-foreground" /> State Changes
                </h3>
                <StateDiff before={event.beforeState} after={event.afterState} />
              </div>
            )}

            {/* Metadata */}
            {event.metadata && Object.keys(event.metadata).length > 0 && (
              <div className="space-y-3">
                <h3 className="font-semibold text-sm flex items-center gap-2 border-b pb-2">
                  <Activity className="w-4 h-4 text-muted-foreground" /> Metadata
                </h3>
                <div className="bg-card border rounded-md overflow-hidden">
                  <pre className="p-4 text-xs font-mono overflow-x-auto text-card-foreground">
                    {JSON.stringify(event.metadata, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function StateDiff({ before, after }: { before: any, after: any }) {
  if (!before && !after) return <div className="text-sm text-muted-foreground italic">No state data.</div>;
  if (!before) return <JsonViewer data={after} title="After State" />;
  if (!after) return <JsonViewer data={before} title="Before State" />;

  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  
  const hasChanges = keys.some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  
  if (!hasChanges) {
    return <div className="text-sm text-muted-foreground italic p-4 bg-muted/30 rounded-md border text-center">No detectable changes in state objects.</div>;
  }

  return (
    <div className="border rounded-md overflow-hidden divide-y">
      {keys.map(key => {
        const b = before[key];
        const a = after[key];
        const bStr = b !== undefined ? JSON.stringify(b) : 'undefined';
        const aStr = a !== undefined ? JSON.stringify(a) : 'undefined';
        const changed = bStr !== aStr;
        
        if (!changed) return null;
        
        return (
          <div key={key} className="grid grid-cols-1 md:grid-cols-12 text-sm font-mono bg-card">
            <div className="md:col-span-3 p-3 bg-muted/30 font-semibold text-muted-foreground border-b md:border-b-0 md:border-r flex items-center">
              {key}
            </div>
            <div className="md:col-span-9 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
              <div className="p-3 bg-red-500/5 text-red-700 dark:text-red-400 overflow-x-auto whitespace-pre-wrap break-words">
                {bStr}
              </div>
              <div className="p-3 bg-green-500/5 text-green-700 dark:text-green-400 overflow-x-auto whitespace-pre-wrap break-words">
                {aStr}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function JsonViewer({ data, title }: { data: any, title?: string }) {
  if (!data) return null;
  return (
    <div className="bg-card border rounded-md overflow-hidden">
      {title && <div className="px-4 py-2 border-b bg-muted/30 text-xs font-semibold">{title}</div>}
      <pre className="p-4 text-xs font-mono overflow-x-auto text-card-foreground">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}