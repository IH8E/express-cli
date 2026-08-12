# express-cli — eXpress Chat CLI

CLI-клиент для корпоративного мессенджера eXpress.

## Быстрый старт

```bash
npm run build   # сборка (tsup → dist/index.js)
node ./dist/index.js <command>
```

## Аутентификация

```bash
node ./dist/index.js auth refresh          # обновить токен
node ./dist/index.js auth login            # QR-логин (открывает браузер)
node ./dist/index.js auth status           # проверить статус токена
```

## Чаты

```bash
node ./dist/index.js chats list                        # все 55 чатов (DM, group, channel)
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

- `src/mcp/server.ts` — 8 инструментов: `chats_list`, `chats_find`, `messages_list`, `send_message`, `contacts_search`, `contacts_self`, `wait_for_messages`, `status`.
- Резолв имени чата → uuid вынесен в `src/api/resolve.ts` (`resolveChatId`, `listChatsWithNames`) — общий с `cli/send.ts`.
- `wait_for_messages`: сервер держит **одну живую `ExpressSession`**, буферизует входящие в `Inbox`; инструмент блокируется до новых сообщений (с прошлого вызова) или таймаута (`timeout_seconds`, дефолт 30). Отдаёт `{connected, count, messages:[{time, chat, chat_id, sender, message}]}` с резолвом имён чата/отправителя.
- **ВАЖНО**: свои отправки (в т.ч. с телефона/веба) НЕ приходят пушем на другую сессию (сервер подавляет self-echo) → `wait_for_messages` ловит только сообщения от ДРУГИХ. Тестировать нужно сообщением от другого человека/аккаунта.
- Запуск: `node ./dist/index.js mcp`. Регистрация в Claude Code: `claude mcp add express -- node <абс.путь>/dist/index.js mcp`.
- Проверено реальным MCP-клиентом: handshake, list tools, `status`, `chats_find`, `messages_list` (WS+дешифровка), `wait_for_messages` (connected + таймаут-ветка).
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
- Источник полного списка чатов (55 шт.)
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
- Демо/smoke-тест: `express listen [--activity]` (`src/cli/listen.ts`) — стримит входящие. Требует валидный токен (`auth qr`).

**TUI** (`src/tui/app.tsx` + `src/cli/tui.ts`, команда `express tui`) — Ink 7 + React 19:
- Слева список чатов (навигация ↑/↓, окно-viewport), справа тред выбранного чата, снизу инпут.
- Сидит на `ExpressSession`: `chats`/`message` события; история выбранного чата грузится через `readMessages`; входящие добавляются live.
- Отправка (`sendMessageViaWebSocket`) с оптимистичным рендером (self-echo подавлен сервером). Режимы: list (↑/↓, Enter→написать, q выход) / input (Enter отправить, Esc отмена).
- ФИО: кэш `huid→имя` через `UserApi.getProfilesByHuid` (батч, дедуп через ref) — DM в списке и отправители в треде показываются именами; свои сообщения — «you» зелёным.
- Непрочитанные: счётчик на чат (инкремент на `message`, если чат не открыт; сброс при открытии), в списке `(n)` + bold/cyan.
- `useInput` под `{ isActive: isRawModeSupported }` — не падает в не-TTY. Рендер-тест: `ink-testing-library` (devDep) через esbuild-бандл компонента.
- Сборка `.tsx`: tsup/esbuild + `jsx: react-jsx` в tsconfig; ink/react — external, резолвятся из node_modules в рантайме.
- Mentions: тело содержит `@{mention:<huid>}` — `parseBody`/`renderBody` рендерят как `@Имя` (magenta), huid резолвятся в кэш имён.
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
