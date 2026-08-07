# Ручная приёмка VahterBot

Проводить в отдельной supergroup с тестовыми аккаунтами. Бот должен иметь права ban
users и delete messages, а BotFather privacy mode должен быть выключен.

## Проверки

1. Запуск контейнера создаёт startup alert, `docker compose ps` показывает `healthy`.
2. Первое clean text оставляет пользователя на probation.
3. Второе clean text даёт trust.
4. Spam во втором сообщении вызывает global spammer, ban и delete.
5. Стикер/фото без caption не увеличивают probation counter.
6. Caption считается сообщением.
7. Скрытый `text_link` с private invite обнаруживается.
8. Edit первого clean message в spam обнаруживается после получения trust.
9. Третье сообщение trusted user не проверяется — это ожидаемое решение.
10. Выход и повторный вход не сбрасывают trust.
11. `sender_chat` пропускается.
12. `/addadmin <id>` от super-admin выдаёт право только в текущем чате.
13. Локальный admin может выполнить `/spam <id>`, запись действует глобально.
14. `/unspam <id>` удаляет глобальную запись и разбанивает только в текущем чате.
15. Неавторизованное `/status spam` проходит в anti-spam pipeline.
16. При снятых правах ban/delete контейнер продолжает работу, пишет error log и alert.
17. После `docker compose restart bot` состояние SQLite сохраняется.
18. При недоступном proxy нет прямого fallback к Telegram; ошибка видна в Docker logs.
19. SIGTERM завершается через graceful shutdown без повреждения SQLite.

Подробный cutover и rollback описаны в [`docs/MIGRATION.md`](docs/MIGRATION.md).
