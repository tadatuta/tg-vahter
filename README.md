# VahterBot

Антиспам-бот для Telegram на TypeScript, grammY и SQLite. Production runtime — один
Docker-контейнер на Ubuntu VM с long polling через обязательный proxy.

## Правила

- Проверяются первые два текстовых сообщения или caption каждого пользователя в чате.
- Скрытые URL из Telegram entities входят в проверяемый текст.
- Нетекстовые сообщения не засчитываются.
- После двух чистых сообщений доверие сохраняется, включая rejoin.
- Blacklist и spammers глобальны; администраторы локальны для чата.
- `sender_chat` пропускается.

## Локальная разработка

```bash
cp .env.example .env
# Для development TELEGRAM_PROXY_URL необязателен.
npm ci
npm run dev
```

## Проверка

```bash
npm run check
docker compose config --quiet
docker build -t vahterbot:local .
```

## Production

```bash
cp .env.example .env
chmod 600 .env
docker compose build
docker compose up -d
docker compose logs -f bot
```

Рабочая база находится в named volume `vahter-data`. Object Storage не монтируется.
Регулярные backups не настроены по принятому решению владельца.

## Документация

- [Аудит](docs/AUDIT.md)
- [Принятые решения](docs/DECISIONS.md)
- [Runbook миграции](docs/MIGRATION.md)
