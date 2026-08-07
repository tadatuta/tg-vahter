# VahterBot — production specification

Канонические продуктовые и инфраструктурные решения находятся в
[`docs/DECISIONS.md`](docs/DECISIONS.md). Результаты исходного аудита находятся в
[`docs/AUDIT.md`](docs/AUDIT.md).

## Runtime

- TypeScript, grammY, better-sqlite3.
- Node.js 24 LTS.
- Один Docker-контейнер на Ubuntu 26.04 LTS VM.
- Long polling через обязательный HTTP(S)-proxy.
- Локальный persistent Docker volume для SQLite.
- JSON logs в stdout/stderr и Telegram operational alerts.

## Functional contract

- Первые два `text`/`caption` сообщения пользователя в каждом чате проходят
  встроенные эвристики и configured regex.
- URL из `text_link` также проверяются.
- Нетекстовые сообщения не считаются.
- Два чистых сообщения дают бессрочное доверие в чате.
- Edit одного из двух probation-сообщений проверяется повторно.
- Global blacklist/spammers применяются во всех чатах.
- Администраторы локальны для чата, кроме `SUPER_ADMIN_IDS`.
- `sender_chat` не анализируется.

AI-классификатор не входит в текущую версию.
