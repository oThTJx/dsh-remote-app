import { describe, expect, it } from 'vitest'
import { parseQrPayload } from '../src/qr-payload.ts'

describe('parseQrPayload', () => {
  it('parses the relay URL and 6-digit code', () => {
    expect(parseQrPayload('relay=ws%3A%2F%2F192.168.1.5%3A8787&code=123456')).toEqual({
      relay: 'ws://192.168.1.5:8787',
      code: '123456',
    })
  })

  it('rejects a missing relay or malformed code', () => {
    expect(() => parseQrPayload('relay=ws%3A%2F%2Fx&code=12')).toThrow(/invalid QR payload/)
    expect(() => parseQrPayload('code=123456')).toThrow(/invalid QR payload/)
    expect(() => parseQrPayload('relay=ws%3A%2F%2Fx')).toThrow(/invalid QR payload/)
  })

  it('rejects non-WebSocket relay schemes and oversized relays', () => {
    expect(() => parseQrPayload('relay=http%3A%2F%2Fevil.example&code=123456')).toThrow(/invalid QR payload/)
    expect(() => parseQrPayload('relay=javascript%3Aalert(1)&code=123456')).toThrow(/invalid QR payload/)
    expect(() => parseQrPayload(`relay=${'a'.repeat(600)}&code=123456`)).toThrow(/invalid QR payload/)
  })
})
