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
  // Read `.env` from the repository root, where the PC's configuration already
  // lives, so the non-secret defaults below have a single source of truth.
  //
  // Only `VITE_*` variables reach the bundle, and only owner, repository and
  // poll interval are defined as `VITE_*` — the token and the signing secret are
  // deliberately absent. This build is served from a public URL, so anything
  // baked in is readable by anyone who loads the page, and the token reads every
  // session and can write prompts to the PC.
  // `packages/phone/` → `..` is `packages/` → `../..` is the repository root,
  // which is where the PC's `.env` actually lives.
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'CC Remote',
        short_name: 'CC Remote',
        description: 'Watch and drive Claude Code sessions from your phone',
        theme_color: '#171a18',
        background_color: '#171a18',
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
