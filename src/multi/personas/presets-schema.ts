import { z } from 'zod'

const behaviorConfigSchema = z.object({
  voice: z.enum(['text_only', 'voice_on_reply', 'voice_always', 'auto']),
  selfie: z.enum(['never', 'on_request', 'special_moments', 'auto']),
  video: z.enum(['never', 'on_request', 'auto']),
})

const avatarSchema = z.object({
  static: z.string().url(),
  voiceSample: z.string().url().optional(),
})

const wizardLinesSchema = z.object({
  mode_intro: z.string().min(1),
  mode_hosted_pitch: z.string().optional(),
  mode_selfhost_checklist: z.array(z.string().min(1)).min(1),
  mode_selfhost_hint: z.string().min(1),

  tg_login_intro: z.string().min(1),
  tg_login_waiting: z.string().min(1),
  tg_login_success: z.string().min(1),

  ssh_prompt: z.string().min(1),
  ssh_test_ok: z.string().min(1),
  install_progress: z.string().min(1),
  install_done: z.string().min(1),
  bot_token_prompt: z.string().min(1),
  bot_webhook_ok: z.string().min(1),

  wizard_complete: z.string().min(1),
})

export const personaPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  name: z.string().min(1),
  gender: z.string().nullable(),
  voiceId: z.string().min(1),
  defaultBehavior: behaviorConfigSchema,
  biography: z.string().min(1),
  defaultPersonalityPrompt: z.string().min(1),
  avatar: avatarSchema,
  wizardLines: wizardLinesSchema,
})

export const personaPresetsArraySchema = z.array(personaPresetSchema)
