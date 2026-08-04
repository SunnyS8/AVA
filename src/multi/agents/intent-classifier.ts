import type { GoogleGenAI } from '@google/genai'
import { log } from '../observability/logger.js'

/**
 * Semantic intent classifier — runs ONE small Gemini Flash call before the
 * main agent turn to decide whether the user's message requires a forced
 * tool call, a clarifying question, or normal free-form processing.
 *
 * Why this exists: regex/keyword matching can't catch all the ways a user
 * asks for a selfie ("а можешь себя сфоткать?", "хочу тебя увидеть"), and
 * can't ask back when intent is ambiguous ("прикинь как ты выглядишь" —
 * unclear if they want a photo or just chat). LLMs reading a long history
 * can also drift ("я уже отправляла, помнишь?") which the main agent loop
 * can't recover from. A dedicated classifier with a tight, single-purpose
 * prompt and no history sees only the latest user message and decides.
 *
 * Output is one of three actions:
 *   - { action: 'force_tool', tool, args }  → main turn forces this tool
 *   - { action: 'clarify', question }       → router replies directly, skips main turn
 *   - { action: 'normal' }                  → main turn runs unconstrained
 */

export type ClassifierAction =
  | { action: 'force_tool'; tool: string; args?: Record<string, any> }
  | { action: 'clarify'; question: string }
  | { action: 'normal' }

const CLASSIFIER_MODEL = 'gemini-2.5-flash'

const SYSTEM = `Ты — классификатор намерений пользователя для AI-ассистентки Betsy.

Тебе на вход даётся ПОСЛЕДНЕЕ сообщение пользователя (или несколько склеенных коротких подряд). Ты должна понять что пользователь хочет, и вернуть СТРОГО ОДИН JSON-объект — без обрамляющего текста, без markdown.

Доступные действия:

1. **force_tool: generate_selfie** — пользователь хочет получить фото/селфи Betsy. Триггеры по смыслу: "пришли селфи", "скинь фотку", "покажи себя", "хочу тебя увидеть", "сфоткайся", "а как ты выглядишь?", "ещё фоточку", "ну где?" (если предыдущий контекст явно про фото) и любые синонимы. Если в тексте есть подсказка о сцене — извлеки её в args.scene на естественном языке. Если сцены нет — оставь scene пустым, бэкенд подставит дефолт. Пример: { "action": "force_tool", "tool": "generate_selfie", "args": { "scene": "пьёт кофе в кафе" } }

2. **force_tool: google_search** — пользователь хочет актуальную информацию из интернета: новости, цены, ссылки, погода, расписания, проверка фактов. Извлеки запрос в args.query. Пример: { "action": "force_tool", "tool": "google_search", "args": { "query": "курс доллара сегодня" } }

3. **force_tool: set_reminder** — пользователь явно просит НАПОМНИТЬ ему о чём-то в будущем. Триггеры: "напомни", "напомни мне", "напомни завтра", "поставь напоминание", "не забудь напомнить" + указание ЧТО и/или КОГДА. Извлеки текст напоминания в args.text (то о чём напомнить, без слова "напомни"), и время в args.fire_at в естественной форме как сказал юзер ("завтра в 10:30", "через час", "в пятницу утром") — бэкенд распарсит. Если время вообще не указано, оставь fire_at пустым. Пример: { "action": "force_tool", "tool": "set_reminder", "args": { "text": "узнать где Аня с Лизой", "fire_at": "завтра в 10:30" } }. ВАЖНО: НЕ используй для общих фраз "не забудь", "имей в виду" — только когда явное "напомни/напоминание".

4. **normal** — ВСЁ остальное. Любой диалог, любой ответ, любое короткое сообщение ("да", "нет", "ага", "и что", "а?", "ну?"), любая эмоция, любой вопрос. В этом случае управление передаётся основному агенту с полной историей — он САМ поймёт контекст и ответит правильно. Пример: { "action": "normal" }

ВАЖНО:
- Возвращай ТОЛЬКО JSON, без блоков кода, без комментариев
- Для force_tool: generate_selfie / set_reminder — даже если в истории были отказы или ошибки, ВСЁ РАВНО force_tool. История не твоя забота.
- Не используй force_tool для случаев когда юзер просто упоминает фото в контексте ("у меня есть фотка кота") — только когда он хочет ПОЛУЧИТЬ селфи Betsy.
- КРИТИЧНО: действие 'clarify' УДАЛЕНО. Не пытайся переспрашивать юзера — ты НЕ видишь историю диалога, и твой переспрос будет глупым. Если непонятно — всегда возвращай 'normal' и дай основному агенту (у которого есть вся история) разобраться самому.
- Если сомневаешься между force_tool и normal — выбирай normal. Force_tool только когда 100% уверена.`

/**
 * Deterministic short-circuit for Telegram native slash commands.
 * When the user taps an entry from the bot menu (see TelegramAdapter.start
 * → setMyCommands), Telegram sends the literal text "/command" — no need to
 * roundtrip through Gemini for these. Each slash maps directly to a force_tool
 * or a deterministic action.
 * Returns undefined if the message is not a slash command (or not known).
 */
