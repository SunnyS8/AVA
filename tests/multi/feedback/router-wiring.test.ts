import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  FeedbackRefStore,
  getFeedbackRefStore,
  __resetFeedbackRefStoreForTests,
} from '../../../src/multi/feedback/ref-store.js'
import { feedbackEnabled } from '../../../src/multi/channels/telegram.js'

/**
 * FIX2 — router-level wiring contract. The router is large and tightly coupled
 * to Postgres, runBetsyStream and channel adapters, so instead of spinning up
 * the whole thing we assert the invariants the router code path depends on:
 *
 *  1. `feedbackEnabled()` gates the keyboard attachment via env var.
 *  2. `FeedbackRefStore.newRefId()` produces ids matching the telegram regex
 *     (exactly 12 hex chars — the callback data parser hard-pins length).
 *  3. A freshly-created ref is retrievable by id and merges on update (the
 *     backfill of final `rawText` after the stream resolves).
 *
 * If any of these break, the stream-path refId plumbing will silently drop
 * feedback clicks in production.
 */
describe('router ↔ feedback wiring (FIX2)', () => {
  const OLD_ENV = process.env.BC_FEEDBACK_ENABLED
  beforeEach(() => {
    __resetFeedbackRefStoreForTests()
  })
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.BC_FEEDBACK_ENABLED
    else process.env.BC_FEEDBACK_ENABLED = OLD_ENV
  })

  it('feedbackEnabled() respects BC_FEEDBACK_ENABLED=1', () => {
    process.env.BC_FEEDBACK_ENABLED = '1'
    expect(feedbackEnabled()).toBe(true)
    process.env.BC_FEEDBACK_ENABLED = '0'
    expect(feedbackEnabled()).toBe(false)
    delete process.env.BC_FEEDBACK_ENABLED
    expect(feedbackEnabled()).toBe(false)
  })

  it('newRefId() yields 12 hex chars (telegram callback_data budget)', () => {
    for (let i = 0; i < 20; i++) {
      const id = FeedbackRefStore.newRefId()
      expect(id).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it('stream path: set initial ref, then backfill rawText on done()', () => {
    // This mirrors what src/multi/bot-router/router.ts does in the stream
    // branch (FIX2). If this test breaks, the router wiring is wrong.
    process.env.BC_FEEDBACK_ENABLED = '1'
    const store = getFeedbackRefStore()

    // 1. Router builds initial ref BEFORE the stream starts (rawText empty).
    const refId = FeedbackRefStore.newRefId()
    store.set(refId, {
      workspaceId: 'ws-1',
      channel: 'telegram',
      chatId: '999',
      rawText: '',
      userMessage: 'привет',
    })
    expect(store.get(refId)?.rawText).toBe('')
    expect(store.get(refId)?.userMessage).toBe('привет')

    // 2. Stream resolves. Router backfills rawText via .update(...).
    store.update(refId, { rawText: 'ну привет!' })
    expect(store.get(refId)?.rawText).toBe('ну привет!')
    // Other fields survive the merge.
    expect(store.get(refId)?.workspaceId).toBe('ws-1')
    expect(store.get(refId)?.userMessage).toBe('привет')
  })

  it('update() on unknown refId is a no-op (no crash when ref evicted)', () => {
    const store = getFeedbackRefStore()
    expect(() => store.update('deadbeef1234', { rawText: 'x' })).not.toThrow()
    expect(store.get('deadbeef1234')).toBeUndefined()
  })
})
