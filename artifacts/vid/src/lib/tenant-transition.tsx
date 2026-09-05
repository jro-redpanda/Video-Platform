import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"

interface TenantTransitionContextValue {
  isTransitioning: boolean
  beginTenantTransition: () => void
  endTenantTransition: () => void
}

const TenantTransitionContext = createContext<TenantTransitionContextValue | null>(null)

export function TenantTransitionProvider({ children }: { children: ReactNode }) {
  const [isTransitioning, setIsTransitioning] = useState(false)
  const beginTenantTransition = useCallback(() => setIsTransitioning(true), [])
  const endTenantTransition = useCallback(() => setIsTransitioning(false), [])
  const value = useMemo(() => ({
    isTransitioning,
    beginTenantTransition,
    endTenantTransition,
  }), [beginTenantTransition, endTenantTransition, isTransitioning])

  return (
    <TenantTransitionContext.Provider value={value}>
      {children}
    </TenantTransitionContext.Provider>
  )
}

export function useTenantTransition() {
  const context = useContext(TenantTransitionContext)
  if (!context) {
    throw new Error("useTenantTransition must be used inside TenantTransitionProvider")
  }
  return context
}