function classifySlashCommand(msg: string): ClassifierAction | undefined {
  const trimmed = msg.trim()
  if (!trimmed.startsWith('/')) return undefined
  // Strip leading slash, optional bot suffix (/cmd@BotName), optional args.
  const m = trimmed.match(/^\/([a-zA-Z_]+)(?:@[\w_]+)?(?:\s+(.*))?$/)
  if (!m) return undefined
  const cmd = m[1].toLowerCase()
  const rest = m[2]?.trim() ?? ''
  switch (cmd) {
    case 'start':
    case 'help':
      // Fall through to the main agent — it has persona + history and will
      // produce a natural greeting / help answer. We don't hard-code text
      // here because it would override the persona voice.
      return { action: 'normal' }
    case 'tweaks':
      return { action: 'force_tool', tool: 'list_persona_tweaks', args: {} }
    case 'candidates':
      return { action: 'force_tool', tool: 'list_skill_candidates', args: {} }
    case 'skills':
      return { action: 'force_tool', tool: 'list_skills', args: {} }
    case 'reminders':
      return { action: 'force_tool', tool: 'list_reminders', args: {} }
    case 'selfie':
      return {
        action: 'force_tool',
        tool: 'generate_selfie',
        args: { scene: rest },
      }
    case 'integrations':
      return { action: 'force_tool', tool: 'list_integrations', args: {} }
    default:
      return undefined
  }
}

export async function classifyIntent(
  gemini: GoogleGenAI,
  userMessage: string,
): Promise<ClassifierAction> {
  if (!userMessage || userMessage.trim().length === 0) {
    return { action: 'normal' }
  }
  // Deterministic slash-command routing (zero LLM cost).
  const slashMatch = classifySlashCommand(userMessage)
  if (slashMatch) {
    log().info('classifier: slash short-circuit', {
      action: slashMatch.action,
      tool: 'tool' in slashMatch ? slashMatch.tool : undefined,
    })
    return slashMatch
  }
  try {
    const t0 = Date.now()
    const resp: any = await gemini.models.generateContent({
      model: CLASSIFIER_MODEL,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        // 1024 because Gemini 2.5 thinking tokens count against the output
        // budget. Observed in prod (2026-05-25): 200-token cap chopped the
        // JSON mid-args, regex fallback couldn't recover, classifier
        // downgraded force_tool to normal and the selfie tool was never
        // invoked. The JSON itself is still ~80 tokens; the rest is slack
        // for thinking. Classifier runs once per inbound, cost is negligible.
        maxOutputTokens: 1024,
        temperature: 0.0,
      } as any,
    })
    const text =
      (resp as any).text ??
      (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
      ''
    const ms = Date.now() - t0
    log().info('classifier: response', { ms, raw: String(text).slice(0, 300) })
    if (!text) return { action: 'normal' }
    let parsed: any
    try {
      parsed = JSON.parse(String(text))
    } catch {
      // Try to extract JSON from possibly-wrapped text
      const m = String(text).match(/\{[\s\S]*\}/)
      if (m) {
        try {
          parsed = JSON.parse(m[0])
        } catch {
          // fallthrough to truncated-JSON recovery below
        }
      }
      // Truncated JSON recovery: classifier sometimes hits the output-token
      // cap mid-object, leaving us with `{"action":"force_tool", "tool":"x", "args":{`.
      // Extract `action`/`tool` via regex so we still get the force_tool
      // signal instead of downgrading to normal.
      if (!parsed) {
        const s = String(text)
        const actionMatch = s.match(/"action"\s*:\s*"([^"]+)"/)
        const toolMatch = s.match(/"tool"\s*:\s*"([^"]+)"/)
        if (actionMatch) {
          parsed = { action: actionMatch[1] }
          if (toolMatch) parsed.tool = toolMatch[1]
          // Args best-effort: scrape known fields used by current tools.
          const sceneMatch = s.match(/"scene"\s*:\s*"([^"]*)"/)
          const queryMatch = s.match(/"query"\s*:\s*"([^"]*)"/)
          if (sceneMatch || queryMatch) {
            parsed.args = {}
            if (sceneMatch) parsed.args.scene = sceneMatch[1]
            if (queryMatch) parsed.args.query = queryMatch[1]
          }
          log().warn('classifier: parsed truncated JSON via regex fallback', {
            recovered: { action: parsed.action, tool: parsed.tool },
          })
        }
      }
      if (!parsed) return { action: 'normal' }
    }

    if (parsed?.action === 'force_tool' && typeof parsed.tool === 'string') {
      return {
        action: 'force_tool',
        tool: parsed.tool,
        args: typeof parsed.args === 'object' ? parsed.args : undefined,
      }
    }
    // FIX6: clarify action is DEAD — classifier has no history so any
    // clarifying question is a blind guess. If LLM still emits clarify
    // (prompt drift / old cached model), downgrade to normal so the main
    // agent (which has full history) handles it.
    if (parsed?.action === 'clarify') {
      log().info('classifier: clarify downgraded to normal', {
        wouldHaveAsked: typeof parsed.question === 'string' ? parsed.question.slice(0, 80) : undefined,
      })
      return { action: 'normal' }
    }
    return { action: 'normal' }
  } catch (e) {
    log().warn('classifier: failed, falling back to normal', {
      error: e instanceof Error ? e.message : String(e),
    })
    return { action: 'normal' }
  }
}
