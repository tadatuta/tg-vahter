# План тестирования бизнес-логики VahterBot

## Что покрываем

1. Конфиг и запуск: `/Users/tadatuta/projects/tg-antispam-bot/src/config.ts`, `/Users/tadatuta/projects/tg-antispam-bot/src/bot.ts`, `/Users/tadatuta/projects/tg-antispam-bot/src/index.ts`.
2. Эвристики спама: `/Users/tadatuta/projects/tg-antispam-bot/src/heuristics.ts`.
3. Хранилище и инварианты: `/Users/tadatuta/projects/tg-antispam-bot/src/db/index.ts`.
4. Обработка новых участников: `/Users/tadatuta/projects/tg-antispam-bot/src/handlers/newMember.ts`.
5. Обработка сообщений: `/Users/tadatuta/projects/tg-antispam-bot/src/handlers/message.ts`.
6. Админ-команды и авторизация: `/Users/tadatuta/projects/tg-antispam-bot/src/handlers/admin.ts`.
7. Логирование и отказоустойчивость: `/Users/tadatuta/projects/tg-antispam-bot/src/logger.ts`.

## Стратегия тестирования

1. Unit-тесты для чистой логики и ветвлений.
2. Интеграционные тесты с реальным SQLite-файлом во временной директории.
3. Контрактные тесты обработчиков с моками `ctx.api` (`banChatMember`, `deleteMessage`, `getChatMember`, `reply`).
4. Сквозные сценарии через `bot.handleUpdate` (happy path + негатив).
5. Регрессия в CI: блокировать merge при падении `P0`.

## Приоритеты

1. `P0`: бан/блеклист, авторизация админов, первый месседж нового пользователя, защита от ложных пропусков.
2. `P1`: корректность статистики, идемпотентность DB-операций, fallback-ветки.
3. `P2`: формат логов, вторичные UX-ответы команд.

## Каталог тестов (детально)

1. `CFG-01 (P0)` `BOT_TOKEN` отсутствует -> `loadConfig` кидает ошибку.
2. `CFG-02 (P1)` `ADMIN_IDS="1, 2, x"` -> парсятся только валидные числа.
3. `CFG-03 (P1)` дефолты `DB_PATH`/`LOG_FILE` применяются.
4. `H-01 (P0)` пустой `SPAM_REGEX` отключает эвристики, `isSpam` всегда `false`.
5. `H-02 (P0)` невалидный regex не валит процесс, пишет ошибку, эвристики отключены.
6. `H-03 (P1)` regex работает `iu` (unicode + case-insensitive).
7. `H-04 (P1)` `isSpam(undefined)` -> `false`.
8. `DB-01 (P0)` миграции создают все таблицы и индексы.
9. `DB-02 (P1)` `addNewUser` идемпотентен по `(user_id, chat_id)`.
10. `DB-03 (P1)` `removeNewUser` удаляет только целевую пару.
11. `DB-04 (P0)` `addToBlacklist/removeFromBlacklist` корректно меняют состояние.
12. `DB-05 (P0)` `addSpammer` пишет/перезаписывает запись спамера.
13. `DB-06 (P1)` `addAdmin` идемпотентен.
14. `DB-07 (P1)` `logMessage` режет текст до 4096 символов.
15. `DB-08 (P1)` `getStats` возвращает точные счетчики.
16. `DB-09 (P0)` матрица `isKnownUser` на состояниях: `new`, `spammer`, `unknown`.
17. `NM-01 (P1)` `handleNewMember`: без `chatId` -> no-op.
18. `NM-02 (P1)` `chat_member` с не-join статусом игнорируется.
19. `NM-03 (P1)` бот-аккаунты игнорируются.
20. `NM-04 (P0)` blacklisted join -> вызов `banChatMember`, попытка удалить join message.
21. `NM-05 (P1)` при ошибке `banChatMember` обработчик не падает.
22. `NM-06 (P0)` обычный join -> пользователь в `new_users`.
23. `NM-07 (P1)` `message:new_chat_members` с несколькими участниками обрабатывает каждого.
24. `MSG-01 (P1)` private chat/bot/service message игнорируются.
25. `MSG-02 (P0)` blacklisted message -> бан + удаление сообщения.
26. `MSG-03 (P0)` known user -> полный skip без DB-изменений.
27. `MSG-04 (P0)` новый пользователь + spam -> `spammers+`, `new_users-`, бан+удаление.
28. `MSG-05 (P0)` новый пользователь + clean -> `new_users-`, запись в `message_log`.
29. `MSG-06 (P1)` текст из `caption` тоже проверяется эвристикой.
30. `MSG-07 (P1)` без `text/caption` -> не спам, логируется `null`.
31. `MSG-08 (P1)` ошибка `deleteMessage` не ломает поток.
32. `MSG-09 (P1)` после clean первого сообщения второе сообщение пользователя пропускается.
33. `ADM-01 (P0)` авторизация: super-admin из `ADMIN_IDS`.
34. `ADM-02 (P0)` авторизация: admin из таблицы `admins`.
35. `ADM-03 (P0)` авторизация: chat admin через `getChatMember`.
36. `ADM-04 (P1)` ошибка `getChatMember` -> неавторизован.
37. `ADM-05 (P0)` `/ban` по reply: пользователь попадает в blacklist.
38. `ADM-06 (P0)` `/ban <id> [reason]`: парсинг и сохранение reason.
39. `ADM-07 (P1)` `/ban` без id -> usage message.
40. `ADM-08 (P0)` `/unban <id>` удаляет из blacklist и отвечает в чат.
41. `ADM-09 (P1)` `/unban` невалидный id -> сообщение об ошибке.
42. `ADM-10 (P0)` `/addadmin` доступен только super-admin.
43. `ADM-11 (P1)` `/status` возвращает корректные числа из DB.
44. `E2E-01 (P0)` join -> clean first message -> second message skip.
45. `E2E-02 (P0)` join -> spam first message -> бан и удаление.
46. `E2E-03 (P0)` ручной `/ban` -> следующее сообщение пользователя банится сразу.
47. `E2E-04 (P1)` рестарт процесса сохраняет состояние DB и корректно продолжает.

## Критические риски, которые тесты должны явно фиксировать

1. Ветка “implicit join” в `/Users/tadatuta/projects/tg-antispam-bot/src/handlers/message.ts:47` конфликтует с `isKnownUser` в `/Users/tadatuta/projects/tg-antispam-bot/src/db/index.ts:125`; нужен отдельный `P0` тест как регрессионный.
2. Спамер пишется в `spammers`, но не в `blacklist`; нужно зафиксировать ожидаемое поведение продуктово.
3. `/unban` снимает только blacklist-запись, но не делает `unbanChatMember`; это тоже зафиксировать как ожидаемое/неожидаемое поведение.

## Порядок внедрения

1. Поднять тест-раннер (`node:test` + `tsx`) и базовые фикстуры `Context/API`.
2. Реализовать все `P0` кейсы.
3. Добавить `P1`, затем `P2`.
4. Подключить в CI как обязательный шаг.
