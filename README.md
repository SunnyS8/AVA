<p align="center">
  <h1 align="center">AVA</h1>
</p>

<p align="center">
  <b>Персональный AI-компаньон: характер, голос, память и своё лицо</b>
</p>

<p align="center">
  <a href="#возможности">Возможности</a> •
  <a href="#быстрый-старт">Быстрый старт</a> •
  <a href="#конфигурация">Конфигурация</a> •
  <a href="#архитектура">Архитектура</a> •
  <a href="#разработка">Разработка</a>
</p>

---

## Не просто бот. Компаньон.

**AVA** — это автономный AI-агент, который живёт на вашем сервере. У неё есть свой характер, голос и лицо — и она сама выполняет задачи. Она не ждёт команд — она действует. Она не забывает — она учится. Она не отключается из-за нулевого баланса — она переключается на бесплатные модели и продолжает работать.

Личность настраивается в конфиге: имя, пол, тон, стиль, свои инструкции. Остальное — голос, аватар, манера общения — подстраивается под неё.

## Возможности

- 💬 **Живой диалог** — ведёт беседу, помнит контекст, отвечает на голосовые
- 🎥 **Видео-кружочки** — липсинк-видео с вашим текстом
- 🎙 **Голосовые сообщения** — озвучивает любой текст
- 📸 **Селфи** — генерирует фото по описанию
- 🖼 **Фото-референс** — запоминает внешность по вашей фотографии
- 🧠 **Помощь с задачами** — пишет, редактирует, переводит, объясняет, планирует
- 🛠 **Инструменты** — терминал, браузер, работа с файлами
- 🔁 **Автопереключение моделей** — падение на бесплатный fallback при ошибке
- 🗃 **Память** — хранит знания и учится из разговоров
- 🌐 **Каналы** — Telegram и встроенный веб-чат

## Быстрый старт

```bash
npm install
npm run build:all   # собрать бэкенд и фронтенд
npm run dev         # запустить сервер (tsx)
```

Панель управления откроется на `http://localhost:3777`. Мастер настройки проведёт по шагам: API-ключ, характер, пароль, каналы.

Для Telegram создайте бота через [@BotFather](https://t.me/BotFather) и укажите токен в конфиге.

## Конфигурация

Конфиг хранится в `~/.betsy/config.yaml`. Пример:

```yaml
agent:
  name: Ава
  gender: female
  personality:
    tone: friendly
    style: detailed
    custom_instructions: |
      Ты умная, весёлая и заботливая помощница. Общайся по-русски. Тебя зовут Ава.

llm:
  provider: openrouter
  api_key: YOUR_OPENROUTER_API_KEY
  fast_model: google/gemini-2.5-flash
  strong_model: anthropic/claude-sonnet-4
  fallback_models:
    - qwen/qwen3-coder:free

telegram:
  token: YOUR_TELEGRAM_BOT_TOKEN
  owner_id: YOUR_TELEGRAM_USER_ID

channels:
  browser:
    enabled: true
  telegram:
    public: true   # разрешить общение всем пользователям

voice:
  tts_provider: minimax
  voice_id: Calm_Woman

selfies:
  fal_api_key: YOUR_FAL_KEY
```

> ⚠️ Никогда не коммитьте реальные ключи и файл `config.yaml` — они исключены через `.gitignore`.

## Архитектура

```
ava/
├── src/
│   ├── core/
│   │   ├── engine.ts       ← Агентный цикл (LLM → инструменты → повтор)
│   │   ├── llm/            ← Роутер LLM + провайдер OpenRouter + fallback
│   │   ├── memory/         ← SQLite: база знаний, самообучение
│   │   ├── skills/         ← Навыки (daily-summary, monitor)
│   │   └── tools/          ← Инструменты: селфи, видео, терминал, веб…
│   ├── channels/
│   │   ├── telegram/       ← Telegram (grammy) + голос + видео
│   │   └── browser/        ← WebSocket-чат
│   ├── plugins/            ← Реестр плагинов
│   ├── server.ts           ← HTTP + WebSocket + JWT
│   └── ui/                 ← React + Tailwind (Vite)
│       └── pages/          ← Wizard, Chat, Status, Skills, Backup
```

## Разработка

```bash
npm run dev          # dev-сервер с hot-reload
npm run build:all    # собрать бэкенд и фронтенд
npm test             # тесты (vitest)
npm run typecheck    # проверка типов
```

## Требования

- Node.js 20+
- [OpenRouter](https://openrouter.ai) API-ключ
- [fal.ai](https://fal.ai) ключ — для селфи и видео-кружочков

## Лицензия

См. файл [LICENSE](LICENSE).