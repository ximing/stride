#!/usr/bin/env node
// Verify a tauri updater `.app.tar.gz.sig` against a minisign public key
// without a local `minisign` binary (T8.4 dry-run helper).
//
//   node scripts/verify-updater-signature.mjs <artifact.tar.gz> <artifact.tar.gz.sig> <pubkey>
//
// `<pubkey>` is the value of `plugins.updater.pubkey` in tauri.conf.json —
// i.e. base64 of the standard two-line minisign public key file. The
// signature file is what tauri build produces: a single base64 line wrapping
// the four-line minisign signature (a raw four-line file also works).
//
// Verifies the same things `minisign -V` and the updater plugin do: the
// Ed25519 signature by the matching key over the artifact (blake2b-512
// digest for prehashed signatures) plus the global signature covering the
// trusted comment. Exits 0 on success.

import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

// base64 -> bytes; throws on invalid input.
function b64(text, what) {
  try {
    return Buffer.from(text, 'base64')
  } catch {
    throw new Error(`invalid base64 in ${what}`)
  }
}

function b64Strict(text, what) {
  const bytes = b64(text, what)
  if (bytes.toString('base64').replace(/=+$/, '') !== text.trim().replace(/=+$/, '')) {
    throw new Error(`invalid base64 in ${what}`)
  }
  return bytes
}

// Wrap a raw 32-byte Ed25519 public key in a SPKI DER structure so node's
// crypto can load it (fixed prefix for ed25519 OID).
function ed25519PublicKeyObject(rawKey) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey])
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

const [artifactPath, sigPath, pubkeyPath] = process.argv.slice(2)
if (!artifactPath || !sigPath || !pubkeyPath) {
  console.error('usage: node scripts/verify-updater-signature.mjs <artifact> <artifact.sig> <pubkey>')
  process.exit(1)
}

// Public key: either the tauri.conf.json value (base64 of the two-line file)
// or a raw minisign .pub file. Normalize to the two-line form.
const pubkeyRaw = readFileSync(pubkeyPath, 'utf8').trim()
const pubkeyFile = pubkeyRaw.startsWith('untrusted comment:')
  ? pubkeyRaw
  : b64Strict(pubkeyRaw, 'pubkey').toString('utf8')
const pubkeyLines = pubkeyFile.split('\n')
if (pubkeyLines.length < 2) throw new Error('malformed public key')
const pubkeyBox = b64Strict(pubkeyLines[1].trim(), 'public key')
if (pubkeyBox.length !== 42 || pubkeyBox.subarray(0, 2).toString() !== 'Ed') {
  throw new Error('not an Ed25519 minisign public key')
}

// Signature: tauri-cli writes `.sig` as a single base64 line wrapping the
// four-line minisign signature (the plugin base64-decodes the latest.json
// `signature` field the same way); a raw four-line minisign .sig file is
// accepted too. The base64 blob decodes to 'Ed'/'ED' + keynum(8) + sig(64).
const sigFileRaw = readFileSync(sigPath, 'utf8').trim()
const sigFile = sigFileRaw.startsWith('untrusted comment:')
  ? sigFileRaw
  : b64Strict(sigFileRaw, 'signature file').toString('utf8')
const sigLines = sigFile.split('\n')
if (sigLines.length < 4) throw new Error('malformed signature file (expected 4 lines)')
const sigBox = b64Strict(sigLines[1].trim(), 'signature')
// 'Ed' = signature over raw bytes; 'ED' = prehashed (blake2b-512), which is
// what tauri's signer produces.
const algorithm = sigBox.subarray(0, 2).toString('latin1')
if (sigBox.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) {
  throw new Error('not an Ed25519 minisign signature')
}
if (!sigBox.subarray(2, 10).equals(pubkeyBox.subarray(2, 10))) {
  throw new Error('signature key id does not match public key')
}
const trustedCommentLine = sigLines[2]
if (!trustedCommentLine.startsWith('trusted comment: ')) {
  throw new Error('missing trusted comment')
}
const globalSig = b64Strict(sigLines[3].trim(), 'global signature')
if (globalSig.length !== 64) throw new Error('malformed global signature')

const pubKeyObject = ed25519PublicKeyObject(pubkeyBox.subarray(10))
const artifact = readFileSync(artifactPath)

// 1. Signature over the artifact bytes (prehashed variants sign the raw
//    blake2b-512 digest instead, per minisign's "ED" algorithm).
const message = algorithm === 'ED' ? createHash('blake2b512').update(artifact).digest() : artifact
const ok = ed25519Verify(null, message, pubKeyObject, sigBox.subarray(10))
// 2. Global signature over (signature || trusted comment) — this is what
//    makes the trusted comment (and the `version:` tauri embeds in it)
//    trustworthy, which `requireSignedVersion` in tauri.conf.json relies on.
const trustedComment = trustedCommentLine.slice('trusted comment: '.length)
const globalOk = ed25519Verify(
  null,
  Buffer.concat([sigBox.subarray(10), Buffer.from(trustedComment, 'utf8')]),
  pubKeyObject,
  globalSig,
)

const name = artifactPath
if (!ok || !globalOk) {
  console.error(`FAILED: ${!ok ? 'artifact signature' : 'global signature'} does not verify for ${name}`)
  process.exit(1)
}
console.log(`OK: ${name} verified against minisign key ${pubkeyBox.subarray(2, 10).toString('hex')}`)
console.log(`    trusted comment: ${trustedComment}`)
