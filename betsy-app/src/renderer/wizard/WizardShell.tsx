import type { ReactNode } from 'react'
import type { WizardState } from '../../main/wizard-engine'

interface WizardShellProps {
  state: WizardState
  avatarPath: string | null
  headerLine?: string | null
  children: ReactNode
}

export function WizardShell({
  state,
  avatarPath,
  headerLine,
  children,
}: WizardShellProps): JSX.Element {
  const showPersonaHeader = state.step !== 'persona-picker'

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {showPersonaHeader && (
        <header className="flex items-center gap-3 p-4 border-b border-neutral-800">
          {avatarPath && (
            <img
              src={`file://${avatarPath}`}
              alt=""
              className="w-12 h-12 rounded-full object-cover bg-neutral-800"
            />
          )}
          {headerLine && <div className="text-sm text-neutral-300 italic">«{headerLine}»</div>}
        </header>
      )}
      <main className="p-6 max-w-3xl mx-auto">{children}</main>
    </div>
  )
}
