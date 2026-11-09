# Деплой (Fly.io + GHCR + GitHub Actions)

Конвеєр: **тег `v*` → перевірки (typecheck, тести) → збірка образу → GHCR → `flyctl deploy --image` → smoke-перевірка `/health` (порівнює `sha` із комітом тегу)**. Файл: `.github/workflows/release.yml`. Звичайний CI (`ci.yml`) лишається гейтом для гілок і PR.

## Одноразове налаштування (робить власник акаунта)

```bash
# 1. Fly
fly auth signup            # або fly auth login
fly apps create <унікальне-ім'я>       # впишіть те саме ім'я в fly.toml (app = "...")
fly tokens create deploy -a <ім'я>     # скопіюйте токен

# 2. GitHub: Settings → Secrets and variables → Actions
#    Secret   FLY_API_TOKEN = <токен>
#    Variable FLY_APP       = <ім'я застосунку>

# 3. Образ у GHCR має бути ПУБЛІЧНИМ, щоб Fly міг його витягнути без облікових даних:
#    після першого релізу: GitHub → Packages → dogfight → Package settings → Change visibility → Public.
#    (Приватний образ: `fly deploy --image ... ` потребує `fly auth docker` / registry-токена — тут не налаштовано.)
```

Змінні середовища застосунку — у секції `[env]` файлу `fly.toml` (`TRUST_PROXY=1`, `LOG_LEVEL`, за потреби `ALLOWED_ORIGINS` для власного домену). Same-origin дозволений автоматично, тож для `https://<ім'я>.fly.dev` нічого додавати не треба.

## Реліз

```bash
git tag v1.0.0 && git push origin v1.0.0     # запускає release.yml
```

Дивіться Actions → release. Після зеленого прогону: `curl https://<ім'я>.fly.dev/health` повертає `"sha"` = SHA коміту тегу, а в куті гри видно `v1.0.0 · abc1234`.

Відкат: `fly releases -a <ім'я>` → `fly deploy -a <ім'я> --image ghcr.io/<власник>/dogfight:<попередній-тег>`.

## Локально «як у проді»

```bash
docker compose up --build        # http://localhost:3000, реплеї — у volume dogfight-data
docker compose stop              # має завершитись < 10 с (graceful shutdown)
```

## Спостережуваність

- `GET /health` — liveness (+ `version`, `sha`), `GET /ready` — readiness, `GET /metrics` — Prometheus.
- Логи — JSON у stdout: `fly logs -a <ім'я>` / `docker logs`.
- `/metrics` публічний разом із застосунком (метрики не містять персональних даних). Якщо це небажано — `ENABLE_METRICS=0` або обмежте маршрут на проксі.
