import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Stop Vite searching parent directories for a PostCSS config. Without this
  // it picks up C:\Users\Welcome-Pc\postcss.config.js (Tailwind + autoprefixer),
  // which has nothing to do with this project.
  css: { postcss: {} },
})
