import { expect, test } from 'vitest'
import * as c from '../../src/content.ts'
import { decodeEmail, encodeEmail } from '../../src/page/email.ts'

const address = `${c.email.user}@${c.email.domain}`

test('the encoded address reads back as the address', () => {
  expect(decodeEmail(encodeEmail(c.email))).toBe(address)
  expect(decodeEmail(encodeEmail({ user: 'a.b', domain: 'c.example.org' }))).toBe('a.b@c.example.org')
})

test('the encoded address is not an address, nor the address backwards', () => {
  const code = encodeEmail(c.email)
  expect(code).not.toContain('@')
  expect(code).not.toContain(c.email.user)
  expect(code).not.toContain(c.email.domain)
})
