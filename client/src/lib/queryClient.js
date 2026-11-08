import { QueryClient } from '@tanstack/react-query'

/**
 * The single query cache of the UI. Data is always considered stale (the
 * event stream and the mutations decide when to refetch), window focus does
 * not trigger refetches, and a failed request is retried once.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 1
    },
    mutations: {
      retry: 0
    }
  }
})
