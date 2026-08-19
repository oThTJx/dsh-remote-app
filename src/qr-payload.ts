/** One decoded QR payload: the phone-reachable relay URL plus the 6-digit code. */
export interface QrPayload {
  relay: string
  code: string
}

/** Longest accepted relay address; QR payloads are short by construction. */
const MAX_RELAY_LENGTH = 512

/**
 * Parse the host's QR payload (`relay=<url>&code=<6位码>`), rejecting anything
 * else. The relay must be a `ws:`/`wss:` URL — the field flows into innerHTML
 * and then into WebSocket dials, so it is validated here rather than trusted.
 */
export function parseQrPayload(text: string): QrPayload {
  const params = new URLSearchParams(text.trim())
  const relay = params.get('relay')
  const code = params.get('code')
  if (relay === null || code === null || relay.length > MAX_RELAY_LENGTH || !/^\d{6}$/.test(code)) {
    throw new Error('invalid QR payload')
  }
  let url: URL
  try {
    url = new URL(relay)
  } catch {
    throw new Error('invalid QR payload')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('invalid QR payload')
  }
  return { relay, code }
}
