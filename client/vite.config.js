/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// ports.config.json at the repository root is the single place where the UI
// and proxy ports are defined; the values reach the app as the compile-time
// constant __PROXY_PORTS__ (see src/config/apiConfig.js).
const portsConfigUrl = new URL('../ports.config.json', import.meta.url)
const ports = JSON.parse(readFileSync(fileURLToPath(portsConfigUrl), 'utf8'))

const uiPort = Number(ports.uiPort) || 3050
const backendPort = Number(ports.backendPort) || 8050
const backendHost = ports.backendHost || 'localhost'
const backendProtocol = ports.backendProtocol || 'http'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __PROXY_PORTS__: JSON.stringify({ uiPort, backendPort, backendHost, backendProtocol })
  },
  server: {
    port: uiPort,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  // Vitest (`npm test` in this workspace): component and hook tests under
  // src/ run in jsdom with Testing Library (src/test/setup.js).
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false
  }
})
