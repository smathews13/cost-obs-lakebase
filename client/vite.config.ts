import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../static",
    emptyOutDir: true,
    // Code splitting for optimized bundle loading
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks - split large dependencies
          "vendor-react": ["react", "react-dom"],
          "vendor-tanstack": ["@tanstack/react-query"],
          "vendor-recharts": ["recharts"],
          "vendor-date": ["date-fns"],
          // PDF export and screenshot (only loaded when user triggers export)
          "vendor-pdf": ["jspdf", "jspdf-autotable", "html2canvas"],
        },
      },
    },
    // Generate source maps for production debugging
    sourcemap: false,
    // Chunk size warnings
    chunkSizeWarningLimit: 500,
  },
});
