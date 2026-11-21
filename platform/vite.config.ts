import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [
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
