import fs from "node:fs"
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type ViteDevServer } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const OPT_TILES_DIR = "H:/tongshan-3dtiles-opt"

function serveOptimizedTiles() {
  const prefix = "/3dtiles/tongshan-opt"
  return {
    name: "serve-optimized-tiles",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(prefix, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "")
        const file = path.resolve(OPT_TILES_DIR, rel)
        if (!file.startsWith(path.resolve(OPT_TILES_DIR)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next()
          return
        }
        res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream")
        if (file.endsWith(".json")) res.setHeader("Cache-Control", "no-cache")
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  // 磁盘紧张/CI 无瓦片时：SKIP_PUBLIC=1 npm run build，随后手动拷贝 public/data
  publicDir: process.env.SKIP_PUBLIC === '1' ? false : 'public',
  plugins: [
    serveOptimizedTiles(),
    inspectAttr(),
    react(),
    viteStaticCopy({
      targets: [
        // 必须递归复制，并剥掉 node_modules/cesium/Build/Cesium 四段前缀，
        // 输出到 dist/cesium/{Assets,ThirdParty,Widgets,Workers,Cesium.js...}
        {
          src: 'node_modules/cesium/Build/Cesium/**/*',
          dest: 'cesium',
          rename: { stripBase: 4 },
        },
      ],
    }),
  ],
  define: {
    // 开发态直接读 node_modules（vite-plugin-static-copy 的 dev 中间件不可靠）；
    // 构建态使用相对路径，便于部署到任意子目录（如 Nginx /tongshan/）
    CESIUM_BASE_URL: JSON.stringify(
      command === 'serve' ? '/node_modules/cesium/Build/Cesium/' : './cesium/',
    ),
  },
  server: {
    port: 7100,
    host: true,
  },
  build: {
    chunkSizeWarningLimit: 6000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}))
