// ═══════════════════════════════════════════════════════════════════════════════
// NetOps Backend Server — standalone Express + WebSocket for large-scale polling
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { Client } from 'ssh2'

const app = express()
app.use(express.json())

// CORS — allow connections from any origin (Electron app)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { return res.sendStatus(204) }
    next()
})

const server = createServer(app)
const wss = new WebSocketServer({ server })

// ─── WebSocket client tracking ─────────────────────────────────────────────

const clients = new Set<WebSocket>()
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown'
    console.log(`[WS] Client connected from ${ip} (${clients.size + 1} total)`)
    clients.add(ws)
    ws.on('close', () => {
        clients.delete(ws)
        console.log(`[WS] Client disconnected (${clients.size} remaining)`)
    })
})

function broadcast (data: any): void {
    const msg = JSON.stringify(data)
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) { ws.send(msg) }
    }
}

// ─── SSH helper ─────────────────────────────────────────────────────────────

interface SshParams {
    host: string
    port?: number
    username: string
    password: string
    commands: string[]
    timeoutMs?: number
}

function sshRunCommands (params: SshParams): Promise<{ ok: boolean; outputs: string[]; error?: string }> {
    const { host, port = 22, username, password, commands, timeoutMs = 30000 } = params
    return new Promise((resolve) => {
        const conn = new Client()
        let settled = false
        const timer = setTimeout(() => done({ ok: false, outputs: [], error: `Timeout after ${timeoutMs} ms` }), timeoutMs + 500)

        function done (result: { ok: boolean; outputs: string[]; error?: string }): void {
            if (settled) { return }
            settled = true
            clearTimeout(timer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        conn.on('ready', async () => {
            const outputs: string[] = []
            for (const cmd of commands) {
                try {
                    const out = await new Promise<string>((res, rej) => {
                        conn.exec(cmd, (err, stream) => {
                            if (err) { return rej(err) }
                            let buf = ''
                            stream.on('data', (chunk: Buffer) => { buf += chunk.toString() })
                            stream.stderr.on('data', (chunk: Buffer) => { buf += chunk.toString() })
                            stream.on('close', () => res(buf.trim()))
                            stream.on('error', rej)
                        })
                    })
                    outputs.push(out)
                } catch (err: any) {
                    outputs.push(`[error] ${err.message}`)
                }
            }
            done({ ok: true, outputs })
        })

        conn.on('error', (err: Error) => {
            done({ ok: false, outputs: [], error: `SSH connection failed: ${err.message}` })
        })

        try {
            conn.connect({
                host,
                port,
                username,
                password,
                readyTimeout: timeoutMs,
                algorithms: {
                    kex: [
                        'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                        'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                        'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
                    ],
                },
            })
        } catch (err: any) {
            done({ ok: false, outputs: [], error: `SSH connect error: ${err.message}` })
        }
    })
}

// ─── SSH shell session (interactive) ────────────────────────────────────────

interface ShellParams {
    host: string
    port?: number
    username: string
    password: string
    commands: string[]
    delayMs?: number
}

function sshShellSession (params: ShellParams): Promise<{ ok: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
        const client = new Client()
        const delay = params.delayMs || 300
        let output = ''
        let settled = false

        function done (result: { ok: boolean; output: string; error?: string }): void {
            if (settled) { return }
            settled = true
            try { client.end() } catch { /* no-op */ }
            resolve(result)
        }

        client.on('ready', () => {
            client.shell((err, stream) => {
                if (err) { done({ ok: false, output: '', error: err.message }); return }

                stream.on('data', (data: Buffer) => { output += data.toString() })
                stream.on('close', () => { done({ ok: true, output }) })

                // Send commands with delays
                let i = 0
                const sendNext = (): void => {
                    if (i < params.commands.length) {
                        stream.write(params.commands[i] + '\n')
                        i++
                        setTimeout(sendNext, delay)
                    } else {
                        setTimeout(() => stream.end(), delay * 2)
                    }
                }
                sendNext()
            })
        })

        client.on('error', (err) => { done({ ok: false, output, error: err.message }) })

        try {
            client.connect({
                host: params.host,
                port: params.port || 22,
                username: params.username,
                password: params.password,
                readyTimeout: 15000,
                algorithms: {
                    kex: [
                        'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                        'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                        'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
                    ],
                },
            })
        } catch (err: any) {
            done({ ok: false, output: '', error: `SSH connect error: ${err.message}` })
        }
    })
}

