import fs from "node:fs"
import path from "node:path"

// Vite 的 public 目录复制会跳过百度网盘占位文件，这里用 stat/copyFile 兜底
const src = path.resolve("public/data")
const dest = path.resolve("dist/data")

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name)
    const b = path.join(to, name)
    if (fs.statSync(a).isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

if (fs.existsSync(src)) {
  copyDir(src, dest)
  console.log("[postbuild] public/data -> dist/data")
}
