# Чеклист запуску (те, що може зробити лише власник)

Нічого з цього не вигадано й не заповнено наперед. Відмічайте після виконання й переносіть реальні цифри в README.

## Деплой і живий URL
- [ ] Налаштувати Fly і секрети за [DEPLOY.md](DEPLOY.md), зробити образ GHCR публічним.
- [ ] `git tag v1.0.0 && git push origin v1.0.0` → release зелений, `curl https://<app>.fly.dev/health` віддає `sha`.
- [ ] Підставити URL у README (блок «Грати») і в `ALLOWED_ORIGINS`, якщо власний домен.
- [ ] Перевірити `wss://`: у DevTools → Network → WS видно з'єднання `wss://<app>.fly.dev/ws`.

## Образ Docker (не міряно в розробці — немає демона)
- [ ] `docker build -t dogfight:local --build-arg GIT_SHA=local .` → `docker images dogfight:local` → **< 200 МБ**? Внести число в README.
- [ ] `docker run -d --name df -p 3000:3000 dogfight:local`, `docker inspect --format '{{.State.Health.Status}}' df` → `healthy`; `docker exec df id` → не root (`uid=1000(node)`).
- [ ] `time docker stop df` → швидко (< 10 с, код 0). Порівняти з `CMD npm start` (очікується 10 с + код 137) — Prove-it 1.
- [ ] Кеш шарів: змінити 1 рядок у `client/src`, зібрати двічі — `npm ci` береться з кешу (Prove-it 2).

## Два гравці на різних мережах
- [ ] Двоє людей у різних мережах граються в одну кімнату ≥ 2 хв (запис екрана).
- [ ] `F3` (netgraph) → зняти RTT/втрати/поправку; **знеособлені** цифри (без імен/IP) в таблицю «Реальна мережа» README.
- [ ] Закрити Prove-it 3 (`ws://` зі сторінки `https://` → помилка mixed content) у консолі живої сторінки.
- [ ] Chaos проти живого сервера: `node scripts/chaos/chaos.mjs client-kill --target https://<app>.fly.dev` (на цільовому сервері має бути `MAX_PLAYERS_PER_ROOM ≥ 32` і `MAX_CONNECTIONS_PER_IP ≥ 30`, інакше зменште кількість клієнтів у скрипті). `flood` проти живого теж можливий: з одного IP спрацює ліміт з'єднань — це очікувана відповідь.

## Uptime-монітор
- [ ] Створити монітор (UptimeRobot / Better Stack / Fly checks), URL `https://<app>.fly.dev/health`, інтервал 1–5 хв, сповіщення на пошту.
- [ ] Додати посилання на статус у README. Перевірити, що алерт приходить (тимчасово `fly machine stop`).

## PWA
- [ ] Android/Chrome: відкрити сайт → «Встановити застосунок»; запускається повноекранно, іконка видна.
- [ ] iOS/Safari: «Поділитись → На початковий екран».
- [ ] DevTools → Application → Manifest без помилок; Service Worker активний (лише в production-збірці).
- [ ] (необов'язково) сторінка на itch.io.

## Матеріали
- [ ] Демо-відео (1–2 хв: гра, два гравці, netgraph, `/metrics`) → посилання в README.
- [ ] 5-хвилинне демо: проблема → архітектура → вимірювання → деплой → що далі.
- [ ] Теги: `git tag lab-08` (здача) і `git tag v1.0.0` (реліз). Лише ви комітите/тегуєте/пушите.

## Стретч (за бажанням)
- [ ] Два інстанси за проксі з sticky за room id (`fly-force-instance-id`/replay-header) — довести, що кімнати розподіляються.
- [ ] Redis pub/sub замість sticky — виміряти додаткову затримку.
- [ ] Sentry + навмисний виняток у боті. Пост-мортем найгіршої проблеми (час, причина, виправлення, профілактика).
