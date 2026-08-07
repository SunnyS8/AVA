// Регистрирует Аву как чат-бота портала. Запускать ОДИН раз, после того как
// поднят публичный HTTPS (deploy/bitrix-setup.sh).
//
//   node scripts/register-bitrix-bot.mjs <webhook_url>
//
// Вебхук передаётся аргументом и НЕ хранится в скрипте.

const webhook = process.argv[2];
if (!webhook) {
  console.error("нужен URL вебхука аргументом");
  process.exit(1);
}
const base = webhook.endsWith("/") ? webhook : webhook + "/";
const HANDLER = "https://83.222.26.241.sslip.io/bitrix/";

const body = {
  CODE: "ava",
  TYPE: "B",
  EVENT_MESSAGE_ADD: HANDLER,
  EVENT_WELCOME_MESSAGE: HANDLER,
  EVENT_BOT_DELETE: HANDLER,
  PROPERTIES: {
    NAME: "Ава",
    COLOR: "AQUA",
    EMAIL: "",
    PERSONAL_BIRTHDAY: "",
    WORK_POSITION: "AI-компаньон",
  },
};

const res = await fetch(`${base}imbot.register.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();

if (!res.ok || data.error) {
  console.error(`регистрация не прошла: HTTP ${res.status} ${data.error ?? ""} ${data.error_description ?? ""}`);
  process.exit(1);
}

console.log("BOT_ID =", data.result);
console.log("Впишите его в ~/.betsy/config.yaml как bitrix.bot_id и перезапустите службу:");
console.log("  systemctl restart ava");
