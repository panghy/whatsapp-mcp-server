#!/usr/bin/env node
import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// Spawn Vite
const vite = spawn('npx', ['vite'], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: true
})

let electronProcess = null
let devServerUrl = null

vite.stdout.on('data', (data) => {
  const text = data.toString()
  process.stdout.write(data)

  // Look for Vite's local URL output
  if (!devServerUrl) {
    const match = text.match(/Local:\s+(https?:\/\/localhost:\d+)/)
    if (match) {
      devServerUrl = match[1]
      console.log(`\n[dev] Detected Vite dev server at: ${devServerUrl}`)
      console.log('[dev] Starting Electron...\n')

      electronProcess = spawn('npx', ['electron', '.'], {
        cwd: root,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl }
      })

      electronProcess.on('close', (code) => {
        console.log(`[dev] Electron exited with code ${code}`)
        vite.kill()
        process.exit(code ?? 0)
      })
    }
  }
})

vite.stderr.on('data', (data) => {
  process.stderr.write(data)
})

vite.on('close', (code) => {
  console.log(`[dev] Vite exited with code ${code}`)
  if (electronProcess) electronProcess.kill()
  process.exit(code ?? 1)
})

// Clean up on exit
function cleanup() {
  if (electronProcess) electronProcess.kill()
  vite.kill()
  process.exit()
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

