import type { BehaviorConfig } from './types.js'

export interface PersonaPresetAvatar {
  /** URL to a static image (CDN). Served to Windows-app for wizard + main window. */
  static: string
  /** Optional short voice sample for preview in persona picker. */
  voiceSample?: string
}

export interface PersonaPresetWizardLines {
  mode_intro: string
  mode_hosted_pitch?: string
  mode_selfhost_checklist: string[]
  mode_selfhost_hint: string

  tg_login_intro: string
  tg_login_waiting: string
  tg_login_success: string

  ssh_prompt: string
  ssh_test_ok: string
  install_progress: string
  install_done: string
  bot_token_prompt: string
  bot_webhook_ok: string

  wizard_complete: string
}

export interface PersonaPreset {
  id: string
  name: string
  gender: string | null
  voiceId: string
  defaultBehavior: BehaviorConfig
  biography: string
  defaultPersonalityPrompt: string
  avatar: PersonaPresetAvatar
  wizardLines: PersonaPresetWizardLines
}
