import { HEARTBEAT_INTERVAL_MS, parseMessage, serializeMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'
import jsQR from 'jsqr'
import { parseQrPayload } from './qr-payload.ts'
import './style.css'

/** Resolve a required element of type T or throw — the DOM is static here. */
function requireElement<T extends HTMLElement>(selector: string, constructor: new () => T): T {
  const element = document.querySelector(selector)
  if (element === null || !(element instanceof constructor)) {
    throw new Error(`missing element: ${selector}`)
  }
  return element
}

const app = requireElement<HTMLElement>('#app', HTMLElement)

interface Session {
  socket: WebSocket
  token: string
  deviceId: string
}

/** Persisted connection: a paired phone resumes with its token, no re-scan. */
interface StoredConnection {
  relay: string
  token: string
}

const CONNECTION_KEY = 'dsh-remote.connection'
/** Requests the device does not answer within this budget fail instead of hanging. */
const REQUEST_TIMEOUT_MS = 30_000
/** Dialing and pairing must not hang forever on a weak network. */
const HANDSHAKE_TIMEOUT_MS = 10_000

let session: Session | undefined
let heartbeat: number | undefined

function render(html: string): void {
  app.innerHTML = html
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function nextMessage(socket: WebSocket, match: (message: Envelope) => boolean): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      let message: Envelope
      try {
        message = parseMessage(String(event.data))
      } catch {
        return
      }
      if (match(message)) {
        cleanup()
        resolve(message)
      }
    }
    const onError = (): void => { cleanup(); reject(new Error('websocket error')) }
    const onClose = (): void => { cleanup(); reject(new Error('连接已断开')) }
    const cleanup = (): void => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

/** Keep an established session alive and surface an unexpected disconnect. */
function bindSession(socket: WebSocket): void {
  if (heartbeat !== undefined) clearInterval(heartbeat)
  heartbeat = window.setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(serializeMessage({ type: 'ping', payload: {} }))
  }, HEARTBEAT_INTERVAL_MS)
  socket.addEventListener('close', () => {
    if (heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined }
    // An intentional teardown clears `session` before closing the socket; only
    // an unexpected drop reaches here.
    if (session === undefined || session.socket !== socket) return
    session = undefined
    render('<h1>连接已断开</h1><p id="status">网络连接中断。</p><button id="reconnect">重新连接</button>')
    requireElement<HTMLButtonElement>('#reconnect', HTMLButtonElement).addEventListener('click', () => { resume() })
  })
}

