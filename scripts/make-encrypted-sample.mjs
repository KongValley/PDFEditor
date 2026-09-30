// 生成一个 RC4-40 位加密的测试 PDF(标准安全处理器 V1/R2,空用户密码)
// 用途:验证应用对加密文档的检测与 sidecar-only 保存模式
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
])

function rc4(key, data) {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const tmp = s[i]
    s[i] = s[j]
    s[j] = tmp
  }
  const out = Buffer.alloc(data.length)
  let i = 0
  j = 0
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const tmp = s[i]
    s[i] = s[j]
    s[j] = tmp
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

function padPassword(password) {
  const buf = Buffer.alloc(32)
  const pw = Buffer.from(password, 'latin1')
  pw.copy(buf, 0, 0, Math.min(pw.length, 32))
  PAD.copy(buf, Math.min(pw.length, 32), 0, 32 - Math.min(pw.length, 32))
  return buf
}

const md5 = (buf) => createHash('md5').update(buf).digest()

const userPassword = process.argv[2] ?? ''
const ownerPassword = process.argv[2] ?? ''
const outName = process.argv[3] ?? 'sample-encrypted.pdf'
const permissions = -44 // 允许打印与修改
const id0 = Buffer.from('0123456789abcdef', 'latin1')

// O 值:MD5(owner pwd) 前 5 字节为 key,RC4 加密填充后的 user pwd
const ownerKey = md5(padPassword(ownerPassword)).subarray(0, 5)
const O = rc4(ownerKey, padPassword(userPassword))

// 文件密钥:MD5(padded user pwd + O + P + ID[0]) 前 5 字节
const pBuf = Buffer.alloc(4)
pBuf.writeInt32LE(permissions, 0)
const fileKey = md5(Buffer.concat([padPassword(userPassword), O, pBuf, id0])).subarray(0, 5)

// U 值:RC4(fileKey, PAD)
const U = rc4(fileKey, PAD)

function objectKey(num) {
  const extra = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])
  return md5(Buffer.concat([fileKey, extra])).subarray(0, Math.min(fileKey.length + 5, 16))
}

const content = 'BT /F1 24 Tf 40 120 Td (Hello Encrypted) Tj ET'
const encryptedContent = rc4(objectKey(4), Buffer.from(content, 'latin1'))

const chunks = []
let offset = 0
const offsets = [0]
function push(text) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1')
  chunks.push(buf)
  offset += buf.length
}
function startObject(num, body) {
  offsets[num] = offset
  push(`${num} 0 obj\n${body}\nendobj\n`)
}

push('%PDF-1.4\n')
startObject(1, '<< /Type /Catalog /Pages 2 0 R >>')
startObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
startObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
offsets[4] = offset
push(`4 0 obj\n<< /Length ${encryptedContent.length} >>\nstream\n`)
push(encryptedContent)
push('\nendstream\nendobj\n')
startObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
offsets[6] = offset
push(
  `6 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${permissions} >>\nendobj\n`
)

const xrefOffset = offset
let xref = 'xref\n0 7\n0000000000 65535 f \n'
for (let i = 1; i <= 6; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
push(xref)
push(
  `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${id0.toString('hex')}><${id0.toString('hex')}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`
)

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', outName)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, Buffer.concat(chunks))
console.log('已生成加密样本:', outPath)
