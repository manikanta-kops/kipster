import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import workerThreads from 'node:worker_threads'
import timers from 'node:timers'
import timersPromises from 'node:timers/promises'

// Node lazily wraps piped stdio in net.Socket. Prepare the test's reporting
// streams before guarding sockets so its completion marker is not a false alarm.
void process.stdout
void process.stderr

function block(object, names, label) {
  for (const name of names) {
    if (typeof object[name] === 'function') {
      object[name] = function forbiddenImportEffect() {
        throw new Error(`Import attempted ${label}.${name}`)
      }
    }
  }
}

block(net, ['createConnection', 'connect', 'createServer', 'Socket', 'Server'], 'net')
block(tls, ['connect', 'createServer', 'TLSSocket', 'Server'], 'tls')
block(http, ['request', 'get', 'createServer', 'Server', 'ClientRequest'], 'http')
block(https, ['request', 'get', 'createServer', 'Server'], 'https')
block(http2, ['connect', 'createServer', 'createSecureServer'], 'http2')
block(dgram, ['createSocket', 'Socket'], 'dgram')
block(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'child_process')
block(workerThreads, ['Worker'], 'worker_threads')
block(globalThis, ['fetch', 'WebSocket', 'setTimeout', 'setInterval', 'setImmediate'], 'global')
block(timers, ['setTimeout', 'setInterval', 'setImmediate'], 'timers')
block(timersPromises, ['setTimeout', 'setInterval', 'setImmediate'], 'timers/promises')
const mutations = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'symlink', 'link', 'chmod', 'chown', 'utimes', 'createWriteStream', 'watch', 'watchFile']
block(fs, [...mutations, ...mutations.map((name) => `${name}Sync`)], 'fs')
block(fsPromises, mutations, 'fs/promises')
syncBuiltinESMExports()

// This is a regression detector for startup effects, not an execution sandbox.
