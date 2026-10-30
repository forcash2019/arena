# MCP-SuperAssistant 0.6.0 + поддержка arena.ai

Что добавлено (6 файлов, все изменения в `arena-support.patch`):
- `pages/content/src/plugins/adapters/arena.adapter.ts` - НОВЫЙ адаптер (вставка текста в поле чата, отправка);
- `plugin-registry.ts`, `adapters/index.ts`, `plugins/index.ts` - регистрация адаптера;
- `render_prescript/src/core/config.ts` - селекторы Arena для отрисовки карточек вызовов (запись стоит ПЕРВОЙ в списке);
- `chrome-extension/manifest.ts` - домены arena.ai / lmarena.ai + доступ к http://localhost и 127.0.0.1.

## 1. Применить
Вариант А (проще, на Windows): скопируйте папку `files/` поверх корня репозитория MCP-SuperAssistant-0.6.0
(структура папок совпадает, файлы заменятся).
Вариант Б: в корне репозитория `git apply arena-support.patch`.

## 2. Собрать
Нужны Node 22.12 (так в .nvmrc) и pnpm (`npm i -g pnpm`).
Скрипты сборки вызывают `bash`, на Windows запускайте команды из **Git Bash**.
```
pnpm install
pnpm build
```
Готовое расширение - папка `dist` в корне репозитория.

## 3. Поставить в Edge
edge://extensions -> Режим разработчика -> «Загрузить распакованное» -> папка `dist`.
Отключите «MCP Bridge» и версию из магазина, чтобы не было двух панелей.

## 4. Подключить сервер
Откройте arena.ai -> справа появится боковая панель MCP SuperAssistant -> индикатор сервера (Disconnected) ->
адрес `http://localhost:3000/sse`, тип SSE -> Connect.
Если не подключается: запустите их прокси (в config.json ваша команда mcp-remote) и подключайтесь к `http://localhost:3006/sse`:
```
npx -y @srbhptl39/mcp-superassistant-proxy@latest --config ./config.json --outputTransport sse
```
```json
{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/sse", "--transport", "sse-only"] } } }
```

## 5. Пользоваться
В боковой панели вставьте инструкции в чат (Insert), отправьте их модели, затем просите использовать инструменты.
Ответ с вызовом превратится в карточку с кнопкой Run.

## Если что-то не работает
F12 -> Console, отфильтруйте по `ArenaAdapter` / `MCP`, пришлите вывод и (если не отрисовались карточки)
outerHTML сообщения пользователя и блока кода из чата.
