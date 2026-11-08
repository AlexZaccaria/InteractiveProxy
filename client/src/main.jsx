import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { queryClient } from './lib/queryClient'
import { applyThemeToDocument } from './lib/theme'
import { useProxyStore } from './store/useProxyStore'

// The inline script of index.html already set the class; this keeps the
// document and the store in step when the script could not run.
applyThemeToDocument(useProxyStore.getState().theme)

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
