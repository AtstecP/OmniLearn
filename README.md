# OmniLearn

OmniLearn is a full-stack, local-first learning system based on the supplied architecture.

## Deploy to Vercel + Neon

Vercel deploys each app directory as its own project from one repository. Create two Vercel projects connected to the same Git repository:

1. **API project:** set Root Directory to `outputs/OmniLearn/api` (or `api` if this folder is the repository root). Vercel detects the FastAPI app from `index.py` and installs `requirements.txt`. Add `DATABASE_URL` and a long random `JWT_SECRET` to its Production and Preview Environment Variables, then deploy.
2. **Web project:** set Root Directory to `outputs/OmniLearn/web` (or `web` if this folder is the repository root). Vercel detects Next.js automatically. Set `NEXT_PUBLIC_API_URL` to the API project's deployed domain and deploy.
3. Copy the web project's deployed origin into the API project's `CORS_ORIGINS` variable (no trailing slash), then redeploy the API.
4. For Preview deployments, add each preview web origin to `CORS_ORIGINS`, or use a stable Vercel domain for the web project.

The API uses the native Vercel Python runtime for FastAPI, so it does not need a separate Docker host. Vercel supports FastAPI as a Python Function, and its monorepo workflow allows multiple projects to use different root directories from one Git repository ([FastAPI deployment guide](https://vercel.com/kb/guide/ship-a-fastapi-app-on-vercel), [Vercel monorepos](https://vercel.com/docs/monorepos)).

The connection URL you shared is a credential. Rotate its password in Neon before production, then store the new URI only in Vercel's API project environment variables. No Neon API key is needed by this application; it uses the PostgreSQL connection URI.

The first screen creates an account by default; returning users can switch to sign-in. The API hashes passwords with Argon2, returns a signed JWT, and scopes subjects and study progress to that account. The browser stores the token in `localStorage` and sends it as a Bearer token. Account settings support password changes and an account reset that requires the current password and the typed word `DELETE`; reset removes the account and its learning data. Set a unique, long random `JWT_SECRET` on Vercel; changing it invalidates existing login tokens.

## Run locally with Docker

Install Docker Desktop, open a terminal in this folder, then run:

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) for the Next.js app. The FastAPI service is at [http://localhost:8000](http://localhost:8000), with interactive API documentation at [http://localhost:8000/docs](http://localhost:8000/docs). PostgreSQL listens on port 5432. The first database initialization uses `api/sql/schema.sql`; SQLAlchemy also creates missing tables at API startup.

For local development against Neon, copy `.env.example` to `.env` and replace `DATABASE_URL` with the rotated connection URI. Docker Compose still starts its local PostgreSQL container, but the API connects to Neon when `DATABASE_URL` points there.

## Database notes

The API accepts both `postgresql://...` and `postgresql+psycopg://...` URLs and uses the Psycopg v3 driver. Keep credentials in `.env` locally and Vercel Environment Variables in production. The browser only needs `NEXT_PUBLIC_API_URL` to locate the API. Rebuild containers after changing connection settings:

```sh
docker compose down
docker compose up --build
```

Local PostgreSQL uses a named Docker volume. To remove it and erase local database content, run `docker compose down -v`.

## First use

Create a subject in the app, then choose **Import materials** and load `sample_bundle.json`. You can also paste generated JSON into the importer. Zod validates bundle structure in the browser, and FastAPI/Pydantic validates it again before PostgreSQL writes.

## Architecture

- `web/` — Next.js 16, React 19, TypeScript, and Zod. Account creation/sign-in, first-subject JSON onboarding, dashboard and subject switcher, roadmap reader, vocabulary topic tiles and all three practice modes, reading comprehension, custom timed or untimed test sessions, lesson tests, account settings, mistake notebook, and JSON import/export.
- `api/` — FastAPI REST API with Argon2 password hashing, JWT validation, account-scoped data access, Pydantic request validation, SQLAlchemy relational models, SM-2-style review scheduling, attempt and graduation tracking, and OpenAPI docs.
- `api/sql/schema.sql` — PostgreSQL DDL and indexes for the relational schema. `user_node_progress` supplements the supplied schema to persist roadmap mastery.
- `docker-compose.yml` — local PostgreSQL, API, and web services.

Existing subjects created before accounts are enabled are assigned to the first account that registers. New records are scoped to their owner. Keep `JWT_SECRET` and `DATABASE_URL` in server-side environment variables only.

The original standalone browser prototype is retained at `index.html`; use the Docker Compose app for the full-stack architecture.
