/**
 * OutboundDispatcher — cross-channel broadcast coordinator.
 *
 * After the engine sends a message in primary channel X, we mirror it into
 * every other channel that has a registered adapter for this workspace. This
 * gives the user a single unified conversation across desktop / Telegram /
 * Max — what you type on one device shows up on all the others.
 *
 * Two flavours of mirroring:
 *   - Desktop targets get a structured `message-from-other-channel` frame
 *     via DesktopAdapter.mirror() — the chat UI renders user/assistant
 *     bubbles natively using the message.role.
 *   - Non-desktop targets (Telegram, Max) get a plain text via the
 *     adapter's sendMessage. Since every message in these channels visually
 *     comes from "the bot", user-side mirrors are prefixed with "[ты]: " so
 *     the user can tell their own input apart from Betsy's reply when
 *     scrolling the TG/Max chat from another device.
 *
 * Adapters do NOT import each other. Telegram/Max never know about Desktop;
 * Desktop never knows about Telegram. Only this dispatcher knows everyone.
 */
import { randomUUID } from 'node:crypto'
import type { Message, MessageChannel, MessageRole } from '../chat/types.js'
import type { ChannelName, OutboundMessage } from './base.js'

export interface DesktopMirrorTarget {
  readonly name: 'desktop'
  mirror(workspaceId: string, message: Message): Promise<void>
}

/**
 * Adapter shape needed from non-desktop channels — name + sendMessage.
 * Compatible with existing ChannelAdapter; we accept any adapter and skip
 * the desktop one at registration time to keep the type narrow.
 */
export interface PlainChannelTarget {
  readonly name: ChannelName
  sendMessage(msg: OutboundMessage): Promise<{ externalMessageId?: number | string }>
}

export interface AfterPrimarySendInput {
  workspaceId: string
  primaryChannel: MessageChannel
  role: MessageRole
  text: string
  /**
   * Per-workspace lookup so non-desktop adapters know where to deliver.
   * For Telegram: workspace.ownerTgId. For Max: workspace.ownerMaxId.
   * If null for a channel, that channel is skipped (user not connected there).
   */
  recipientChatIds: Partial<Record<Exclude<MessageChannel, 'desktop'>, string | null>>
}

const USER_PREFIX = '[ты]: '

export class OutboundDispatcher {
  private desktops: DesktopMirrorTarget[] = []
  private plain: PlainChannelTarget[] = []

  registerDesktop(target: DesktopMirrorTarget): void {
    this.desktops.push(target)
  }

  registerPlain(target: PlainChannelTarget): void {
    if (target.name === 'desktop') return // desktop has its own mirror path
    this.plain.push(target)
  }

  async afterPrimarySend(input: AfterPrimarySendInput): Promise<void> {
    await Promise.all([
      this.mirrorToDesktops(input),
      this.mirrorToPlainChannels(input),
    ])
  }

  private async mirrorToDesktops(input: AfterPrimarySendInput): Promise<void> {
    if (input.primaryChannel === 'desktop') return // already in desktop; would echo
    if (this.desktops.length === 0) return
    const message: Message = {
      id: randomUUID(),
      role: input.role,
      text: input.text,
      channel: input.primaryChannel,
      createdAt: new Date().toISOString(),
    }
    await Promise.all(this.desktops.map((d) => d.mirror(input.workspaceId, message)))
  }

  private async mirrorToPlainChannels(input: AfterPrimarySendInput): Promise<void> {
    if (this.plain.length === 0) return
    const text =
      input.role === 'user' ? `${USER_PREFIX}${input.text}` : input.text
    await Promise.all(
      this.plain.map(async (target) => {
        if (target.name === 'desktop') return // belt+suspenders; registerPlain filters
        if (target.name === input.primaryChannel) return // would echo back to source
        const chatId = input.recipientChatIds[target.name]
        if (!chatId) return // user not connected on this channel
        try {
          await target.sendMessage({ chatId, text })
        } catch {
          // Swallow — mirror is best-effort. Don't fail the primary send if
          // a secondary channel hiccuped (e.g. TG rate limit).
        }
      }),
    )
  }
}
