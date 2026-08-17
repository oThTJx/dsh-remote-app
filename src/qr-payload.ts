/** One decoded QR payload: the phone-reachable relay URL plus the 6-digit code. */
export interface QrPayload {
  relay: string
  code: string
}

/** Parse the host's QR payload (`relay=<url>&code=<6位码>`), rejecting anything else. */
export function parseQrPayload(text: string): QrPayload {
  const params = new URLSearchParams(text.trim())
  const relay = params.get('relay')
  const code = params.get('code')
  if (relay === null || code === null || !/^\d{6}$/.test(code)) {
    throw new Error('invalid QR payload')
  }
  return { relay, code }
}
