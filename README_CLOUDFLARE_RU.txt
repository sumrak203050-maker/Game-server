ПЛАТНЫЙ ДОМ — Cloudflare Workers + Durable Objects
=================================================

В этой версии нет PeerJS и Socket.IO. Игра соединяется с Cloudflare через обычный WebSocket.
Комнаты и их пароли обрабатываются сервером Durable Objects.

Файлы:
- wrangler.jsonc     конфигурация Cloudflare Worker, статических файлов и Durable Object
- src/index.js       Worker + LobbyHub Durable Object
- public/index.html  опубликованная игра
- public/test.html   независимая проверка WebSocket
- index.html         копия игры для GitHub Pages / ручной загрузки

Cloudflare Workers Builds:
- Root directory: оставить пустым
- Build command: npm install
- Deploy command: npx wrangler deploy

Важное:
- Имя Worker в wrangler.jsonc: game-server
- Durable Object binding: LOBBY_HUB
- SQLite-backed Durable Object объявлен через exports.LobbyHub
- Сайт отдаётся с того же домена, что и API и WebSocket; CORS не требуется.

Проверка после Deploy:
1. https://ВАШ-WORKER.workers.dev/health
2. https://ВАШ-WORKER.workers.dev/test
3. Откройте /test и нажмите «Запустить проверку».
4. Проверяйте также с телефона через мобильный интернет.

Функции:
- Открытые и закрытые комнаты.
- Пароли хешируются на сервере (PBKDF2-SHA-256 + случайная соль).
- Пароль не возвращается в каталог комнат.
- Код комнаты, список игроков и игровые сообщения передаются через WebSocket.
- Сигналы голосового WebRTC пересылаются через тот же Worker.

Примечание:
Worker использует один Durable Object для каталога и маршрутизации игровых комнат. Данные комнат хранятся в SQLite-backed Durable Object Storage. Активные WebSocket подключаются через Hibernation API.
