// Sim: verify inlineParts propagate from runner → gemini-runner → contents[].parts
import { runWithGeminiToolsStream } from '../agents/gemini-runner.js'

async function main() {
  const captured: any[] = []
  const mockGemini: any = {
    models: {
      generateContentStream: async (params: any) => {
        captured.push(params)
        async function* gen() {
          yield { text: 'мок ответ', candidates: [{ content: { parts: [{ text: 'мок ответ' }] } }] }
        }
        return gen()
      },
      generateContent: async (params: any) => {
        captured.push(params)
        return { text: 'мок ответ', candidates: [{ content: { parts: [{ text: 'мок ответ' }] } }] }
      },
    },
  }
  const fakePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2NgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  const res = await runWithGeminiToolsStream(
    mockGemini,
    { instruction: 'test', model: 'gemini-2.5-flash', tools: [] },
    'что на картинке?',
    [],
    { inlineParts: [{ inlineData: { mimeType: 'image/png', data: fakePngBase64 } }] },
  )
  let drained = ''
  for await (const chunk of res.textStream) drained = chunk
  await res.finalize()
  console.log('captured calls:', captured.length)
  const call = captured[0]
  if (!call) { console.error('FAIL: no call captured'); process.exit(1) }
  const contents = call.contents
  const lastUser = contents[contents.length - 1]
  const parts = lastUser.parts
  console.log('last user parts count:', parts.length)
  console.log('parts shape:', parts.map((p: any) => Object.keys(p)))
  const hasInline = parts.some((p: any) => p.inlineData && p.inlineData.data === fakePngBase64)
  if (!hasInline) {
    console.error('FAIL: inlineData not in parts')
    console.error(JSON.stringify(parts, null, 2).slice(0, 500))
    process.exit(1)
  }
  console.log('OK: inlineParts correctly reached gemini contents')
}
main().catch(e => { console.error('ERROR:', e); process.exit(1) })
