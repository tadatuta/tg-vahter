# Runbook ручной миграции в Yandex Compute Cloud

## 1. VM

Создать VM с Ubuntu 26.04 LTS, 2 vCPU 20%, 2 GB RAM и network SSD не менее 10 GB.
Открыть только SSH с доверенного IP. Установить Docker Engine и Compose plugin из
официального Docker-репозитория. Создать отдельного пользователя деплоя.

## 2. Подготовка проекта

```bash
git clone <private-repository-url> /opt/vahterbot
cd /opt/vahterbot
cp .env.example .env
chmod 600 .env
```

Заполнить `BOT_TOKEN`, `SUPER_ADMIN_IDS`, `TELEGRAM_API_ROOT` и `ALERT_CHAT_ID`.
`TELEGRAM_API_ROOT` должен быть HTTPS-корнем reverse proxy без завершающего `/`;
grammY добавляет путь `/bot<TOKEN>/<METHOD>` самостоятельно.
Не помещать secrets в image, shell history или Git.

## 3. Проверка образа

```bash
docker compose build
docker compose config --quiet
```

До production cutover проверить API reverse proxy отдельным тестовым токеном либо
в тестовом чате.

## 4. Остановка старого runtime

1. Полностью остановить Yandex Cloud Function.
2. Вызвать `deleteWebhook` с `drop_pending_updates=false`.
3. Дождаться завершения активных вызовов функции.
4. Больше не запускать функцию параллельно с long polling.

## 5. Извлечение старой SQLite

Сделать консистентную копию основного файла вместе с WAL-состоянием. Предпочтительно
открыть БД штатным SQLite-клиентом после остановки функции, выполнить
`PRAGMA wal_checkpoint(TRUNCATE)` и `PRAGMA integrity_check`, затем копировать `.db`.

Сохранить одноразовый rollback snapshot вне рабочего Docker volume до завершения
приёмки.

## 6. Импорт

```bash
docker volume create vahter-data
docker run --rm \
  -v vahter-data:/data \
  -v /secure/path/to/legacy:/import:ro \
  node:24-bookworm-slim \
  sh -c 'cp /import/vahter.db /data/vahter.db && chown 1000:1000 /data /data/vahter.db && chmod 750 /data'
```

SQLite создаёт рядом с БД файлы WAL/SHM, поэтому пользователю контейнера `1000:1000`
должен принадлежать не только `vahter.db`, но и сам каталог `/data`.

При первом запуске приложение транзакционно обновит legacy-схему до версии 2.
Существующий `message_log` даёт один approved message, а не полное доверие. Legacy
DB-admin сохраняются в `legacy_admins`, но не получают права автоматически.

## 7. Запуск и приёмка

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=200 bot
```

Проверить:

1. startup alert;
2. `/status` от владельца и локального администратора;
3. нетекстовое сообщение не увеличивает probation;
4. первое чистое сообщение оставляет пользователя на проверке;
5. второе чистое сообщение даёт доверие;
6. spam во втором сообщении вызывает ban/delete;
7. скрытый `text_link` проверяется;
8. edit probation-сообщения проверяется повторно;
9. контейнер остаётся healthy после restart;
10. SQLite сохраняется после `docker compose down` и повторного `up`.

## 8. Rollback

```bash
docker compose down
```

Восстановить одноразовый snapshot, вернуть webhook и только после этого снова включить
Cloud Function. Одновременный webhook и long polling запрещены.

После окончательной приёмки удалить Cloud Function, старый bucket mount и rollback
snapshot, если дальнейшее хранение не требуется.
