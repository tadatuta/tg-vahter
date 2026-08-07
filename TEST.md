# Автоматическая проверка

```bash
npm ci
npm run check
docker compose config --quiet
docker build -t vahterbot:test .
```

`npm run check` запускает ESLint, TypeScript, unit/integration tests и production build.

## Покрытые инварианты

- production требует HTTPS `TELEGRAM_API_ROOT`;
- Telegram IDs валидируются как safe integers;
- invalid regex останавливает запуск;
- два уникальных clean messages дают trust;
- duplicate message/update не увеличивает счётчик;
- non-text не считается;
- caption и hidden URL проверяются;
- spam во втором сообщении блокируется;
- third message trusted user игнорируется;
- probation edit проверяется повторно;
- rejoin не сбрасывает trust;
- sender_chat пропускается;
- spammers/blacklist глобальны;
- custom administrators локальны;
- unauthorized command проходит в anti-spam pipeline;
- legacy SQLite мигрирует без выдачи глобальных admin rights;
- SQLite state сохраняется после reopen.

Docker build также выполняется в CI. Локально для него должен быть запущен Docker daemon.
