// Fix3 — CoachAgent types.
//
// A PersonaTweakProposal is a minimal search-and-replace edit to a persona's
// personality_prompt, produced from negative feedback by the nightly Coach.

export type PersonaTweakStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface PersonaTweakProposal {
  id: string
  workspaceId: string
  rationale: string
  diff: { before: string; after: string }
  evidenceFeedbackIds: string[]
  status: PersonaTweakStatus
  createdAt: Date
  decidedAt?: Date
  expiresAt: Date
}

export interface CoachAnalysis {
  windowDays: number
  thumbsUp: number
  thumbsDown: number
  /** thumbsUp / (thumbsUp + thumbsDown), or 0 when there are no feedbacks. */
  ratio: number
  patternsFound: number
  proposalsCreated: number
  errors: string[]
}
