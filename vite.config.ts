import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: Number(process.env.FRONTEND_PORT) || 9700,
    strictPort: false,
  },
  preview: {
    port: Number(process.env.FRONTEND_PORT) || 9700,
  },
})
