import { useState, useEffect, useCallback } from "react"
import type { ListVideosStatus, ListVideosVisibility, ListVideosSort } from "@workspace/api-client-react"

export function useVideoFilters() {
  const getInitial = () => {
    const params = new URLSearchParams(window.location.search)
    return {
      search: params.get("search") || "",
      status: (params.get("status") as ListVideosStatus) || undefined,
      visibility: (params.get("visibility") as ListVideosVisibility) || undefined,
      sort: (params.get("sort") as ListVideosSort) || "newest",
      folder: params.get("folder") || "root",
    }
  }

  const [filters, setFilters] = useState<{
    search: string;
    status?: ListVideosStatus;
    visibility?: ListVideosVisibility;
    sort: ListVideosSort;
    folder: string;
  }>(getInitial)

  useEffect(() => {
    const handlePopState = () => {
      setFilters(getInitial())
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  const setFilter = useCallback((key: keyof typeof filters, value: any) => {
    setFilters(prev => {
      if (prev[key] === value) return prev;

      const next = { ...prev, [key]: value }

      const params = new URLSearchParams()
      if (next.search) params.set("search", next.search)
      if (next.status) params.set("status", next.status)
      if (next.visibility) params.set("visibility", next.visibility)
      if (next.sort && next.sort !== "newest") params.set("sort", next.sort)
      if (next.folder && next.folder !== "root") params.set("folder", next.folder)

      const qs = params.toString()
      const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`

      if (key === "folder") {
        window.history.pushState(null, '', newUrl)
      } else {
        window.history.replaceState(null, '', newUrl)
      }

      return next
    })
  }, [])

  const clearFilters = useCallback(() => {
    setFilters(prev => {
      const next = {
        search: "",
        status: undefined,
        visibility: undefined,
        sort: "newest" as ListVideosSort,
        folder: prev.folder
      }

      const params = new URLSearchParams()
      if (next.folder && next.folder !== "root") params.set("folder", next.folder)

      const qs = params.toString()
      const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`
      window.history.pushState(null, '', newUrl)

      return next
    })
  }, [])

  const hasActiveFilters = Boolean(
    filters.search || filters.status || filters.visibility || filters.sort !== "newest"
  )

  return { filters, setFilter, clearFilters, hasActiveFilters }
}
