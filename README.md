# Learnify

*Grab. Generate. Learn.*

Learnify is a full-stack, schema-driven learning system: Next.js front end, FastAPI back end, PostgreSQL storage.

## Run locally with Docker

Install Docker Desktop, open a terminal in this folder, then run:

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The browser only talks to the web app; requests to `/api/*` are proxied to the FastAPI service. The API is also reachable directly at [http://localhost:8000](http://localhost:8000), with interactive docs at [http://localhost:8000/docs](http://localhost:8000/docs). PostgreSQL listens on port 5432.

On every start the API container runs `alembic upgrade head` before serving, so the database schema is always current. Each migration runs in one transaction: it either applies fully or not at all.

For local development against Neon, copy `.env.example` to `.env` and set `DATABASE_URL` to your Neon connection URI. Compose still starts its local PostgreSQL container, but the API (and its migrations) use Neon. **Take a Neon backup or branch before starting a build that contains new migrations.**

## Database migrations

The schema lives in Alembic migrations under `api/migrations/versions`. To run them by hand (for example against Neon before deploying the API):

```sh
cd api
pip install -r requirements.txt
DATABASE_URL="postgresql://..." alembic upgrade head
```

To change the schema, edit `api/app/models.py`, then add a migration with `alembic revision -m "describe the change"` and write its `upgrade()`. Migration `0002` uses `ON DELETE SET NULL (column)`, which needs PostgreSQL 15 or newer (Neon's defaults qualify).

## Deploy to Vercel + Neon

Create two Vercel projects connected to the same Git repository:

1. **API project:** Root Directory `api`. Vercel detects the FastAPI app from `index.py`. Set `DATABASE_URL` and a long random `JWT_SECRET` for Production and Preview. Run `alembic upgrade head` against the production database (direct, non-pooled Neon URI) before deploying a version with new migrations; the Vercel function does not migrate on its own. Use the pooled Neon URI as `DATABASE_URL` on Vercel. Generate `JWT_SECRET` with `python -c "import secrets;print(secrets.token_urlsafe(48))"`; the API refuses to start in production with a weak or default secret.
2. **Web project:** Root Directory `web`. Set `API_ORIGIN` to the API project's deployed origin (for example `https://omnilearn-api.vercel.app`) and deploy. `API_ORIGIN` is read at build time for the `/api` proxy, so redeploy the web project after changing it. It is not a secret and is not sent to the browser.
3. Open the web app's URL and create an account.

Because the browser only ever calls the web app's own origin, the session cookie is first-party and works in browsers that block third-party cookies. `CORS_ORIGINS` is only needed if some other origin calls the API directly.

Rotate the Neon password if the connection URI was ever shared outside a secret manager, then store the new URI only in the API project's environment variables and your local `.env`.

## Accounts and sessions

The first screen creates an account; returning users can switch to sign-in. Passwords are hashed with Argon2. On sign-in the API sets a signed JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` unless `COOKIE_SECURE=false`, which local Docker uses because it serves plain http). JavaScript never sees the token. `POST /auth/logout` clears it. Changing `JWT_SECRET` signs everyone out.

## Content IDs

Lessons, questions, vocabulary cards and readings are identified by their subject plus their own ID, so an ID only has to be unique within its subject. Two accounts can import the same JSON without collisions. Subject IDs are global; the API prefixes new ones with a short per-account namespace and returns the stored ID.

## First use

Create a subject, choose **Import materials**, and load `sample_bundle.json` or paste generated JSON. Zod validates the bundle in the browser and Pydantic validates it again in the API.

## Architecture

- `web/` — Next.js 16, React 19, TypeScript, Zod. All API calls go through `web/lib/api.ts` to the `/api` proxy defined in `web/next.config.ts`.
- `api/` — FastAPI, SQLAlchemy 2, Psycopg 3, Argon2, PyJWT, Alembic.
- `docker-compose.yml` — local PostgreSQL, API, and web services. The local database lives in the `omnilearn-db` volume; `docker compose down -v` erases it.
