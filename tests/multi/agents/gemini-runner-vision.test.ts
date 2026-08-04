import { describe, it, expect } from 'vitest'
import { runWithGeminiTools } from '../../../src/multi/agents/gemini-runner.js'

function makeGemini(capture: { contents?: any }) {
  return {
    models: {
      async generateContent(args: any) {
        capture.contents = args.contents
        return {
          candidates: [
            { content: { parts: [{ text: 'ok, I see it' }] } },
          ],
          usageMetadata: { totalTokenCount: 3 },
        }
      },
    },
  } as any
}

describe('runWithGeminiTools — Fix5 inlineParts', () => {
  it('forwards inlineParts into the current user turn', async () => {
    const cap: any = {}
    const fakeGemini = makeGemini(cap)
    const agent = { instruction: '', model: 'gemini-2.5-flash', tools: [] }
    const res = await runWithGeminiTools(
      fakeGemini,
      agent,
      'describe this photo',
      [],
      {
        inlineParts: [
          { inlineData: { mimeType: 'image/jpeg', data: 'BASE64DATA' } },
        ],
      },
    )
    expect(res.text).toBe('ok, I see it')
    const lastContent = cap.contents[cap.contents.length - 1]
    expect(lastContent.role).toBe('user')
    const parts = lastContent.parts
    expect(parts[0]).toEqual({ text: 'describe this photo' })
    expect(parts[1]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'BASE64DATA' },
    })
  })

  it('without inlineParts behaves exactly like before', async () => {
    const cap: any = {}
    const agent = { instruction: '', model: 'gemini-2.5-flash', tools: [] }
    await runWithGeminiTools(makeGemini(cap), agent, 'hi', [])
    const lastContent = cap.contents[cap.contents.length - 1]
    expect(lastContent.parts).toEqual([{ text: 'hi' }])
  })

  it('multiple inlineParts all forwarded', async () => {
    const cap: any = {}
    const agent = { instruction: '', model: 'gemini-2.5-flash', tools: [] }
    await runWithGeminiTools(makeGemini(cap), agent, 'desc', [], {
      inlineParts: [
        { inlineData: { mimeType: 'image/jpeg', data: 'A' } },
        { inlineData: { mimeType: 'image/png', data: 'B' } },
        { inlineData: { mimeType: 'image/jpeg', data: 'C' } },
      ],
    })
    const parts = cap.contents[cap.contents.length - 1].parts
    expect(parts).toHaveLength(4) // text + 3 inline
    expect(parts[1].inlineData.data).toBe('A')
    expect(parts[3].inlineData.data).toBe('C')
  })

  it('very large inline payload passes through without crash', async () => {
    const cap: any = {}
    const agent = { instruction: '', model: 'gemini-2.5-flash', tools: [] }
    const bigData = 'x'.repeat(15 * 1024 * 1024) // 15 MB base64 string
    await runWithGeminiTools(makeGemini(cap), agent, 'hi', [], {
      inlineParts: [{ inlineData: { mimeType: 'image/jpeg', data: bigData } }],
    })
    const parts = cap.contents[cap.contents.length - 1].parts
    expect(parts[1].inlineData.data.length).toBe(bigData.length)
  })
})
