import type { QueryClient } from "@tanstack/react-query"
import {
  getGetDashboardQueryKey,
  getListActivityQueryKey,
} from "@workspace/api-client-react"

export function invalidateVideoDerivedQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
  ])
}