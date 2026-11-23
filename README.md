# express-cli

Неофициальный клиент корпоративного мессенджера **eXpress** с тремя интерфейсами:

- **CLI** — команды для скриптов и агентов (`express-cli chats`, `send`, `messages`, …);
- **TUI** — интерактивный терминальный интерфейс (список чатов, треды, отправка);
- **MCP-сервер** — инструменты для AI-агентов (любой MCP-совместимый клиент).

Всё общение сквозным шифрованием (E2E): nacl.box для ключей + XChaCha20-Poly1305 для тела.

> ⚠️ Внутренний инструмент. HAR-файлы, дампы трафика и токены **не коммитятся** (см. `.gitignore`).

## Содержание

- [Два сервера: корпоративный и публичный](#два-сервера-корпоративный-и-публичный) — с чего начать
- [Требования](#требования) · [Установка](#установка)
- [Аутентификация](#аутентификация) · [CLI](#cli) · [TUI](#tui) · [MCP-сервер](#mcp-сервер)
- [Архитектура](#архитектура) · [Разработка](#разработка) · [Безопасность](#безопасность)

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

## Два сервера: корпоративный и публичный

CLI умеет работать с двумя разными деплоями eXpress. **Корпоративный — дефолт**, для него
ничего настраивать не нужно. Публичный включается одной переменной окружения.

| | Корпоративный | Публичный |
| --- | --- | --- |
| Для чего | ваш рабочий eXpress (`cts1.$domain`) | `https://corp.express` |
| Настройка | ничего, это дефолт | 5 ключей + отдельный профиль |
| Хранилище | стандартный каталог `conf` | свой каталог в `EXPRESS_CLI_CONFIG_DIR` |
| Ключ E2E | общий `cts`-ключ аккаунта | `rts`-ключ (CTS-логин не выдаётся) |
| Чтение/отправка | работают | работают (проверено) |

### Корпоративный — просто работает

`$domain` ниже — домен вашего eXpress, а `cts1` — его CTS-хост.

```bash
express-cli config set host cts1.$domain      # один раз
express-cli auth qr
express-cli chats list
```

`ets`-хост и веб-origin выводятся сами из `host`: `ets.$domain` и `https://$domain`.
Проверить, что вы в корпоративном профиле:

```bash
express-cli config list
# {
#   "host": "cts1.$domain"
# }
```

### Публичный — отдельный профиль

Два деплоя **нельзя смешивать в одном профиле**: у них разные ключи, а `conf` читает
каталог профиля один раз при старте процесса. Поэтому публичный живёт в своём каталоге,
и переключаетесь вы переменной `EXPRESS_CLI_CONFIG_DIR`.

Настройка (один раз):

```bash
export EXPRESS_CLI_PROFILE=~/.config/express-public   # любой каталог вне репозитория

EXPRESS_CLI_CONFIG_DIR=$EXPRESS_CLI_PROFILE express-cli config set host ru.public.express
EXPRESS_CLI_CONFIG_DIR=$EXPRESS_CLI_PROFILE express-cli config set ets_host https://ru.public.express
EXPRESS_CLI_CONFIG_DIR=$EXPRESS_CLI_PROFILE express-cli config set web_origin https://corp.express
EXPRESS_CLI_CONFIG_DIR=$EXPRESS_CLI_PROFILE express-cli config set qr_platform_package_id ru.unlimitedtech.express
EXPRESS_CLI_CONFIG_DIR=$EXPRESS_CLI_PROFILE express-cli config set qr_register_ets false

EXPRESS_CLI_CONFIG_DIR=$EXPRESS_CLI_PROFILE express-cli auth qr
```

Переключение — один алиас, дальше команды те же самые:

```bash
alias xpub='EXPRESS_CLI_CONFIG_DIR=~/.config/express-public express-cli'

xpub chats list              # публичный
express-cli chats list       # корпоративный
xpub messages list <chat-id>
xpub mcp                     # MCP-сервер на публичном профиле
```

Убедиться, какой профиль активен:

```bash
xpub config list
# {
#   "host": "ru.public.express",
#   "ets_host": "https://ru.public.express",
#   "web_origin": "https://corp.express",
#   "qr_platform_package_id": "ru.unlimitedtech.express",
#   "qr_register_ets": false
# }
```

> ⚠️ **Публичный `auth qr` создаёт отдельный аккаунт.** Ваш `huid` на публичном сервере
> отличается от корпоративного, поэтому с одним и тем же человеком у вас будет **две
> независимые переписки** — серверы не федеративны, и чат, созданный на одном, второму
> неизвестен. Это не баг, а устройство сервиса.

> ⚠️ **Каталог профиля должен быть постоянным.** Если задать его во временном каталоге
> (например, `/tmp/express-public`), профиль исчезнет после перезагрузки и логин придётся
> повторять.

Отдельного `platform_package_id` для публичного профиля не нужно: он используется только
`auth login` (device-логин), а не `auth qr`. И он вообще необязателен — по умолчанию
не отправляется (см. [«Ключи конфига деплоя»](#ключи-конфига-деплоя)).

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
express-cli chats common "Иванов"                    # общие чаты с человеком
express-cli chats changes [--since <iso>]            # дельты списка чатов с курсора
express-cli chats read "Иванов"                      # отметить прочитанным
express-cli chats rules "Иванов"                     # лимиты и запрещённые расширения

# Сообщения
express-cli messages list <chat-id> [--limit N]      # прочитать и расшифровать
express-cli send message "Иванов" "Привет!"          # отправить (по имени или UUID)
express-cli send file "Иванов" ./report.pdf [--caption "..."]  # отправить файл (изображения)
express-cli send message "Иванов" "текст" --at "+5m" # отложенная отправка (ISO или +5m/+2h/+1d)
express-cli send delayed "Иванов"                    # что стоит в очереди
express-cli send cancel "Иванов" <sync-id>           # отменить отложенное
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
express-cli status get <huid...> --live              # presence по WS (REST часто пуст)
express-cli status history [--since <iso-date>]      # история статусов

# Аватарки и файлы
express-cli avatar self [-o <path>]                  # скачать свою аватарку
express-cli avatar get <huid> [-o <path>]            # скачать чужую аватарку
express-cli download <url> [-o <path>]               # скачать файл из uploads

# Сервер, конфиг, произвольные запросы
express-cli settings meta                            # метаданные сервера
express-cli settings silent on|off                   # режим «не беспокоить»
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

### Ключи конфига деплоя

Нужны только для нестандартной инсталляции (публичный сервер — см.
[«Два сервера»](#два-сервера-корпоративный-и-публичный) в начале).
По умолчанию `ets`-хост и веб-origin выводятся из `host`.

| Ключ | По умолчанию | Назначение |
| --- | --- | --- |
| `host` | — (обязателен) | CTS-хост, например `cts1.$domain` |
| `ets_host` | `ets.<domain>` | база ETS/apigw (URL или голый хост) |
| `web_origin` | `https://<domain>` | `Origin`/`Referer` для web API и WS-хендшейка |
| `qr_platform_package_id` | `com.pyligrim.alphach` | пакет устройства для `auth qr` |
| `qr_register_ets` | `true` | `false` — QR-логин как у публичного RTS-клиента |
| `platform_package_id` | не задан (поле не отправляется) | пакет устройства для `auth login` (не для QR) |

Значения для публичного `corp.express` сняты с его же встроенного конфига
(`regions.ru.host`, `ccsHost`, `platformPackageId`), а не подобраны наугад.

`platform_package_id` — идентификатор приложения конкретной инсталляции, а не константа
платформы. Каждый деплой публикует свой в `express-config` своего веб-клиента
(`https://<domain>/` → `<div class="express-config">{...,"platformPackageId":"..."}`):

| Деплой | `platformPackageId` |
| --- | --- |
| `achat.best` (корпоративный по умолчанию) | `com.pyligrim.alphach` |
| `corp.express` (публичный) | `ru.unlimitedtech.express` |

Дефолта нет намеренно: сервер это поле не читает. `ad_integration/token` и
`push_service/protected/token` одинаково принимают отсутствующее поле, пустую строку и
любое значение, а `token/active` возвращает только `result: true` — списка устройств с
этим полем нет ни в API, ни в UI. Поэтому отправлять чужой идентификатор по умолчанию
незачем; выставляйте его только если ваша инсталляция на него опирается:

```bash
express-cli config set platform_package_id <platformPackageId из express-config>
```

## TUI

```bash
express-cli tui
```

- слева — список чатов (непрочитанные, ФИО в личках), справа — тред, снизу — ввод;
- **↑/↓** — чаты, **→** — войти в тред, **Enter** — писать, **q** — выход;
- **t** — панель обсуждений (тредов) чата; **Enter** — открыть обсуждение;
- в шапке справа — кто печатает (`Иванов печатает…`), счётчики тредов обновляются живьём;
- **i** — открыть оригинал на весь экран (полублоками), **o** — открыть настоящий файл в системном просмотрщике, **Esc** — закрыть;
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
