import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep each Firebase product intact. Size-based re-splitting can create
          // circular ESM chunks and crash the app before React mounts.
          groups: [
            {
              name: "firebase-firestore",
              test: /node_modules[\\/]@firebase[\\/]firestore[\\/]/,
              priority: 6,
            },
            {
              name: "firebase-auth",
              test: /node_modules[\\/]@firebase[\\/]auth[\\/]/,
              priority: 5,
            },
            {
              name: "firebase-storage",
              test: /node_modules[\\/]@firebase[\\/]storage[\\/]/,
              priority: 4,
            },
            {
              name: "firebase-functions",
              test: /node_modules[\\/]@firebase[\\/]functions[\\/]/,
              priority: 3,
            },
            {
              name: "firebase-messaging",
              test: /node_modules[\\/]@firebase[\\/]messaging[\\/]/,
              priority: 2,
            },
            {
              name: "firebase-shared",
              test: /node_modules[\\/]@firebase[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["logo.png"],
      injectManifest: { globPatterns: ["**/*.{js,css,html,png,svg,ico}"] },
      manifest: {
        name: "Lip Knots Crew Admin",
        short_name: "Crew Admin",
        description: "Lip Knots Crew 管理者画面",
        theme_color: "#f6dce6",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
        ]
      }
    })
  ]
});
