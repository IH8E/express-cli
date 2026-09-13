# express-cli

Неофициальный клиент корпоративного мессенджера **eXpress** с тремя интерфейсами:

- **CLI** — команды для скриптов и агентов (`express-cli chats`, `send`, `messages`, …);
- **TUI** — интерактивный терминальный интерфейс (список чатов, треды, отправка);
- **MCP-сервер** — инструменты для AI-агентов (любой MCP-совместимый клиент).

Всё общение сквозным шифрованием (E2E): nacl.box для ключей + XChaCha20-Poly1305 для тела.

> ⚠️ Внутренний инструмент. HAR-файлы, дампы трафика и токены **не коммитятся** (см. `.gitignore`).

## Требования

- **Node.js ≥ 20**.
- Аккаунт eXpress и мобильное приложение для входа по QR.

## Установка

```bash
npm install
npm run setup      # собирает и делает команду express-cli глобальной (build + npm link)
```

После этого доступна команда `express-cli`:

```bash
express-cli --help
express-cli auth qr
```

Отдельные шаги, если нужно: `npm run build` (только сборка, `tsup → dist/index.js`),
затем `npm link` (глобальная команда) или запуск напрямую — `node ./dist/index.js <команда>`.

> Ниже примеры используют глобальную команду `express-cli`. Без глобальной установки
> замените её на `node ./dist/index.js`.

## Аутентификация

Вход — по QR-коду (сканируется мобильным приложением eXpress):

```bash
express-cli auth qr        # показывает QR, ждёт скан
express-cli auth status    # статус токена
express-cli auth refresh   # обновить токен (ключи не трогает)
```

При QR-логине CLI получает **общий cts-ключ аккаунта** прямо из QR-обмена (как телефон/десктоп), поэтому расшифровка работает сразу — без ручного импорта.

> Важно: не запускайте `auth qr` без нужды на разных устройствах бесконтрольно — модель ключей рассчитана на один общий cts-ключ на аккаунт. Подробности и все нюансы E2E — в [`AGENTS.md`](./AGENTS.md).

Другие подкоманды: `auth login` (полный device-логин с ed25519-подписью для apigw),
`auth import <token>` (импорт Bearer-токена из браузера), `auth import-cts <priv_b64> <key_id>`
(ручной импорт общего CTS-ключа), `auth logout` (удалить токен и ключи).

## CLI

Команды, которые ходят в API, принимают `--host <host>` (иначе — `EXPRESS_HOST` или
сохранённый `config.host`); большинство также поддерживают `-o, --output table|json`.

```bash
# Чаты
express-cli chats list [--type dm|group|channel]     # список чатов (ФИО для личек)
express-cli chats find "Иванов" [--type ...]         # найти чат → полный UUID
express-cli chats info <chat-id>                     # детали чата

# Сообщения
express-cli messages list <chat-id> [--limit N]      # прочитать и расшифровать
express-cli send message "Иванов" "Привет!"          # отправить (по имени или UUID)
express-cli send file "Иванов" ./report.pdf [--caption "..."]  # отправить файл (изображения)
express-cli listen [--activity] [--avatar]           # стрим входящих сообщений в терминал

# Контакты
express-cli contacts self                            # свой профиль
express-cli contacts query <huid...>                 # профили по HUID
express-cli contacts search "Петров" [--limit N]     # глобальный поиск сотрудников
express-cli contacts list                            # контакты (нужен `auth login`)
express-cli contacts directory [--since <iso-date>]  # записи корпоративного справочника

# Статусы
express-cli status self [--short]                    # свой статус
express-cli status get <huid...> [--short]           # статусы по HUID
express-cli status history [--since <iso-date>]      # история статусов

# Аватарки и файлы
express-cli avatar self [-o <path>]                  # скачать свою аватарку
express-cli avatar get <huid> [-o <path>]            # скачать чужую аватарку
express-cli download <url> [-o <path>]               # скачать файл из uploads

# Сервер, конфиг, произвольные запросы
express-cli settings meta                            # метаданные сервера
express-cli settings get [--since <iso-date>]        # настройки сервера
express-cli config get [key] | set <key> <value> | list | reset
express-cli api <path> [-X <method>] [-d '<json>']   # произвольный запрос к API
```

`listen` — персистентная сессия, печатает входящие по мере поступления (ФИО отправителя
и `@упоминания` резолвятся в имена, `@all` — как «all»); `--activity` добавляет сырые
события до расшифровки, `--avatar` показывает превью аватарки при первом сообщении от
каждого отправителя.

### Переменные окружения

Переопределяют сохранённый конфиг (`express-cli config get`), кроме `EXPRESS_DEBUG`:

| Переменная | Назначение |
| --- | --- |
| `EXPRESS_HOST` | хост eXpress (аналог `--host`) |
| `EXPRESS_TOKEN` | Bearer-токен вместо сохранённого |
| `EXPRESS_LOCALE` | локаль запросов (по умолчанию `ru`) |
| `EXPRESS_OUTPUT` | формат вывода по умолчанию (`table`/`json`) |
| `EXPRESS_DEBUG` | подробный лог подписи apigw-запросов (в stderr) |

## TUI

```bash
express-cli tui
```

- слева — список чатов (непрочитанные, ФИО в личках), справа — тред, снизу — ввод;
- **↑/↓** — чаты, **→** — войти в тред, **Enter** — писать, **q** — выход;
- **t** — панель обсуждений (тредов) чата; **Enter** — открыть обсуждение;
- mentions рендерятся как `@Имя`, картинки — как `🖼 file` + блок-арт превью под курсором.

## MCP-сервер

Запускается по stdio, переиспользует тот же E2E-код, что CLI/TUI.

Команда запуска для любого MCP-клиента (stdio transport):
```
express-cli mcp
# или без глобальной установки:
node /абсолютный/путь/dist/index.js mcp
```

Инструменты: `chats_list`, `chats_find`, `messages_list`, `send_message`,
`contacts_search`, `contacts_self`, `wait_for_messages`, `status`,
`auth_qr_start`, `auth_qr_poll`.
`wait_for_messages` блокируется до новых входящих (для реакции без поллинга).
`auth_qr_start`/`auth_qr_poll` — QR-логин прямо из MCP-клиента, когда `status`
сообщает `not_authenticated`.

## Архитектура

```
src/
  api/        HTTP + WebSocket клиенты, E2E крипта (decrypt.ts), резолв имён
  auth/       QR-логин, обновление токена, ключи
  session/    персистентная WS-сессия (чаты, треды, live-пуши) — для TUI/MCP
  cli/        команды (commander)
  tui/        интерфейс на Ink + React
  mcp/        MCP-сервер над api-слоем
  config/     хранение токенов/ключей (conf), настройки
```

Токены и ключи хранятся локально через `conf` (вне репозитория, в конфиге ОС),
в код и git не попадают.

## Разработка

```bash
npm run build      # сборка (tsup)
npm run dev        # watch-сборка
npm run lint       # tsc --noEmit (есть остаточные предупреждения типов)
npm test           # node:test через tsx, без сети — MCP-тулы, Inbox, QR-материал
```

Глубокая техническая документация по протоколу eXpress, модели ключей и E2E —
в [`AGENTS.md`](./AGENTS.md).

## Безопасность

- E2E: приватные ключи и токены — только локально (`conf`), никогда в git.
- HAR-файлы и дампы трафика содержат токены/ключи/личные данные — они в `.gitignore`.
- Один активный cts-ключ на аккаунт; свежий `auth qr`/логин на новом устройстве
  забирает общий ключ через QR-обмен (детали — в `AGENTS.md`).
