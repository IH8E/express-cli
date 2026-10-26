# express-cli — eXpress Chat CLI

CLI-клиент для корпоративного мессенджера eXpress.

## Быстрый старт

```bash
npm run build   # сборка (tsup → dist/index.js)
node ./dist/index.js <command>
```

## Аутентификация

```bash
node ./dist/index.js auth qr               # QR-логин (сканируется мобильным приложением)
node ./dist/index.js auth refresh          # обновить токен
node ./dist/index.js auth status           # проверить статус токена
```

`auth login` — отдельный от QR device-логин (ed25519-подпись для apigw-эндпоинтов), не путать с `auth qr`.
Остальные подкоманды (`import`, `import-cts`, `logout`) и полный список команд CLI — в [`README.md`](./README.md#cli).

## Чаты

```bash
node ./dist/index.js chats list                        # все чаты (DM, group, channel)
node ./dist/index.js chats list --type dm              # только личные переписки
node ./dist/index.js chats list --type group           # только группы
node ./dist/index.js chats find "Павленко"             # найти чат по имени → полный UUID
node ./dist/index.js chats list --output json          # JSON для pipeline
node ./dist/index.js chats info <full-uuid>            # детали чата
```

`chats list` и `chats find` автоматически подставляют ФИО вместо "personal chat" для DM.

## Отправка сообщений

```bash
# По имени (достаточно частичного совпадения)
node ./dist/index.js send message "Павленко" "Привет!"
node ./dist/index.js send message "alfagen releases" "Деплой завтра в 10:00"

# По полному UUID
node ./dist/index.js send message <chat-uuid> "Текст"

# Файл
node ./dist/index.js send file "Павленко" ./report.pdf --caption "Отчёт"
```

Если имя неоднозначно (несколько совпадений) — команда выведет список и попросит UUID.

## Контакты и поиск людей

```bash
node ./dist/index.js contacts self                     # свой профиль
node ./dist/index.js contacts search "Иванов"          # поиск по всем сотрудникам (глобальный)
node ./dist/index.js contacts query <huid> [<huid>]    # профиль по HUID
```

Поиск использует `/api/v3/phonebook/search` — глобальный, охватывает всех сотрудников компании.

## Статусы

```bash
node ./dist/index.js status self                       # свой статус
node ./dist/index.js status get <huid> [<huid>]        # статусы по HUID
node ./dist/index.js status history                    # история статусов
```

## MCP-сервер (`express mcp`)

Тонкая обёртка над `src/api/*` — те же E2E send/read, что и CLI (без дублирования). stdio-транспорт (`@modelcontextprotocol/sdk`), stdout чистый (путь запроса/refresh не логирует в stdout).

- `src/mcp/server.ts` — 15 инструментов: `chats_list`, `chats_find`, `messages_list`, `send_message`, `contacts_search`, `contacts_self`, `wait_for_messages`, `status`, `auth_qr_start`, `auth_qr_poll`, `attachment_download`, `thread_read`, `edit_message`, `delete_message`, `react`. Все с полными annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`). Регистрация тулов вынесена в `registerTools()` — тесты (`src/mcp/server.test.ts`) вызывают её напрямую через `InMemoryTransport`, без реальной сессии/сети.
- `messages_list` и `wait_for_messages` возвращают **единую форму** сообщения (WISHLIST #1,#4,#6,#7,#10): `{sync_id, chat, chat_id, time (UTC ISO), local_time, sender (ФИО), sender_huid, own, message, mentions[], reply_to?, thread_started?, thread_replies?, reactions?, attachment?}`. Нормализация — `makeNormalizer()` (экспортирован, тестируется напрямую); резолв имён через `UserApi.getProfilesByHuid` + кэш, self-huid лениво через `contacts_self`. `mentions` — список huid из `@{mention:...}`, в тексте рендерятся как `@Имя`/`@all` (`src/api/mentions.ts`). `reply_to` — из `payload.reply` (`{sync_id, payload:{from, body}}`). Подпись картинки не теряется: `message = "🖼 file\nподпись"`. Сетевые тула обёрнуты в `withHumanErrors` — конфиг/логин/сетевые сбои отдают `{error: "человеческий текст + подсказка"}` (у `fetch failed` раскрывается `cause.code`).
- **ВАЖНО — история**: `events_history` (backward) отдаёт события **от новых к старым**, а `limit` считает ВСЕ события (вступления/выходы тоже) → сообщений приходит меньше `limit`. `messages_list` сортирует хронологически и режет через `sliceHistory()` (чистая функция, тесты): `since` (ISO или YYYY-MM-DD = локальная полночь), `since_message_id` (сообщения НОВЕЕ курсора), `before_message_id` (сообщения СТАРШЕ курсора — постраничное чтение назад; `events_history` с `sync_id` отдаёт страницу, начиная С курсора — его отбрасываем), `unread_only` (последние `counter` из `get_unread_counters`), `mentions_me` (упоминание меня или ответ на моё). `chat`/`chat_id` — в конверте ответа, не в каждом сообщении (WISHLIST #14). `has_more` = окно заполнено И ни одна граница (since/курсор) внутри окна не достигнута. С фильтрами окно по умолчанию 200.
- **Треды** (WISHLIST #2): `messages_list` отдаёт `thread_started: true` (из `meta.thread_started`), `thread_replies` (`counter` из `thread_list` по `group_chat_id` чата — глобальный `thread_list` с `group_chat_id:null` отдаёт только треды с нашим участием, его не хватает) и `reactions`; тул `thread_read(chat, message_id)` читает тред по thread_id (= sync_id корневого сообщения).
- **Вложения** (WISHLIST #3, проверено на живых сообщениях): тул `attachment_download(chat, message_id, output_path?)` — `GET {payload.file}` (это уже путь `/uploads/files/{chat_id}/{id}`, Bearer) и расшифровка `crypto_secretstream_xchacha20poly1305`: 24-байтовый header + чанки по `chunk_size` (+ABYTES), pull требует точную длину чанка. **Ключ потока = симметричный ключ самого сообщения** (`unboxMessageKey` из `msg.key`) — в живых payload `keys[]` НЕТ. Если `keys[]` в payload всё же есть (формат из HAR) — ключ берётся оттуда (`unboxStreamKey`). `file_hash` = base64(BLAKE2b-256(plaintext)) — проверяется после расшифровки. Для вложения в треде `chat` = thread_id. Сообщение по полному `sync_id` берётся напрямую (`events_history` forward + `sync_id` + `limit:1`; на чужой id сервер отдаёт ДРУГОЕ событие — сверяем), по префиксу — ищется в последних 1000 событиях (`findMessageEvent`). Папка `output_path` создаётся сама. Код: `src/api/attachments.ts`, разбор payload — `decrypt.ts` → `DecryptedMessage.attachment`.
- **Unread** (WISHLIST #5): `chats_list` отдаёт `unread` и `unread_mentions` (через `ExpressSession.getUnreadCounters()` — `system`/`get_unread_counters` WS event, ответ `{unread_counters: [{group_chat_id, counter, mention_counter}]}`).
- **Черновик** (WISHLIST #9): `send_message(..., dry_run: true)` — резолвит чат и возвращает `{sent:false, dry_run:true, chat, chat_id, text, characters}`, ничего не отправляя (человек копирует готовый текст из ответа тулa). Вариант «положить черновик в поле ввода клиента» сервером не поддерживается — только preview.
- Резолв имени чата → uuid вынесен в `src/api/resolve.ts` (`resolveChatId`, `resolveChat`, `listChatsWithNames`) — общий с `cli/send.ts`.
- **Получатели ключа сообщения** (WISHLIST #17, `pickRecipientKeys`): сервер принимает `message_new` только если `keys[]` покрывает ВСЕ `key_ids` из `chat_info`. В группе бывает ключ `kind:"rest"` (тот же `xsalsa20` Curve25519) — фильтр «только `cts`» давал `invalid_keys` в «Оркестратор 2.0 Team». Шифруем для всех ключей чата; ключ, который нечем закрыть, — понятная ошибка до отправки.
- **Ответ на сообщение**: `send_message(..., reply_to: <sync_id>)` кладёт в payload `reply: {sync_id, group_chat_id, reply_type: <chat_type>, source_name, sender_conn_type:"cts", payload:{type, body, from}}` — форма снята с ответа веб-клиента.
- **Треды** (`send_message` с `thread_id`): у треда нет своего `chat_info` (`chat_not_found`) — ключи получателей берутся из `system/thread_info {thread_id}` (`getChatKeyIds`). Пустой список ключей — ошибка, не отправка с пустым `keys[]`.
- **Правка/удаление** (HAR веб-клиента, 26.10): `edit_message` — `system/event_edit {sync_id, group_chat_id, payload, signature}` без `keys[]`: весь расшифрованный payload с новым `body` шифруется ТЕМ ЖЕ ключом сообщения, AAD `chat:sync_id`. `delete_message` — `system/delete_events {group_chat_id, sync_ids}`. Только свои сообщения. В выдаче `messages_list`/`thread_read` у правленых — `edited_at`.
- **Файлы** (`send_message(..., file_path)`, `sendFileViaWebSocket`; `image_path` из 0.1.13 заменён): картинки — `type:"image"` с превью, остальное — `type:"document"`, загрузка `kind:"document"`, только `content`. Картинки: файл и превью шифруются КЛЮЧОМ СООБЩЕНИЯ — payload без `keys[]` значит «ключ потока = ключ сообщения», так читают веб и `attachment_download`. Отдельный ключ файла (было до 0.1.13) видел только мобильный клиент, веб — лишь размытую заглушку. `file_hash` = base64(BLAKE2b-256(plaintext)), не SHA-256. `reply_to` работает и для картинок.
- **Упоминания** (HAR веб-клиента, 26.10): токен в `body` — `@{mention:<mention_id>}`, где `mention_id` — СВОЙ uuid упоминания, а не huid. Человек — в `payload.mentions[]`: `{mention_type:"user"|"all", mention_id, mention_data:{conn_type:"cts", user_huid, name} | {name:"all"}}`. При чтении `mentionTokensToHuids` переписывает токены на huid (`@all` → `ALL_MENTION_HUID`) — до 0.1.14 в выдаче были обрывки mention_id и `mentions_me` не находил упоминаний. Отправка: `send_message(..., mentions: [ФИО|email|huid|"all"])`, `{0}`, `{1}` в тексте ставят n-е упоминание (`applyMentions`).
- **Реакции**: `react` — `groupchat:<chat>` `add_reaction`/`remove_reaction` `{reaction, event_sync_id, event_sender}`, без шифрования.
- **ВАЖНО**: DM создаётся автоматически ТОЛЬКО реальной отправкой. Читающие тулы и `dry_run` резолвят с `create:false` — раньше `dry_run` молча создавал личный чат (WISHLIST #11). `chats_find` без совпадений отдаёт людей из phonebook с `chat_id:null`.
- **Адресат-человек** (WISHLIST #16, `resolveChat`): тёзки в phonebook не мешают, если запрос совпадает с ФИО или email целиком (`pickContact`, тесты). UUID сначала проверяется как huid (`cts_profiles/query`; на id чата/треда профиль пустой) — для huid ищется/создаётся DM, а не шлётся в несуществующий чат. `dry_run` отдаёт `user_huid` адресата. Сырой `chat_list` у DM имеет `name:"personal chat"` — session-обработчик `chats` не перетирает им уже резолвленное ФИО.
- `wait_for_messages`: сервер держит **одну живую `ExpressSession`** (создаётся лениво через `sessionProvider` — если MCP стартовал до `auth qr`, сессия поднимется при первом вызове после появления ключей; при смене cts/encryption key_id, напр. после `auth_qr_poll`, старая закрывается и создаётся новая — issue #1), буферизует входящие в `Inbox`; инструмент блокируется до новых сообщений (с прошлого вызова) или таймаута (`timeout_seconds`, дефолт 30). Отдаёт `{connected, count, messages:[{time, chat, chat_id, sender, message}]}` с резолвом имён чата/отправителя.
- **ВАЖНО**: свои отправки (в т.ч. с телефона/веба) НЕ приходят пушем на другую сессию (сервер подавляет self-echo) → `wait_for_messages` ловит только сообщения от ДРУГИХ. Тестировать нужно сообщением от другого человека/аккаунта.
- `auth_qr_start`/`auth_qr_poll` — QR-логин из MCP-клиента (когда `status` вернул `not_authenticated`). Материал пендинг-логина персистится в `os.tmpdir()` (переживает рестарт сервера) с правами `0o600`.
- **ВАЖНО**: `session.on("error", ...)` обязателен — без листенера Node кидает необработанное исключение на любой `session.emit("error", ...)` (напр. сбой дешифровки пуша) и валит процесс.
- **ВАЖНО**: `EXPRESS_DEBUG=1` не должен ничего писать в stdout при работе как MCP — весь debug-вывод (`src/auth/apigw-signer.ts`) идёт через `console.error` (stderr).
- Запуск: `node ./dist/index.js mcp`. Регистрация в Claude Code: `claude mcp add express -- node <абс.путь>/dist/index.js mcp`.
- Проверено реальным MCP-клиентом: handshake, list tools, `status`, `chats_find`, `messages_list` (WS+дешифровка), `wait_for_messages` (connected + таймаут-ветка).
- Тесты: `npm test` (`node:test` через `tsx`, без сети/браузера — `EXPRESS_CLI_CONFIG_DIR` изолирует `conf`-стор от реального токена пользователя).
- TODO: `send_file`, `threads_list`.

## Технические детали для агентов

**Архитектура**:
- `src/api/` — HTTP + WebSocket клиенты
- `src/cli/` — команды (commander)
- `src/config/store.ts` — хранение токенов (Conf/electron-store)
- `src/auth/` — QR-логин, обновление токена

**Два сервера**:
- CTS (основной) — Bearer token, WebSocket; адрес задаётся через `EXPRESS_HOST` или `config.host`
- ETS (apigw) — ed25519-подпись, используется только для auth activation; адрес выводится из CTS-хоста (`ets.<domain>`)

**WebSocket** (`wss://<host>/socket/user/websocket?vsn=1.0.0`):
- Phoenix protocol: authenticate → chat_list / chat_info / message_new
- Источник полного списка чатов
- Реализован в `src/api/websocket.ts`

**Отправка сообщений** (`src/api/messaging-ws.ts`):
- E2E шифрование: nacl.box (XSalsa20-Poly1305) для ключей + XChaCha20-Poly1305 IETF для тела
- Формат algo: `"xsalsa20:xchacha20_aead_ietf"` (key_encryption_algo:body_encryption_algo)
- `message_new` отправляет массив `keys[]` — зашифрованный симметричный ключ для каждого участника
- **Набор `keys[]` должен ТОЧНО совпадать с ключами из `chat_info` — ни больше, ни меньше.** Любой лишний key_id (напр. старый браузерный `afc93375`) → сервер отвечает `{"error":"invalid_keys"}`. Дошифровать для «постороннего»/устаревшего ключа нельзя.
- Из KDC берём только ключи `kind === "cts"` (по `?ids=` из chat_info)
- Сервер фильтрует `keys[]` по `key_id` подключения при `events_history`
- При первом запуске нужен CTS-ключ в чате — создаётся автоматически при QR-логине
- Если `invalid_keys`: скорее всего в `keys[]` попал key_id вне chat_info. Если ключа чата нет вовсе — перелогиниться через `auth login`.

**Чтение сообщений** (`src/api/messages-read.ts` + `src/cli/messages.ts`):
- `messages list <chat-id> [--limit N]` — читает и расшифровывает сообщения
- Использует `events_history` WS event для получения истории
- Сервер возвращает `key` объект с `key_id` = key_id подключения (подменяет!)
- Дешифровка вынесена в общий модуль `src/api/decrypt.ts` (`decryptMessage`, `decryptMessages`) — переиспользуется чтением и session-слоем

**Session-слой** (`src/session/session.ts` — персистентный WS, для TUI/MCP):
- `ExpressSession extends EventEmitter`: один долгоживущий WS (auth → Phoenix heartbeat каждые 25с → `chat_list` → `subscribe_to_chat_activities` на каждый чат)
- Живые пуши `message_new` приходят с `key:null` → на пуш тянем `events_history` (там ключ есть) и дешифруем через `decryptMessages`
- События: `connected`, `chats`, `activity` (сырое уведомление), `message` (расшифрованное), `disconnected`, `reconnecting`, `error`
- Реконнект с бэкоффом + `refreshToken()` перед переподключением
- **Одно соединение на key_id!** Сервер убивает старый сокет при появлении нового с тем же key_id. Раньше баг reconnect'а (двойное планирование в `onClose` + `scheduleReconnect`, события устаревших сокетов) плодил параллельные соединения → каскад закрытий `1006` («шторм»). Инварианты lifecycle (не сломать): (1) `connecting`-гвард + проверка `readyState` — не открывать второй сокет; (2) все обработчики сокета проверяют `if (this.ws !== ws) return` — игнор устаревших; (3) единственный `reconnectTimer` (гвард `if (this.reconnectTimer) return`); (4) `handleClose` — ЕДИНСТВЕННЫЙ, кто вызывает `scheduleReconnect` (openSocket при ошибке закрывает сокет → close → handleClose). Проверено: 40с = 1 connected, 0 disconnect.
- Подписываемся только на `chat_type ∈ {chat, group_chat, channel, notes}`; `global`/`voex_call` отвечают `unmatched topic` — пропускаем. Подписки параллельны (`Promise.allSettled`), тихо игнорируют сбой при закрытии (переподписка на reconnect).
- **Self-echo подавляется сервером**: сообщение, отправленное с одной сессии, НЕ приходит пушем на другую сессию того же юзера. Значит `listen`/TUI показывают входящие от ДРУГИХ; свои отправки TUI должен рисовать оптимистично сам. Живой пуш проверяется сообщением от собеседника.
- Демо/smoke-тест: `express listen [--activity] [--avatar]` (`src/cli/listen.ts`) — стримит входящие. Требует валидный токен (`auth qr`).
  - Резолвит ФИО отправителя (`UserApi.getProfilesByHuid`, кэш по huid, промис-per-huid — не кэширует неудачный лукап, чтобы транзиентный сбой не «замораживал» имя навсегда) и `@{mention:<huid>}` в теле (общая логика с TUI — `ALL_MENTION_HUID`/`MENTION_RE` вынесены в `src/api/mentions.ts`; `ALL_MENTION_HUID` — зарезервированный huid широковещательного `@all`, рендерится как «all», профиль под него не запрашивается).
  - Обработка входящих сообщений идёт цепочкой промисов (`messageQueue`), а не `void handleMessage(m)` — иначе гонка асинхронных лукапов профиля могла напечатать сообщения не в порядке прихода.
  - `--avatar`: при первом сообщении от каждого отправителя скачивает и рендерит превью аватарки (`terminal-image`, `preferNativeRender:true` — в отличие от TUI, здесь можно смешивать нативную графику терминала с обычным построчным выводом).

**TUI** (`src/tui/app.tsx` + `src/cli/tui.ts`, команда `express tui`) — Ink 7 + React 19:
- Слева список чатов (навигация ↑/↓, окно-viewport), справа тред выбранного чата, снизу инпут.
- Сидит на `ExpressSession`: `chats`/`message` события; история выбранного чата грузится через `readMessages`; входящие добавляются live.
- Отправка (`sendMessageViaWebSocket`) с оптимистичным рендером (self-echo подавлен сервером). Режимы: list (↑/↓, Enter→написать, q выход) / input (Enter отправить, Esc отмена).
- ФИО: кэш `huid→имя` через `UserApi.getProfilesByHuid` (батч, дедуп через ref) — DM в списке и отправители в треде показываются именами; свои сообщения — «you» зелёным.
- Непрочитанные: счётчик на чат (инкремент на `message`, если чат не открыт; сброс при открытии), в списке `(n)` + bold/cyan.
- `useInput` под `{ isActive: isRawModeSupported }` — не падает в не-TTY. Рендер-тест: `ink-testing-library` (devDep) через esbuild-бандл компонента.
- Сборка `.tsx`: tsup/esbuild + `jsx: react-jsx` в tsconfig; ink/react — external, резолвятся из node_modules в рантайме.
- Mentions: тело содержит `@{mention:<huid>}` — `parseBody`/`renderBody` рендерят как `@Имя` (magenta), huid резолвятся в кэш имён. `ALL_MENTION_HUID` (`src/api/mentions.ts`, общий с `listen.ts`) — зарезервированный huid широковещательного `@all`, рендерится как «all» без похода за профилем.
- Перенос: сообщения `wrap="wrap"` (видны целиком), тред прижат к низу (оценка высоты через `estLines` по ширине панели).
- Навигация: focus-модель `chats|thread|input`. chats: ↑/↓ чаты, → в тред, Enter писать. thread: ↑/↓ курсор сообщения (`▍`), ← назад, Enter писать. input: Enter отправить, Esc отмена.
- Картинки: image-сообщения (`type:"image"`) показывают `🖼 file_name`; под выбранным курсором рендерится блок-арт превью из встроенного `blur_preview_file` (base64 data-URI) через `terminal-image` (`preferNativeRender:false` → Unicode-полублоки, совместимо с Ink). См. `src/tui/image.ts`, `decrypt.ts` (ImageAttachment).
  - Полный файл зашифрован (`file_encryption_algo:"stream"`, поля `file`/`file_id`/`file_hash`/`chunk_size`) — рендер полного разрешения требует потоковой расшифровки, пока НЕ реализован (используем встроенное `blur_preview_file`).
- TODO-полировка: группировка подряд идущих сообщений; точный расчёт высоты при переносе (мелкий косметический наезд инпута на последнее сообщение); полноразмерные картинки (stream-decrypt); аватарки в шапке чата через `terminal-image`.

**Треды/обсуждения (РЕАЛИЗОВАНО)**:
- `thread_list` (system event, `{group_chat_id, limit, request_version:2}`) → `{thread_list:[...]}`; `thread_info` (`{thread_id}`) → `{thread_info:{...}}`.
- Тред = чат-подобная сущность: свой `thread_id`, родительский `group_chat_id`, свои `keys` (E2E как у чата), `counter`. Сообщения читаются тем же `readMessages`/`events_history`/`decryptMessages` по `thread_id` (как по обычному chatId) — код переиспользован целиком.
- Session-слой грузит `thread_list` в `loadChats` → событие `threads` (`ThreadSummary[]`), `getThreads()`.
- TUI: скрыты по умолчанию; клавиша `t` в открытом чате показывает панель его тредов (фильтр по `group_chat_id`, focus `discussions`), Enter открывает тред как под-чат (`openThreadId` → `loadHistory(thread_id)`, тот же рендер/навигация), Esc возвращает. Отправка в открытый тред идёт по `thread_id`.
- Проверено на данных: 8 чатов с обсуждениями, 31 тред; лейбл `💬 <short> · N msgs · HH:MM`.
- TODO: live-подписка на треды (сейчас грузятся при открытии), заголовок треда по корневому сообщению.

**Поиск chat_id по имени**: `chats find` или `send message "имя"` — разрешает UUID автоматически.

**Сборка после изменений**: `npm run build` (tsup, ~20ms).

## Ключи и шифрование — детали

**Три типа ключей**:
- Signing (Ed25519, kind="ed25519") — для подписи сообщений
- Encryption/apigw (Curve25519, kind="rts") — для ETS API
- CTS/E2E (Curve25519, kind="cts") — для E2E шифрования сообщений

**Серверное поведение ключей**:
- `message_new` push: `key: null` (сервер НЕ включает ключ в push-уведомление)
- `events_history`: сервер фильтрует `keys[]` по `key_id` WS-подключения, возвращает ТОЛЬКО ключ для текущего key_id
- Сервер подменяет `key.key_id` на key_id подключения (не оригинальный key_id из `keys[]`)
- Старые сообщения (зашифрованные для утраченного ключа) расшифровать невозможно — ожидаемо

**МОДЕЛЬ КЛЮЧЕЙ eXpress — ОДИН общий cts-ключ на аккаунт**:
- KDC хранит **ровно один активный cts-ключ на пользователя** (`?user_huids=` отдаёт только самый свежий по версии; старые доступны лишь по `?ids=`).
- `chat_info.keys` не накапливает, а **заменяет** ключ по каждому huid на текущий из KDC.
- **Multi-device (телефон+десктоп+веб) работает потому, что все устройства делят ОДИН приватный cts-ключ** (синхронизируется через key-backup eXpress), а не имеют по своему.
- Каждый `auth login`/`auth qr` РАНЬШЕ генерировал новый cts-ключ и постил в KDC (`POST /api/v2/kdc/keys/{huid}`) → версия++ → вытеснял общий ключ аккаунта → **ломал телефон/десктоп** и вызывал "Can't decrypt" у собеседников (их клиенты берут текущий ключ huid, а сообщение запечатано устаревшим).

**Фикс (сделано)**:
- `qr-login.ts`: cts-ключ НЕ регистрируется заново, если уже сохранён (`loadApigwKeys()?.ctsKey`). Новый минтится только при первом логине.
- Команда `auth import-cts <priv_b64> <key_id>` — импорт общего ключа аккаунта (публичный ключ выводится из приватного).
- Общий ключ достаётся из веб-клиента: IndexedDB `authState` → store `items` → `encryptionKeys` → `value.user.privateKeys.cts` (`body` = приватный ключ, `publicKeyId` = key_id).

**Формат тела и body-шифрование (реверс app.js `encryptMessagePayload`/`fA`, подтверждено расшифровкой реальных веб-сообщений)**:
- **AAD обязателен**: `crypto_aead_xchacha20poly1305_ietf` шифрует/расшифровывает тело с additional_data = `` `${group_chat_id}:${sync_id}` ``. Без него получатель показывает "Can't decrypt" — это была главная причина. Реализовано в `payloadAad()` (messaging-ws.ts) и в messages-read.ts.
- Раскладка тела: `base64(nonce(24) || ciphertext)`, ключ = симметричный (боксится для каждого получателя через nacl.box).
- Схема plaintext (snake_case, БЕЗ bodyAstTree — клиент строит AST из `body` сам): `{type:"text", msg_id, from:<huid>, timestamp:<ISO8601>, group_chat_id, lat:0, lng:0, link_meta_disabled:false, stealth_forwarding:false, body:<text>}`. См. `buildTextPayload`.
- Подпись: ed25519 по **base64-строке** payload (verify over b64-string=true). CLI делает верно.
- **Исходник клиента**: `app.js` извлекается из HAR веб-клиента (base64) — источник истины по крипте.

**Механизм общего ключа на сервере (из login_without_qr HAR)**:
- Приватные ключи хранятся на сервере: `GET /api/v1/kdc/private_keys/{key_id}` отдаёт зашифрованный blob (`empty_password:false` — под паролем). Клиент качает и расшифровывает локально — так синхронизируется общий ключ между устройствами.
- Каждый логин также регистрирует новый ed25519 ключ подписи (версии растут: v68, v71…) — их много на аккаунт, все валидны, ищутся по id. cts-ключ при этом ОДИН (общий).

**`auth qr` даёт общий ключ через handshake**:
- `registration_data` (из `mobile_to_web/request`, расшифровывается эфемерным ключом устройства) содержит `cts_priv_key_body` + `cts_pub_key_id` — телефон передаёт **общий cts-ключ аккаунта** новому устройству. Пароль НЕ нужен (пароль нужен только для восстановления из серверного бэкапа без телефона).
- `qr-login.ts` берёт cts-ключ из `registration_data` (приоритет: QR-handshake → сохранённый → минт с guard). Значит `auth qr` самодостаточен: скан → CLI получает общий ключ, читает/пишет как настоящее устройство, `import-cts` не нужен. Заодно чинит застрявший CLI (QR-ключ в приоритете над сохранённым).
- Guard всё равно оставлен как страховка: если `registration_data` вдруг без cts-ключа И в KDC уже есть ключ аккаунта — логин не минтит, а просит `import-cts`. Минт только для реально первого устройства.
- Каждый QR-логин регистрирует новый ed25519 ключ подписи (версии растут) — это норма, все валидны, ищутся по id.
- `auth import-cts` остаётся как ручной запасной путь (достать ключ из IndexedDB веба).

**Серверный бэкап ключа** (для восстановления без телефона): `POST/GET /api/v1/kdc/private_keys` — приватный ключ зашифрован Argon2-производным ключом от пароля шифрования (`empty_password:false`), `secretbox`. CLI его не использует (ключ приходит по QR). DH-ключами не расшифровывается — только паролем.

**⚠️ Правила, чтобы не сломать снова**:
- НЕ запускать `auth login`/`auth qr` в CLI без нужды — при отсутствии сохранённого ctsKey он зарегистрирует новый и вытеснит общий (сломает все устройства). Если ключ уже импортирован — логин его переиспользует, это ок.
- Если общий ключ аккаунта сменился (перелогин на устройстве) — заново `auth import-cts` с новым ключом из IndexedDB.
- Старые сообщения под утраченными ключами не расшифровываются — это ожидаемо.
