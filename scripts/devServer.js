#!/usr/bin/env node

/**
 * Development launcher for the proxy server.
 *
 * Runs server/index.js with JSON logs and renders them through pino-pretty,
 * so `npm run dev` shows readable colored lines while `npm start` keeps the
 * server's own output (pretty on a terminal, JSON when piped).
 */

const path = require('path')
const { spawn } = require('child_process')
const pretty = require('pino-pretty')

const ROOT_DIR = path.join(__dirname, '..')

const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'index.js')], {
  cwd: ROOT_DIR,
  env: { ...process.env, PROXY_LOG_FORMAT: 'json' },
  stdio: ['inherit', 'pipe', 'inherit']
})

// pino-pretty writes the formatted lines to stdout itself (its default
// destination); the stream it returns only consumes the JSON lines.
child.stdout.pipe(
  pretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'scope',
    messageFormat: '[{scope}] {msg}'
  })
)

child.on('exit', code => {
  process.exit(code ?? 0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
