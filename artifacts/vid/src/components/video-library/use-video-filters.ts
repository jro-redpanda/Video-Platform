import { useState, useEffect } from "react"
import type { ListVideosStatus, ListVideosVisibility, ListVideosSort } from "@workspace/api-client-react"

export function useVideoFilters() {
  const getInitial = () => {
    const params = new URLSearchParams(window.location.search)
    return {
      search: params.get("search") || "",
      status: (params.get("status") as ListVideosStatus) || undefined,
      visibility: (params.get("visibility") as ListVideosVisibility) || undefined,
      sort: (params.get("sort") as ListVideosSort) || "newest",
    }
  }

  const [filters, setFilters] = useState<{
    search: string;
    status?: ListVideosStatus;
    visibility?: ListVideosVisibility;
    sort: ListVideosSort;
  }>(getInitial)

  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.search) params.set("search", filters.search)
    if (filters.status) params.set("status", filters.status)
    if (filters.visibility) params.set("visibility", filters.visibility)
    if (filters.sort && filters.sort !== "newest") params.set("sort", filters.sort)

    const qs = params.toString()
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`
    window.history.replaceState(null, '', newUrl)
  }, [filters])

  const setFilter = (key: keyof typeof filters, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const clearFilters = () => {
    setFilters({
      search: "",
      status: undefined,
      visibility: undefined,
      sort: "newest"
    })
  }

  const hasActiveFilters = Boolean(
    filters.search || filters.status || filters.visibility || filters.sort !== "newest"
  )

  return { filters, setFilter, clearFilters, hasActiveFilters }
}
