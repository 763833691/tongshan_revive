// 只生成“不要 L18 以后”的索引，近景会一直糊。正式模型不要用这个结果。
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? "public/3dtiles/tongshan")
const maxLevel = Number(process.argv[3] ?? 17)

function levelOf(uri) {
  const m = /_L(\d+)_/.exec(uri ?? "")
  return m ? Number(m[1]) : null
}

function prune(node) {
  const level = levelOf(node.content?.uri)
  if (level !== null && level > maxLevel) return null
  if (node.children) {
    node.children = node.children.map(prune).filter(Boolean)
    if (!node.children.length) delete node.children
  }
  return node
}

function writeWebTileset(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"))
  prune(json.root)
  const out = path.join(path.dirname(file), "tileset.web.json")
  fs.writeFileSync(out, JSON.stringify(json))
  return out
}

const dataDir = path.join(root, "Data")
const blocks = fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory())
let converted = 0
for (const block of blocks) {
  const file = path.join(dataDir, block.name, "tileset.json")
  if (fs.existsSync(file)) {
    writeWebTileset(file)
    converted++
  }
}

const mainFile = path.join(root, "tileset.json")
const main = JSON.parse(fs.readFileSync(mainFile, "utf8"))
for (const child of main.root.children ?? []) {
  if (child.content?.uri) child.content.uri = child.content.uri.replace(/tileset\.json$/, "tileset.web.json")
}
fs.writeFileSync(path.join(root, "tileset.web.json"), JSON.stringify(main))
console.log(`blocks=${converted} maxLevel=${maxLevel} -> tileset.web.json`)
