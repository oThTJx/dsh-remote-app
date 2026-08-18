import { parseMessage, serializeMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'
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

let session: Session | undefined

function render(html: string): void {
  app.innerHTML = html
}

function nextMessage(socket: WebSocket, match: (message: Envelope) => boolean): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent): void => {
      let message: Envelope
      try {
        message = parseMessage(String(event.data))
      } catch {
        return
      }
      if (match(message)) {
        socket.removeEventListener('message', handler)
        resolve(message)
      }
    }
    socket.addEventListener('message', handler)
    socket.addEventListener('error', () => { reject(new Error('websocket error')) }, { once: true })
  })
}

async function request(method: string, params: unknown): Promise<unknown> {
  if (session === undefined) throw new Error('未连接')
  const id = crypto.randomUUID()
  session.socket.send(serializeMessage({
    type: 'request',
    id,
    deviceId: session.deviceId,
    payload: { token: session.token, method, params },
  }))
  const reply = await nextMessage(
    session.socket,
    message => message.id === id && (message.type === 'response' || message.type === 'error'),
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
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() })
    socket.addEventListener('error', () => { reject(new Error('无法连接中继')) })
  })
  send(socket)
  const reply = await nextMessage(
    socket,
    message => message.type === 'pair-result' || message.type === 'error',
  )
  return { socket, reply }
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
    <input id="relay" placeholder="中继地址 wss://…" value="${localStorage.getItem('relay') ?? ''}" />
    <input id="code" placeholder="6 位配对码" inputmode="numeric" maxlength="6" />
    <button id="pair">连接</button>
    <p id="status"></p>
  `)
  const status = requireElement<HTMLElement>('#status', HTMLElement)

  const connect = (relay: string, code: string): void => {
    void (async () => {
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
      void inventoryScreen()
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
      void inventoryScreen()
    },
    () => {
      status.textContent = '无法连接中继'
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
          <strong>${entry.moduleName}</strong>
          <span>${entry.enabled ? '已启用' : '已禁用'}</span>
        </li>`).join('')}
    </ul>
    <button id="sessions">打开会话</button>
    <button id="settings">打开设置</button>
    <button id="back">重新配对</button>
  `)
  requireElement<HTMLButtonElement>('#sessions', HTMLButtonElement).addEventListener('click', () => { void sessionsScreen() })
  requireElement<HTMLButtonElement>('#settings', HTMLButtonElement).addEventListener('click', () => { void settingsScreen() })
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
          <button class="session-open" data-id="${item.sessionId}">${escapeHtml(item.title)}</button>
          <button class="session-delete" data-id="${item.sessionId}">删除</button>
        </li>`).join('')}
    </ul>
    <button id="create-session">新建会话</button>
    <button id="back">返回</button>
  `)
  for (const button of document.querySelectorAll<HTMLButtonElement>('.session-open')) {
    button.addEventListener('click', () => {
      const id = button.dataset.id
      if (id !== undefined) void conversationScreen(id)
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.session-delete')) {
    button.addEventListener('click', () => {
      const id = button.dataset.id
      if (id !== undefined) {
        void request('sessions.delete', { sessionId: id }).then(
          () => { void sessionsScreen() },
          (error: unknown) => { render(`<p>删除失败: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button id="back">返回</button>`); document.querySelector('#back')?.addEventListener('click', () => { void sessionsScreen() }) },
        )
      }
    })
  }
  requireElement<HTMLButtonElement>('#create-session', HTMLButtonElement).addEventListener('click', () => {
    void request('sessions.create', {}).then(
      (result) => { const { sessionId } = result as { sessionId: string }; void conversationScreen(sessionId) },
      (error: unknown) => { render(`<p>创建失败: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button id="back">返回</button>`); document.querySelector('#back')?.addEventListener('click', () => { void sessionsScreen() }) },
    )
  })
  requireElement<HTMLButtonElement>('#back', HTMLButtonElement).addEventListener('click', () => { void inventoryScreen() })
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Persistent socket listener while a conversation is open; removed on leave. */
let chatListener: ((event: MessageEvent) => void) | undefined

/** One conversation: load history, send messages, and stream the assistant reply via `event` pushes. */
async function conversationScreen(sessionId: string): Promise<void> {
  if (session === undefined) { pairScreen(); return }
  const socket = session.socket
  const messages: Array<{ role: 'user' | 'assistant'; text: string } | { role: 'tool'; name: string; error?: string; result?: string }> = []
  let streaming = false

  const history = await request('chat.history', { sessionId }) as { messages: typeof messages }
  messages.push(...history.messages)
  const catalog = await request('models.list', {}) as {
    groups: Array<{ provider: string; models: string[] }>
    current?: { provider: string; model: string }
  }
  const modelOptions = catalog.groups.flatMap(group => group.models.map(model => `${group.provider}/${model}`))
  const currentModel = catalog.current === undefined ? '' : `${catalog.current.provider}/${catalog.current.model}`
  render(`
    <h1>会话 ${escapeHtml(sessionId.slice(0, 8))}…</h1>
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
      return `<p class="chat-${message.role}"><strong>${message.role === 'user' ? '我' : 'dsh'}</strong> ${escapeHtml(message.text)}</p>`
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
      payload: { text?: string; code?: string; message?: string }
    }
    if (name === 'chat/start') {
      messages.push({ role: 'assistant', text: '' })
      streaming = true
      renderLog()
    } else if (name === 'chat/chunk' || name === 'chat/done') {
      const last = messages[messages.length - 1]
      if (last !== undefined && last.role === 'assistant') {
        last.text = name === 'chat/done' ? (payload.text ?? last.text) : last.text + (payload.text ?? '')
      }
      if (name === 'chat/done') streaming = false
      renderLog()
    } else if (name === 'chat/error') {
      const last = messages[messages.length - 1]
      if (last !== undefined && last.role === 'assistant') last.text = `错误: ${payload.message ?? payload.code ?? '未知'}`
      streaming = false
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
    void sessionsScreen()
  })
}

async function settingsScreen(): Promise<void> {
  const result = await request('settings.describe', {}) as {
    namespaces: Array<{ ns: string; schema: unknown; value: unknown }>
  }
  render(`
    <h1>设置</h1>
    <pre>${JSON.stringify(result.namespaces, null, 2)}</pre>
    <button id="back">返回</button>
  `)
  requireElement<HTMLButtonElement>('#back', HTMLButtonElement).addEventListener('click', () => { void inventoryScreen() })
}

resume()
