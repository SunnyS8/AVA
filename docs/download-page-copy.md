# Download page copy

Текст и HTML для страницы `betsyai.io/download`. Маркетинг-репо вставляет это на лендинг как есть.

---

## Готовый HTML (drop-in)

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Скачать Бетси для Windows</title>
  <style>
    :root { --bg: #0a0a0a; --fg: #ededed; --accent: #2563eb; --muted: #888; --warn: #fbbf24; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); margin: 0; min-height: 100vh; }
    main { max-width: 640px; margin: 0 auto; padding: 80px 24px 60px; }
    h1 { font-size: 2.6em; margin: 0 0 12px; font-weight: 600; letter-spacing: -0.02em; }
    .lead { color: var(--muted); font-size: 1.1em; margin: 0 0 32px; }
    .download-btn {
      display: inline-flex; align-items: center; gap: 10px;
      padding: 18px 32px; background: var(--accent); color: white;
      border-radius: 10px; text-decoration: none; font-size: 18px; font-weight: 500;
      transition: background 0.15s;
    }
    .download-btn:hover { background: #1d4ed8; }
    .system-req { color: var(--muted); font-size: 14px; margin-top: 14px; }
    .warning {
      margin-top: 40px; padding: 18px 22px;
      background: rgba(251, 191, 36, 0.08); border-left: 3px solid var(--warn); border-radius: 6px;
    }
    .warning strong { color: var(--warn); display: block; margin-bottom: 8px; }
    .warning ol { margin: 8px 0 0; padding-left: 22px; line-height: 1.7; }
    .warning code { background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 3px; font-size: 0.95em; }
    h2 { margin-top: 48px; font-size: 1.4em; font-weight: 500; }
    .features { list-style: none; padding: 0; margin: 16px 0; }
    .features li { padding: 8px 0; color: #ccc; }
    .features li::before { content: "→ "; color: var(--accent); }
    footer { color: var(--muted); font-size: 13px; margin-top: 60px; }
    footer a { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <h1>Бетси для Windows</h1>
    <p class="lead">AI-ассистент с характером. Подписка на наш хостинг или self-host на твоём VPS.</p>

    <a class="download-btn" href="https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe">
      ⬇ Скачать для Windows
    </a>
    <div class="system-req">Windows 10/11 · 64-bit · ~150 MB · бесплатно</div>

    <div class="warning">
      <strong>⚠ Первый запуск: что покажет Windows</strong>
      Бетси сейчас в раннем доступе и ещё не прошла процедуру подписи у Microsoft. Поэтому при первом запуске Windows покажет окно <em>«Windows защитил ваш компьютер»</em>. Это нормально для нового приложения — мы постепенно накапливаем репутацию.
      <ol>
        <li>В окне SmartScreen нажми <code>Подробнее</code>.</li>
        <li>Потом появится кнопка <code>Выполнить в любом случае</code> — жми её.</li>
        <li>Дальше пойдёт обычная установка.</li>
      </ol>
    </div>

    <h2>Что внутри</h2>
    <ul class="features">
      <li>Wizard первого запуска — выбираешь персонажа и режим работы</li>
      <li>Общение через Telegram (и Max) — Бетси отвечает 24/7</li>
      <li><strong>Self-host:</strong> ставится на твой VPS по SSH одной кнопкой</li>
      <li><strong>Hosted:</strong> подписка, мы хостим у себя — ничего настраивать не надо</li>
    </ul>

    <footer>
      <p>Вопросы? Пиши в <a href="https://t.me/betsyai_bot">@betsyai_bot</a>.</p>
    </footer>
  </main>
</body>
</html>
```

---

## Эссенциальные куски (если используешь другой шаблон)

### Headline

> # Бетси для Windows
> AI-ассистент с характером. Подписка на наш хостинг или self-host на твоём VPS.

### Кнопка скачивания

URL: `https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe`

Подпись под кнопкой: `Windows 10/11 · 64-bit · ~150 MB · бесплатно`

### Блок «Первый запуск» (КРИТИЧНО показать рядом с кнопкой)

> **⚠ Первый запуск: что покажет Windows**
>
> Бетси сейчас в раннем доступе и ещё не прошла процедуру подписи у Microsoft. Поэтому при первом запуске Windows покажет окно «Windows защитил ваш компьютер». Это нормально для нового приложения — мы постепенно накапливаем репутацию.
>
> 1. В окне SmartScreen нажми **«Подробнее»**.
> 2. Потом появится кнопка **«Выполнить в любом случае»** — жми её.
> 3. Дальше пойдёт обычная установка.

### Фичи (короткий список)

- Wizard первого запуска — выбираешь персонажа и режим работы
- Общение через Telegram (и Max) — Бетси отвечает 24/7
- **Self-host:** ставится на твой VPS по SSH одной кнопкой
- **Hosted:** подписка, мы хостим у себя — ничего настраивать не надо

---

## Когда сертификат появится

Когда подключим Microsoft Trusted Signing (~$120/год) или EV cert — блок «Первый запуск» можно удалить полностью. SmartScreen перестанет показывать warning.

Если хочется промежуточный шаг — можно купить дешёвый OV cert (~$50/год). С ним warning виден первые ~3000 уникальных скачиваний, потом Microsoft накапливает репутацию и убирает. Документировать процесс «накопления репутации» юзеру не нужно — это происходит на их стороне молча.
