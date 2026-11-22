// Copies @t3tools/board-core from the T3 Code fork into the mod, which can only import files
// inside its own plugin folder. The fork is the source of truth: edit there, then run
//   node tools/sync-board-core.mjs [path-to-fork]
// Default fork path: C:\Claude Works\t3code-board. Node-only files and tests are left out.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fork = resolve(process.argv[2] ?? 'C:/Claude Works/t3code-board')
const src = join(fork, 'packages', 'board-core', 'src')
const dest = join(here, '..', 'mod', 'project-board', 'hooks', 'board-core')
const SKIP = /\.test\.ts$|^nodeIO\.ts$/

if (!existsSync(src)) {
  console.error(`board-core not found at ${src}`)
  process.exit(1)
}
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
const files = readdirSync(src).filter(f => f.endsWith('.ts') && !SKIP.test(f))
for (const f of files) copyFileSync(join(src, f), join(dest, f))
writeFileSync(
  join(dest, 'README.md'),
  `Copied from the T3 Code fork's packages/board-core by tools/sync-board-core.mjs. Do not edit here.\n`,
)
console.log(`Synced ${files.length} files from ${src}`)
