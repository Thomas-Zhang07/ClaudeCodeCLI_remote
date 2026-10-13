import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// Mirrors the conventions of the reference PWA (E:\notebookRemote): Vue 3,
// `@` aliased to src, and a standalone auto-updating service worker.
export default defineConfig({
  // Relative base so the build also works when served from a sub-path (e.g.
  // Gitee Pages project sites live at /<owner>/<repo>/).
  base: './',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'CC Remote',
        short_name: 'CC Remote',
        description: 'Watch and drive Claude Code sessions from your phone',
        theme_color: '#101014',
        background_color: '#101014',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        // The relay data is fetched cross-origin; never let a stale service
        // worker answer for it.
        navigateFallback: 'index.html'
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
