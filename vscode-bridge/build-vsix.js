// Packs this folder into project-board-bridge-<version>.vsix with no extra tools.
// Install: code --install-extension project-board-bridge-<version>.vsix
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const dir = __dirname
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const out = path.join(dir, `${pkg.name}-${pkg.version}.vsix`)

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${(pkg.extensionDependencies || []).join(',')}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
`
const files = [
  ['[Content_Types].xml', Buffer.from(types)],
  ['extension.vsixmanifest', Buffer.from(manifest)],
  ['extension/package.json', fs.readFileSync(path.join(dir, 'package.json'))],
  ['extension/extension.js', fs.readFileSync(path.join(dir, 'extension.js'))],
]

// Minimal zip writer (deflate).
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const parts = [], central = []
let offset = 0
for (const [name, data] of files) {
  const nameBuf = Buffer.from(name), comp = zlib.deflateRawSync(data), crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
  parts.push(local, nameBuf, comp)
  const cen = Buffer.alloc(46)
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10)
  cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24)
  cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42)
  central.push(cen, nameBuf)
  offset += 30 + nameBuf.length + comp.length
}
const cenSize = central.reduce((n, b) => n + b.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16)
fs.writeFileSync(out, Buffer.concat([...parts, ...central, end]))
console.log('wrote', out)