// ─── Concurrency limiter ────────────────────────────────────────────────────

async function runWithConcurrency<T> (tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = []
    let idx = 0
    const run = async (): Promise<void> => {
        while (idx < tasks.length) {
            const i = idx++
            results[i] = await tasks[i]()
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => run()))
    return results
}

// ─── REST API ───────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
    res.json({ ok: true, clients: clients.size, uptime: process.uptime() })
})

app.post('/api/poll', async (req, res) => {
    const { host, port, username, password, commands, timeoutMs } = req.body
    if (!host || !username || !password || !commands?.length) {
        console.log(`[POLL] ❌ Rejected — missing fields: host=${host || 'EMPTY'}, user=${username || 'EMPTY'}, cmds=${commands?.length || 0}`)
        return res.status(400).json({ ok: false, error: `Missing required fields: ${!host ? 'host ' : ''}${!username ? 'username ' : ''}${!password ? 'password ' : ''}${!commands?.length ? 'commands' : ''}`.trim() })
    }
    console.log(`[POLL] ${host}:${port || 22} — ${commands.length} commands`)
    const result = await sshRunCommands({ host, port, username, password, commands, timeoutMs })
    console.log(`[POLL] ${host} — ${result.ok ? 'OK' : 'FAILED: ' + (result.error || 'unknown')}`)
    const pollResult = {
        type: 'poll_result',
        nodeId: host,
        ok: result.ok,
        data: result,
        timestamp: new Date().toISOString(),
    }
    broadcast(pollResult)
    res.json(result)
})

app.post('/api/poll-all', async (req, res) => {
    const { devices } = req.body
    if (!Array.isArray(devices) || !devices.length) {
        return res.status(400).json({ ok: false, error: 'devices array is required' })
    }

    const tasks = devices.map((dev: any) => async () => {
        const result = await sshRunCommands({
            host: dev.host,
            port: dev.port,
            username: dev.username,
            password: dev.password,
            commands: dev.commands || [],
            timeoutMs: dev.timeoutMs,
        })
        const pollResult = {
            type: 'poll_result',
            nodeId: dev.host,
            ok: result.ok,
            data: result,
            timestamp: new Date().toISOString(),
        }
        broadcast(pollResult)
        return pollResult
    })

    const results = await runWithConcurrency(tasks, 10)
    res.json({ ok: true, results })
})

app.post('/api/backup', async (req, res) => {
    const { host, port, username, password, command, timeoutMs } = req.body
    console.log(`[BACKUP] ${host}:${port || 22} — ${command || 'show running-config'}`)
    if (!host || !username || !password) {
        return res.status(400).json({ ok: false, error: 'Missing required fields (host, username, password)' })
    }
    const backupCmd = command || 'show running-config'
    const result = await sshRunCommands({ host, port, username, password, commands: [backupCmd], timeoutMs })
    console.log(`[BACKUP] ${host} — ${result.ok ? 'OK (' + (result.outputs?.[0]?.length ?? 0) + ' chars)' : 'FAILED: ' + (result.error || 'unknown')}`)
    res.json({
        ok: result.ok,
        output: result.outputs?.[0] ?? '',
        error: result.error,
        timestamp: new Date().toISOString(),
    })
})

app.post('/api/discover', async (req, res) => {
    const { host, port, username, password, command, timeoutMs } = req.body
    if (!host || !username || !password) {
        return res.status(400).json({ ok: false, error: 'Missing required fields (host, username, password)' })
    }
    const lldpCmd = command || 'show lldp neighbors detail'
    const result = await sshRunCommands({ host, port, username, password, commands: [lldpCmd], timeoutMs })
    res.json({
        ok: result.ok,
        output: result.outputs?.[0] ?? '',
        error: result.error,
        timestamp: new Date().toISOString(),
    })
})

