import { useState, useCallback } from "react"

export function useVideoSelection(maxSelected = 50) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < maxSelected) {
        next.add(id)
      }
      return next
    })
  }, [maxSelected])

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids.slice(0, maxSelected)))
  }, [maxSelected])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const setSelection = useCallback((ids: Set<string>) => {
    setSelectedIds(ids)
  }, [])

  const handlePartialSuccess = useCallback((succeededIds: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      succeededIds.forEach(id => next.delete(id))
      return next
    })
  }, [])

  return {
    selectedIds,
    toggleSelection,
    selectAll,
    clearSelection,
    setSelection,
    handlePartialSuccess
  }
}

