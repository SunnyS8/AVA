// Проверяет живое состояние приложения и бота в портале. Читать безопасно:
// секретов не печатает. Запускать на сервере после установки приложения и
// после перерегистрации бота.
//
//   node scripts/check-bitrix.mjs [путь-к-файлу-токенов]
//
// Отвечает на три вопроса, каждый из которых уже стоил нам боевого сбоя:
//   1. на КАКОЙ хост мы стучимся — 08.08.2026 сервер авторизации подсунул
//      своё имя вместо портала, и все вызовы ушли в никуда;
//   2. какие права у приложения ПО ФАКТУ — одинокое `app` в scope читается
//      как «права отобрали», хотя означает «спросили не у того хоста»;
//   3. зарегистрирован ли бот и есть ли у него аватарка — портал отвечает
//      `result: true` и на то, чего не сделал.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKENS_PATH = process.argv[2] ?? path.join(os.homedir(), ".betsy", "bitrix-tokens.json");

/** Кого спека назначила автором задач и наблюдателями (§15б). Проверяем, что
 *  профили на месте и это те самые люди, до того как этап 2 начнёт ими
 *  пользоваться. */
const EXPECTED_USERS = [
  ["1", "собственник"],
  ["6", "аналитик"],
  ["238", "автор задач (CREATED_BY)"],
];

let tokens;
try {
  tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
} catch (err) {
  // Путь печатать можно — секрета в нём нет. Содержимое и текст ошибки — нельзя.
  console.error(`не удалось прочитать токены (${err.name}): ${TOKENS_PATH}`);
  console.error("Приложение ещё не установлено в портале — установите и повторите.");
  process.exit(1);
}

if (!tokens?.accessToken || !tokens?.domain) {
  console.error(`в файле токенов нет accessToken или domain: ${TOKENS_PATH}`);
  process.exit(1);
}

if (typeof tokens.expiresAt === "number" && Date.now() >= tokens.expiresAt) {
  console.error("токен приложения просрочен.");
  console.error("Перезапустите службу (systemctl restart ava) — она обновит токены, — и повторите.");
  process.exit(1);
}

/** Вызов метода портала. `auth` уходит телом, а не строкой адреса: адреса
 *  попадают в журналы промежуточных узлов, а это живой ключ доступа. */
async function call(method, params = {}) {
  let res;
  let data;
  try {
    res = await fetch(`https://${tokens.domain}/rest/${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: tokens.accessToken, ...params }),
    });
    data = await res.json();
  } catch (err) {
    // err.message у fetch пересказывает весь запрос вместе с токеном.
    throw new Error(`нет связи с порталом (${err.name})`);
  }
  if (!res.ok || data?.error) {
    // error_description умеет пересказывать присланные данные — только код.
    throw new Error(`HTTP ${res.status} ${data?.error ?? ""}`.trim());
  }
  return data?.result;
}

let failed = false;

/** Печатает исход шага и запоминает провал: скрипт обязан дойти до конца —
 *  половина картины хуже, чем её отсутствие, — но выйти ненулевым кодом. */
async function step(title, fn) {
  try {
    await fn();
  } catch (err) {
    failed = true;
    console.log(`✗ ${title}: ${err.message}`);
  }
}

const expectedBotId = process.env.BITRIX_BOT_ID;

console.log(`Портал из файла токенов: ${tokens.domain}`);
console.log(`Файл токенов: ${TOKENS_PATH}`);
if (tokens.domain.includes("oauth.bitrix.info")) {
  failed = true;
  console.log("✗ в файле токенов записан сервер авторизации, а не портал — это тот самый сбой 08.08.2026");
}
console.log("");

await step("права приложения", async () => {
  const scope = await call("scope");
  const got = Array.isArray(scope) ? scope : [];
  const needed = ["imbot", "im", "user", "department", "task", "tasks_extended", "calendar"];
  const missing = needed.filter((s) => !got.includes(s));
  console.log(`${missing.length === 0 ? "✓" : "✗"} права: ${got.join(", ") || "(пусто)"}`);
  if (got.length === 1 && got[0] === "app") {
    console.log("  одинокое `app` — это права сервера авторизации; проверьте, на какой хост уходит запрос");
  }
  if (missing.length > 0) {
    failed = true;
    console.log(`  не хватает: ${missing.join(", ")} — выдайте на странице приложения и переустановите`);
  }
});

/** Ради этого затевалась переустановка 10.08.2026: приложение должно ходить в
 *  портал служебным профилем «Администрация Офис» (238), а не профилем того,
 *  кто нажал «Установить» — иначе Ава видит портал его глазами, включая его
 *  переписку. `user.current` отвечает тем профилем, которому выданы токены. */
const SERVICE_USER_ID = "238";

await step("от чьего имени работает приложение", async () => {
  const me = await call("user.current");
  const id = String(me?.ID ?? "");
  const name = [me?.LAST_NAME, me?.NAME].filter(Boolean).join(" ") || "(без имени)";
  const ok = id === SERVICE_USER_ID;
  console.log(`${ok ? "✓" : "✗"} токены выданы профилю: ID ${id || "?"} — ${name}`);
  if (!ok) {
    failed = true;
    console.log(`  ожидался служебный ID ${SERVICE_USER_ID} («Администрация Офис»)`);
    console.log("  приложение установлено не тем профилем — снимите и установите заново под служебным");
  }
});

await step("бот зарегистрирован", async () => {
  const bots = await call("imbot.bot.list");
  const list = Object.entries(bots ?? {});
  if (list.length === 0) {
    failed = true;
    console.log("✗ боты приложения: ни одного — запустите scripts/register-bitrix-bot.mjs");
    return;
  }
  // Заголовок без знака: строки ниже могут и провалиться, а «✓» над ними
  // прочитается как «всё хорошо» раньше, чем глаз дойдёт до подробностей.
  console.log("боты приложения:");
  for (const [id, bot] of list) {
    // Аватарка ставится ТОЛЬКО при регистрации (замер 08.08.2026), поэтому её
    // отсутствие — не мелочь: чинится лишь перерегистрацией бота.
    const hasAvatar = Boolean(bot?.PERSONAL_PHOTO);
    const avatar = hasAvatar ? "аватарка есть" : "БЕЗ АВАТАРКИ";
    console.log(`  ${hasAvatar ? "✓" : "✗"} ${id}  CODE=${bot?.CODE ?? "?"}  NAME=${bot?.NAME ?? "?"}  ${avatar}`);
    if (!hasAvatar) failed = true;
  }
  if (expectedBotId && !list.some(([id]) => id === expectedBotId)) {
    failed = true;
    console.log(`✗ bot_id из настроек (${expectedBotId}) в списке отсутствует — Ава будет слать от несуществующего бота`);
  }
});

await step("профили из спецификации", async () => {
  for (const [id, role] of EXPECTED_USERS) {
    const users = await call("user.get", { ID: id });
    const u = Array.isArray(users) ? users[0] : undefined;
    if (!u) {
      failed = true;
      console.log(`✗ ID ${id} (${role}): профиль не найден`);
      continue;
    }
    const name = [u.LAST_NAME, u.NAME].filter(Boolean).join(" ") || u.EMAIL || "(без имени)";
    const active = u.ACTIVE === true || u.ACTIVE === "Y";
    console.log(`${active ? "✓" : "✗"} ID ${id} (${role}): ${name}${active ? "" : " — ОТКЛЮЧЁН"}`);
    if (!active) failed = true;
  }
});

console.log("");
console.log(failed ? "Есть замечания — см. строки со знаком ✗." : "Всё на месте.");
process.exit(failed ? 1 : 0);
