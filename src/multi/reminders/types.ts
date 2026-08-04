export type ReminderStatus = 'pending' | 'fired' | 'cancelled' | 'failed'

export interface Reminder {
  id: string
  workspaceId: string
  fireAt: Date
  text: string
  preferredChannel: 'telegram' | 'max' | 'desktop'
  status: ReminderStatus
  createdAt: Date
  decidedAt: Date | null
}

export interface CreateReminderInput {
  fireAt: Date
  text: string
  preferredChannel: 'telegram' | 'max' | 'desktop'
}
