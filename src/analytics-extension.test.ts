import { describe, it, expect } from 'vitest'
import { getIdentifyProperties } from './analytics-extension.js'

describe('getIdentifyProperties', () => {
    it('sets email when distinct id looks like an email', () => {
        expect(getIdentifyProperties('user@example.com')).toEqual({ email: 'user@example.com' })
    })

    it('does not set email for non-email distinct ids', () => {
        expect(getIdentifyProperties('pi:84aab8dd')).toEqual({})
    })

    it('does not set email for values with spaces', () => {
        expect(getIdentifyProperties('user @example.com')).toEqual({})
    })
})
