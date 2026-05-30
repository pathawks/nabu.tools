import path from "path"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Mirrors the CloudFront response-headers CSP (terraform/main.tf), minus
// frame-ancestors which a <meta> CSP ignores (that stays header-only).
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")

// Bake the CSP into the built HTML so the static output is self-protecting
// even when served without the CloudFront headers. Build-only: in dev, Vite's
// HMR injects inline scripts that script-src 'self' would block.
function cspMeta(): Plugin {
  return {
    name: "csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: CSP,
          },
          injectTo: "head-prepend",
        },
      ]
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
