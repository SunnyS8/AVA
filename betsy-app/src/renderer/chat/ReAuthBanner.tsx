interface Props {
  onReauth: () => void
}

export function ReAuthBanner({ onReauth }: Props): JSX.Element {
  return (
    <div className="h-screen flex items-center justify-center bg-neutral-950">
      <div className="p-8 text-center max-w-md mx-auto">
        <h2 className="text-xl mb-3 text-neutral-100">Сессия истекла</h2>
        <p className="text-neutral-400 mb-4">
          Открой Бетси заново — это переподключит чат.
        </p>
        <button
          type="button"
          onClick={onReauth}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg"
        >
          Войти заново
        </button>
      </div>
    </div>
  )
}
