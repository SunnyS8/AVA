// Регистрирует Аву как чат-бота портала. Запускать ОДИН раз, ПОСЛЕ того как
// приложение установлено в портале (то есть после того, как Ава приняла
// событие установки и сохранила токены).
//
//   node scripts/register-bitrix-bot.mjs [путь-к-файлу-токенов]
//
// Вебхук здесь больше не нужен и не принимается: бот принадлежит приложению,
// и входящий вебхук зарегистрировать его не может — портал отвечает
// «Client ID not specified» (замер 07.08.2026).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS_PATH = process.argv[2] ?? path.join(os.homedir(), ".betsy", "bitrix-tokens.json");
const HANDLER = "https://83.222.26.241.sslip.io/bitrix/";

// Аватарку портал принимает ТОЛЬКО при регистрации. `imbot.update` с
// PROPERTIES.PERSONAL_PHOTO отвечает `result: true` и не делает ничего —
// проверено 08.08.2026 тремя видами поля (пара «имя+base64», префикс
// `data:`, чистый base64). Поэтому фотография уходит здесь, а сменить её
// потом можно только перерегистрацией бота.
const AVATAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "ava-avatar.jpg",
);

let tokens;
try {
  tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
} catch (err) {
  // Путь печатать можно — секрета в нём нет, а найти файл владельцу нужно.
  // Содержимое и текст ошибки — нельзя: там токены.
  console.error(`не удалось прочитать токены (${err.name}): ${TOKENS_PATH}`);
  console.error("Сначала установите приложение в портале — токены появятся сами.");
  process.exit(1);
}

if (!tokens?.accessToken || !tokens?.domain) {
  console.error(`в файле токенов нет accessToken или domain: ${TOKENS_PATH}`);
  console.error("Похоже, установка не завершилась. Снимите приложение в портале и поставьте заново.");
  process.exit(1);
}

// Токены живут около часа. Просроченный — не повод молчать: скажем прямо, что
// делать, вместо загадочного отказа портала.
if (typeof tokens.expiresAt === "number" && Date.now() >= tokens.expiresAt) {
  console.error("токен приложения просрочен.");
  console.error("Перезапустите службу (systemctl restart ava) — она обновит токены, — и повторите.");
  process.exit(1);
}

/** Файловое поле Битрикса — пара «имя файла + содержимое в base64».
 *  Нет файла — регистрируем без аватарки, но говорим об этом вслух: молча
 *  зарегистрированный безликий бот потом чинится только перерегистрацией. */
function avatarField() {
  try {
    const b64 = fs.readFileSync(AVATAR_PATH).toString("base64");
    return { PERSONAL_PHOTO: ["ava-sis.jpg", b64] };
  } catch (err) {
    console.warn(`внимание: аватарка не прочитана (${err.name}), регистрирую без неё: ${AVATAR_PATH}`);
    console.warn("сменить её потом можно будет только перерегистрацией бота.");
    return {};
  }
}

const body = {
  // `auth` — телом запроса, не в строке адреса: адреса попадают в журналы
  // промежуточных узлов, а это живой ключ доступа.
  auth: tokens.accessToken,
  CODE: "ava",
  TYPE: "B",
  EVENT_MESSAGE_ADD: HANDLER,
  EVENT_WELCOME_MESSAGE: HANDLER,
  EVENT_BOT_DELETE: HANDLER,
  // Только заполненные поля. Пустая строка в PERSONAL_BIRTHDAY роняет
  // регистрацию: портал пытается разобрать её как дату и отвечает
  // «HTTP 400, error 500, Incorrect date/time» — по коду ошибки причину не
  // угадать. Замер 08.08.2026: тот же запрос без пустых полей проходит.
  PROPERTIES: {
    NAME: "Ава",
    COLOR: "AQUA",
    WORK_POSITION: "AI-компаньон",
    ...avatarField(),
  },
};

let res;
let data;
try {
  res = await fetch(`https://${tokens.domain}/rest/imbot.register.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  data = await res.json();
} catch (err) {
  // err.message у fetch echo-ит весь запрос — вместе с токеном. Наружу только
  // вид ошибки.
  console.error(`не удалось обратиться к порталу (${err.name}): проверьте связь с ${tokens.domain}`);
  process.exit(1);
}

// `data?.` — портал может ответить и не объектом (например, null); падать
// стеком вместо внятного сообщения тут незачем.
if (!res.ok || data?.error) {
  // error_description умеет пересказывать присланные данные, поэтому только код.
  console.error(`регистрация не прошла: HTTP ${res.status} ${data?.error ?? ""}`);
  if (data?.error === "expired_token") {
    console.error("Токен истёк: перезапустите службу (systemctl restart ava) и повторите.");
  }
  process.exit(1);
}

console.log("BOT_ID =", data?.result);
console.log("Впишите его в ~/.betsy/config.yaml как bitrix.bot_id и перезапустите службу:");
console.log("  systemctl restart ava");