app.post('/api/load-config', async (req, res) => {
    const { host, port, username, password, commands, delayMs } = req.body
    console.log(`[LOAD-CONFIG] ${host}:${port || 22} — ${commands?.length || 0} commands`)
    if (!host || !username || !password || !commands?.length) {
        return res.status(400).json({ ok: false, error: 'Missing required fields' })
    }
    const result = await sshShellSession({ host, port, username, password, commands, delayMs: delayMs || 300 })
    console.log(`[LOAD-CONFIG] ${host} — ${result.ok ? 'OK' : 'FAILED'}`)
    res.json(result)
})

// ─── Container live polling (for remote labs) ──────────────────────────────

import { execSync, exec as execCb } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(execCb)

app.post('/api/container-poll', async (req, res) => {
    const { containers } = req.body  // Array of { name, kind }
    if (!Array.isArray(containers) || !containers.length) {
        return res.status(400).json({ ok: false, error: 'Missing containers array' })
    }

    console.log(`[CONTAINER-POLL] ${containers.length} containers`)
    const results: Array<{ containerName: string; state: string; bgpNeighbors: any[] }> = []

    // Step 1: Docker inspect all containers for state
    try {
        const ids = containers.map(c => c.name).join(' ')
        const { stdout } = await execAsync(`docker inspect --format '{{.Name}}|{{.State.Status}}' ${ids}`, { timeout: 10_000 })
        const stateMap = new Map<string, string>()
        for (const line of stdout.trim().split('\n')) {
            if (!line.includes('|')) continue
            const sepIdx = line.lastIndexOf('|')
            const rawName = line.slice(0, sepIdx).replace(/^\//, '')
            const state = line.slice(sepIdx + 1)
            stateMap.set(rawName, state)
        }

        // Step 2: For running containers, get BGP summary
        for (const c of containers) {
            const state = stateMap.get(c.name) ?? 'unknown'
            const entry: any = { containerName: c.name, state, bgpNeighbors: [] }

            if (state === 'running') {
                let bgpCmd: string[] | null = null
                const kind = (c.kind || '').toLowerCase()
                if (kind.includes('sonic') || kind.includes('frr')) { bgpCmd = ['vtysh', '-c', 'show bgp summary json'] }
                else if (kind.includes('srl') || kind.includes('nokia')) { bgpCmd = ['sr_cli', '-d', 'show network-instance default protocols bgp neighbor'] }
                else if (kind.includes('ceos') || kind.includes('arista')) { bgpCmd = ['Cli', '-p', '15', '-c', 'show bgp summary | json'] }
                else if (kind.includes('crpd') || kind.includes('juniper') || kind.includes('junos')) { bgpCmd = ['cli', '-c', 'show bgp summary'] }

                if (bgpCmd) {
                    try {
                        const { stdout: bgpOut } = await execAsync(`docker exec ${c.name} ${bgpCmd.join(' ')}`, { timeout: 15_000 })
                        // Parse BGP output — simple text-based for now
                        const ipRe = /(\d+\.\d+\.\d+\.\d+)/
                        const stateWords = ['establ', 'active', 'connect', 'idle', 'openconfirm', 'opensent']
                        for (const line of bgpOut.split('\n')) {
                            const ipMatch = line.match(ipRe)
                            if (!ipMatch) continue
                            const lower = line.toLowerCase()
                            let bgpState = 'unknown'
                            for (const sw of stateWords) {
                                if (lower.includes(sw)) { bgpState = sw === 'establ' ? 'established' : sw; break }
                            }
                            if (bgpState === 'unknown' && !lower.includes('neighbor')) continue
                            const asnMatch = line.match(/\b(\d{4,6})\b/)
                            entry.bgpNeighbors.push({
                                neighborIp: ipMatch[1],
                                state: bgpState,
                                asn: asnMatch ? Number(asnMatch[1]) : 0,
                                prefixCount: 0,
                            })
                        }
                    } catch { /* BGP query failed — skip */ }
                }
            }

            results.push(entry)
        }

        console.log(`[CONTAINER-POLL] ${results.length} polled — ${results.filter(r => r.state === 'running').length} running`)
        res.json({ ok: true, containers: results })
    } catch (err: any) {
        console.log(`[CONTAINER-POLL] ❌ Failed: ${err.message}`)
        res.json({ ok: false, error: err.message, containers: [] })
    }
})

// ─── Start server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`NetOps backend server listening on port ${PORT}`)
})