async function request(method: string, params: unknown): Promise<unknown> {
  if (session === undefined) throw new Error('未连接')
  const id = crypto.randomUUID()
  try {
    session.socket.send(serializeMessage({
      type: 'request',
      id,
      deviceId: session.deviceId,
      payload: { token: session.token, method, params },
    }))
  } catch (error) {
    // A half-closed socket throws synchronously from send(); surface it as a
    // rejection so callers' .catch handles it.
    throw new Error(`发送失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  const reply = await withTimeout(
    nextMessage(
      session.socket,
      message => message.id === id && (message.type === 'response' || message.type === 'error'),
    ),
    REQUEST_TIMEOUT_MS,
    '请求超时',
  )
  if (reply.type === 'error') throw new Error((reply.payload as { message: string }).message)
  return (reply.payload as { result: unknown }).result
}

/** Open a socket, send one message, and resolve the first matching reply. */
async function connectAndExchange(
  relay: string,
  send: (socket: WebSocket) => void,
): Promise<{ socket: WebSocket; reply: Envelope }> {
  const socket = new WebSocket(relay)
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => { resolve() })
        socket.addEventListener('error', () => { reject(new Error('无法连接中继')) })
      }),
      HANDSHAKE_TIMEOUT_MS,
      '连接中继超时',
    )
    send(socket)
    const reply = await withTimeout(
      nextMessage(
        socket,
        message => message.type === 'pair-result' || message.type === 'error',
      ),
      HANDSHAKE_TIMEOUT_MS,
      '配对超时',
    )
    return { socket, reply }
  } catch (error) {
    socket.close()
    throw error
  }
}

/** Scan a QR with the rear camera; resolve the decoded payload once. */
async function scanQr(): Promise<{ relay: string; code: string }> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  try {
    const video = document.createElement('video')
    video.srcObject = stream
    video.play()
    const videoContainer = requireElement<HTMLElement>('#scanner', HTMLElement)
    videoContainer.replaceChildren(video)
    return await new Promise<{ relay: string; code: string }>((resolve, _reject) => {
      const scan = (): void => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (context !== null) {
            context.drawImage(video, 0, 0)
            const result = jsQR(
              context.getImageData(0, 0, canvas.width, canvas.height).data,
              canvas.width,
              canvas.height,
            )
            if (result !== null) {
              try {
                resolve(parseQrPayload(result.data))
                return
              } catch {
                // Not our payload; keep scanning.
              }
            }
          }
        }
        requestAnimationFrame(scan)
      }
      requestAnimationFrame(scan)
    })
  } finally {
    stream.getTracks().forEach((track) => { track.stop() })
  }
}

function pairScreen(): void {
  render(`
    <h1>远程控制 dsh</h1>
    <p>在电脑上打开 设置 → 插件 → 远程控制，扫码或输入配对码。</p>
    <button id="scan">扫码连接</button>
    <div id="scanner"></div>
    <input id="relay" placeholder="中继地址 wss://…" value="${escapeHtml(localStorage.getItem('relay') ?? '')}" />
    <input id="code" placeholder="6 位配对码" inputmode="numeric" maxlength="6" />
    <button id="pair">连接</button>
    <p id="status"></p>
  `)
  const status = requireElement<HTMLElement>('#status', HTMLElement)

  const connect = (relay: string, code: string): void => {
    void (async () => {
      try {
        if (relay.length === 0 || code.length !== 6) {
          status.textContent = '请填写中继地址和 6 位配对码'
          return
        }
        localStorage.setItem('relay', relay)
        status.textContent = '连接中…'
        const { socket, reply } = await connectAndExchange(relay, (socket) => {
          socket.send(serializeMessage({ type: 'pair', payload: { pairingCode: code } }))
        })
        if (reply.type === 'error') {
          status.textContent = (reply.payload as { message: string }).message
          socket.close()
          return
        }
        const payload = reply.payload as { token: string; deviceId: string }
        localStorage.setItem(CONNECTION_KEY, JSON.stringify({ relay, token: payload.token } satisfies StoredConnection))
        session = { socket, token: payload.token, deviceId: payload.deviceId }
        bindSession(socket)
        void inventoryScreen()
      } catch (error: unknown) {
        status.textContent = error instanceof Error ? error.message : String(error)
      }
    })()
  }

  requireElement<HTMLButtonElement>('#pair', HTMLButtonElement).addEventListener('click', () => {
    connect(
      requireElement<HTMLInputElement>('#relay', HTMLInputElement).value.trim(),
      requireElement<HTMLInputElement>('#code', HTMLInputElement).value.trim(),
    )
  })
  requireElement<HTMLButtonElement>('#scan', HTMLButtonElement).addEventListener('click', () => {
    status.textContent = '正在打开摄像头…'
    void scanQr().then(
      ({ relay, code }) => {
        requireElement<HTMLInputElement>('#relay', HTMLInputElement).value = relay
        requireElement<HTMLInputElement>('#code', HTMLInputElement).value = code
        connect(relay, code)
      },
      () => { status.textContent = '无法打开摄像头或未识别到二维码' },
    )
  })
}

/** Resume a stored session: connect and present the token instead of pairing. */
function resume(): void {
  const raw = localStorage.getItem(CONNECTION_KEY)
  if (raw === null) {
    pairScreen()
    return
  }
  let stored: StoredConnection
  try {
    stored = JSON.parse(raw) as StoredConnection
  } catch {
    localStorage.removeItem(CONNECTION_KEY)
    pairScreen()
    return
  }
  render('<h1>正在恢复连接…</h1><p id="status"></p>')
  const status = requireElement<HTMLElement>('#status', HTMLElement)
  void connectAndExchange(stored.relay, (socket) => {
    socket.send(serializeMessage({ type: 'resume', payload: { token: stored.token } }))
  }).then(
    ({ socket, reply }) => {
      if (reply.type === 'error') {
        // The token was revoked or the relay lost it; pair again.
        localStorage.removeItem(CONNECTION_KEY)
        socket.close()
        pairScreen()
        return
      }
      const payload = reply.payload as { token: string; deviceId: string }
      session = { socket, token: payload.token, deviceId: payload.deviceId }
      bindSession(socket)
      runScreen(inventoryScreen, resume)
    },
    (error: unknown) => {
      status.textContent = error instanceof Error ? error.message : String(error)
      pairScreen()
    },
  )
}

async function inventoryScreen(): Promise<void> {
  const result = await request('plugin.list', {}) as {
    entries: Array<{ entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }>
  }
  render(`
    <h1>插件清单</h1>
    <ul>
      ${result.entries.map(entry => `
        <li>
          <strong>${escapeHtml(entry.moduleName)}</strong>
          <span>${entry.enabled ? '已启用' : '已禁用'}</span>
        </li>`).join('')}
    </ul>
    <button id="sessions">打开会话</button>
    <button id="settings">打开设置</button>
    <button id="back">重新配对</button>
  `)
  requireElement<HTMLButtonElement>('#sessions', HTMLButtonElement).addEventListener('click', () => { runScreen(sessionsScreen, inventoryScreen) })
  requireElement<HTMLButtonElement>('#settings', HTMLButtonElement).addEventListener('click', () => { runScreen(settingsScreen, inventoryScreen) })
  requireElement<HTMLButtonElement>('#back', HTMLButtonElement).addEventListener('click', () => {
    session?.socket.close()
    session = undefined
    localStorage.removeItem(CONNECTION_KEY)
    pairScreen()
  })
}

/** Session list: open a conversation, create a new session, or delete one the phone created. */
async function sessionsScreen(): Promise<void> {
  const list = await request('sessions.list', {}) as {
    sessions: Array<{ sessionId: string; title: string; seq: number }>
  }
  render(`
    <h1>会话</h1>
    <ul id="session-list">
      ${list.sessions.map(item => `
        <li>
          <button class="session-open" data-id="${escapeHtml(item.sessionId)}">${escapeHtml(item.title)}</button>
          <button class="session-delete" data-id="${escapeHtml(item.sessionId)}">删除</button>
        </li>`).join('')}
    </ul>
    <button id="create-session">新建会话</button>
    <button id="back">返回</button>
  `)
  for (const button of document.querySelectorAll<HTMLButtonElement>('.session-open')) {
    button.addEventListener('click', () => {
      const id = button.dataset.id
      if (id !== undefined) runScreen(conversationScreen.bind(null, id), sessionsScreen)
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.session-delete')) {
    button.addEventListener('click', () => {
      const id = button.dataset.id
      if (id !== undefined) {
        void request('sessions.delete', { sessionId: id }).then(
          () => { runScreen(sessionsScreen, inventoryScreen) },
          (error: unknown) => { failRow(`删除失败: ${error instanceof Error ? error.message : String(error)}`, () => { runScreen(sessionsScreen, inventoryScreen) }) },
        )
      }
    })
  }
  requireElement<HTMLButtonElement>('#create-session', HTMLButtonElement).addEventListener('click', () => {
    void request('sessions.create', {}).then(
      (result) => {
        const { sessionId } = result as { sessionId: string }
        runScreen(conversationScreen.bind(null, sessionId), sessionsScreen)
      },
      (error: unknown) => { failRow(`创建失败: ${error instanceof Error ? error.message : String(error)}`, () => { runScreen(sessionsScreen, inventoryScreen) }) },
    )
  })
  requireElement<HTMLButtonElement>('#back', HTMLButtonElement).addEventListener('click', () => { runScreen(inventoryScreen, resume) })
}

function escapeHtml(text: unknown): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Persistent socket listener while a conversation is open; removed on leave. */
let chatListener: ((event: MessageEvent) => void) | undefined

/** Run a screen load; a failure renders an error row with a back path instead of hanging. */
function runScreen(load: () => Promise<void>, back: () => void | Promise<void>): void {
  void load().catch((error: unknown) => {
    failRow(error, back)
  })
}

/** Render a one-off failure row with a back button. */
function failRow(message: unknown, back: () => void | Promise<void>): void {
  render(`<p>${escapeHtml(message instanceof Error ? message.message : String(message))}</p><button id="back">返回</button>`)
  document.querySelector('#back')?.addEventListener('click', () => { void back() })
}

/** A stream that never ends must not lock the composer forever. */
const STREAM_TIMEOUT_MS = 300_000

/** Wire roles are mapped through a whitelist before entering a class attribute. */
function roleClass(role: string): string {
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : 'assistant'
}

/** One conversation: load history, send messages, and stream the assistant reply via `event` pushes. */
async function conversationScreen(sessionId: string): Promise<void> {
  if (session === undefined) { pairScreen(); return }
  const socket = session.socket
  const messages: Array<{ role: 'user' | 'assistant'; text: string } | { role: 'tool'; name: string; error?: string; result?: string }> = []
  let streaming = false
  let streamTimer: number | undefined
  /** The session the current stream belongs to; other sessions' pushes are ignored. */
  let streamSessionId: string | undefined

  const history = await request('chat.history', { sessionId }) as { messages: typeof messages }
  messages.push(...history.messages)
  const catalog = await request('models.list', {}) as {
    groups: Array<{ provider: string; models: string[] }>
    current?: { provider: string; model: string }
  }
  const modelOptions = catalog.groups.flatMap(group => group.models.map(model => `${group.provider}/${model}`))
  const currentModel = catalog.current === undefined ? '' : `${catalog.current.provider}/${catalog.current.model}`
  const statsResult = await request('chat.stats', { sessionId }) as {
    stats: { turns: number; steps: number; decodeTokens: number } | null
  }
  const statsLine = statsResult.stats === null
    ? ''
    : `<p class="chat-stats">轮次 ${escapeHtml(statsResult.stats.turns)} · 步骤 ${escapeHtml(statsResult.stats.steps)} · 输出 ${escapeHtml(statsResult.stats.decodeTokens)} tokens</p>`
  render(`
    <h1>会话 ${escapeHtml(sessionId.slice(0, 8))}…</h1>
    ${statsLine}
    <select id="model-select">
      ${modelOptions.map(option => `<option value="${escapeHtml(option)}"${option === currentModel ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
    </select>
    <div id="chat-log"></div>
    <input id="chat-input" placeholder="输入消息…" />
    <button id="chat-send">发送</button>
    <button id="back">返回</button>
  `)
  requireElement<HTMLSelectElement>('#model-select', HTMLSelectElement).addEventListener('change', (event) => {
    const [provider, model] = (event.target as HTMLSelectElement).value.split('/')
    if (provider === undefined || model === undefined) return
    void request('models.set', { sessionId, provider, model }).catch(() => { /* selection is advisory */ })
  })

  const log = requireElement<HTMLElement>('#chat-log', HTMLElement)
  const renderLog = (): void => {
    log.innerHTML = messages.map((message) => {
      if (message.role === 'tool') {
        const state = message.error === undefined ? '' : `（失败: ${escapeHtml(message.error)}）`
        const detail = message.result === undefined ? '' : `<br>${escapeHtml(message.result)}`
        return `<p class="chat-tool"><strong>工具 ${escapeHtml(message.name)}</strong>${state}${detail}</p>`
      }
      return `<p class="chat-${roleClass(message.role)}"><strong>${message.role === 'user' ? '我' : 'dsh'}</strong> ${escapeHtml(message.text)}</p>`
    }).join('')
    log.scrollTop = log.scrollHeight
  }

  chatListener = (event: MessageEvent): void => {
    let message: Envelope
    try {
      message = parseMessage(String(event.data))
    } catch {
      return
    }
    if (message.type !== 'event') return
    const { event: name, payload } = message.payload as {
      event: string
      payload: { sessionId?: string; text?: string; code?: string; message?: string }
    }
    if (name === 'chat/start') {
      // The relay broadcasts every bound client's streams; keep only ours.
      if (payload.sessionId !== sessionId) return
      streamSessionId = sessionId
      messages.push({ role: 'assistant', text: '' })
      streaming = true
      if (streamTimer !== undefined) clearTimeout(streamTimer)
      streamTimer = window.setTimeout(() => { streaming = false }, STREAM_TIMEOUT_MS)
      renderLog()
    } else if (name === 'chat/chunk' || name === 'chat/done') {
      if (streamSessionId !== sessionId) return
      let last = messages[messages.length - 1]
      if (last === undefined || last.role !== 'assistant') {
        messages.push({ role: 'assistant', text: '' })
        last = messages[messages.length - 1]
      }
      if (last !== undefined && last.role === 'assistant') {
        last.text = name === 'chat/done' ? (payload.text ?? last.text) : last.text + (payload.text ?? '')
      }
      if (name === 'chat/done') {
        streaming = false
        if (streamTimer !== undefined) clearTimeout(streamTimer)
        streamTimer = undefined
      }
      renderLog()
    } else if (name === 'chat/error') {
      if (streamSessionId !== sessionId) return
      const last = messages[messages.length - 1]
      if (last !== undefined && last.role === 'assistant') last.text = `错误: ${payload.message ?? payload.code ?? '未知'}`
      streaming = false
      if (streamTimer !== undefined) clearTimeout(streamTimer)
      streamTimer = undefined
      renderLog()
    }
  }
  socket.addEventListener('message', chatListener)

  const send = (): void => {
    const input = requireElement<HTMLInputElement>('#chat-input', HTMLInputElement)
    const text = input.value.trim()
    if (text.length === 0 || streaming) return
    messages.push({ role: 'user', text })
    input.value = ''
    renderLog()
    void request('chat.send', { text, sessionId })
      .catch((error: unknown) => {
        messages.push({ role: 'assistant', text: `发送失败: ${error instanceof Error ? error.message : String(error)}` })
        renderLog()
      })
  }

  requireElement<HTMLButtonElement>('#chat-send', HTMLButtonElement).addEventListener('click', send)
  requireElement<HTMLInputElement>('#chat-input', HTMLInputElement).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send()
  })
  requireElement<HTMLButtonElement>('#back', HTMLButtonElement).addEventListener('click', () => {
    if (chatListener !== undefined) socket.removeEventListener('message', chatListener)
    chatListener = undefined
    runScreen(sessionsScreen, inventoryScreen)
  })
}

async function settingsScreen(): Promise<void> {
  const result = await request('settings.describe', {}) as {
    namespaces: Array<{ ns: string; schema: unknown; value: unknown }>
  }
  render(`
    <h1>设置</h1>
    <pre>${escapeHtml(JSON.stringify(result.namespaces, null, 2))}</pre>
    <button id="back">返回</button>
  `)
  requireElement<HTMLButtonElement>('#back', HTMLButtonElement).addEventListener('click', () => { runScreen(inventoryScreen, resume) })
}

resume()
