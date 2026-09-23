# Chirpy

A small social API — users post short messages ("chirps") of 140 characters or less. Built from scratch in TypeScript with Express and PostgreSQL, no framework scaffolding.

## Stack

| Layer            | Tool                     |
| ---------------- | ------------------------ |
| Runtime          | Node.js 22.14.0          |
| Language         | TypeScript (strict, ESM) |
| HTTP             | Express 5                |
| Database         | PostgreSQL 15+           |
| ORM / migrations | Drizzle + Drizzle Kit    |
| Password hashing | argon2                   |
| Tokens           | jsonwebtoken (JWT)       |
| Tests            | Vitest                   |

## Requirements

- Node.js 22.14.0 (an `.nvmrc` is included — run `nvm use`)
- PostgreSQL 15 or later, running locally

## Setup

```bash
git clone <repo-url>
cd web-servers
nvm use
npm install
```

Create the database:

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE chirpy;
ALTER USER postgres PASSWORD 'postgres';
\q
```

Create a `.env` file in the project root:

```
DB_URL="postgres://postgres:postgres@localhost:5432/chirpy?sslmode=disable"
PORT=8080
PLATFORM="dev"
JWT_SECRET="<generate with: openssl rand -base64 64>"
POLKA_KEY="<your payment provider api key>"
```

`.env` is gitignored. Never commit it.

## Running

```bash
npm run dev
```

Compiles to `dist/` and starts the server. Pending migrations run automatically on startup, so the schema is always current.

The server listens on `http://localhost:8080`.

### Scripts

| Command            | What it does                             |
| ------------------ | ---------------------------------------- |
| `npm run dev`      | Compile and run                          |
| `npm run build`    | Compile only                             |
| `npm start`        | Run the compiled output                  |
| `npm test`         | Run the Vitest suite                     |
| `npm run generate` | Generate a migration from schema changes |
| `npm run migrate`  | Apply migrations manually                |

## Architecture

Chirpy is a monolith, but the front-end and API are kept in separate namespaces so they could be split later without breaking clients.

```
/app/*     static files (src/app/)
/api/*     JSON API
/admin/*   internal tooling
```

```
src/
├── index.ts              route registration, handlers, server startup
├── config.ts             environment variables and app config
├── auth.ts               hashing, JWTs, header parsing
├── auth.test.ts          unit tests
├── errors.ts             custom error classes
├── app/                  static files served at /app
└── db/
    ├── index.ts          Drizzle client
    ├── schema.ts         table definitions
    ├── migrations/       generated SQL
    └── queries/          users.ts, chirps.ts, refresh.ts
```

### Error handling

Handlers throw typed errors; a single error-handling middleware maps them to status codes.

| Class               | Status                               |
| ------------------- | ------------------------------------ |
| `BadRequestError`   | 400                                  |
| `UnauthorizedError` | 401                                  |
| `ForbiddenError`    | 403                                  |
| `NotFoundError`     | 404                                  |
| anything else       | 500 (message logged, never returned) |

Only messages from custom errors reach the client. Unexpected errors return a generic message so internal details aren't leaked.

## Authentication

Two token types:

- **Access token** — a JWT, expires in 1 hour, stateless, cannot be revoked. Sent as `Authorization: Bearer <token>`.
- **Refresh token** — a random 256-bit string stored in the database, expires in 60 days, revocable. Used only to mint new access tokens.

Passwords are hashed with argon2 and never returned in any response.

Webhook endpoints authenticate with a shared API key (`Authorization: ApiKey <key>`) rather than a user token.

## API

### Health

```
GET /api/healthz          → 200 "OK"
```

### Users

```
POST /api/users
{ "email": "user@example.com", "password": "secret" }
→ 201 { id, email, createdAt, updatedAt, isChirpyRed }
```

```
PUT /api/users                          (requires access token)
{ "email": "new@example.com", "password": "newsecret" }
→ 200 { id, email, createdAt, updatedAt, isChirpyRed }
```

Updates the authenticated user only — there is no user ID in the path, so one user cannot modify another.

### Sessions

```
POST /api/login
{ "email": "user@example.com", "password": "secret" }
→ 200 { id, email, createdAt, updatedAt, isChirpyRed, token, refreshToken }
```

```
POST /api/refresh                       (Authorization: Bearer <refresh-token>)
→ 200 { token }
```

```
POST /api/revoke                        (Authorization: Bearer <refresh-token>)
→ 204
```

### Chirps

```
POST /api/chirps                        (requires access token)
{ "body": "Hello, world!" }
→ 201 { id, createdAt, updatedAt, body, userId }
```

The author is taken from the token, not the request body. Chirps over 140 characters are rejected with 400. A small set of banned words is replaced with `****` before storage.

```
GET /api/chirps
GET /api/chirps?authorId=<uuid>
→ 200 [ { id, createdAt, updatedAt, body, userId }, ... ]
```

Sorted by creation time, ascending. Filtering happens in the database.

```
GET /api/chirps/:chirpId
→ 200 { id, createdAt, updatedAt, body, userId }
→ 404 if not found
```

```
DELETE /api/chirps/:chirpId             (requires access token)
→ 204 on success
→ 403 if the chirp belongs to another user
→ 404 if not found
```

### Webhooks

```
POST /api/polka/webhooks                (Authorization: ApiKey <POLKA_KEY>)
{ "event": "user.upgraded", "data": { "userId": "<uuid>" } }
→ 204 on success, or for any event other than user.upgraded
→ 401 if the API key is missing or wrong
→ 404 if the user doesn't exist
```

Idempotent: the handler sets a final state rather than applying a delta, so repeated deliveries are safe.

### Admin

```
GET  /admin/metrics       → HTML page showing /app hit count
POST /admin/reset         → resets the counter and deletes all users
```

`/admin/reset` returns 403 unless `PLATFORM=dev`. The namespace itself grants no protection — the environment check does.

## Database

Three tables. `chirps.user_id` and `refresh_tokens.user_id` both reference `users.id` with `ON DELETE CASCADE`, so deleting a user removes their chirps and sessions.

**users** — `id`, `created_at`, `updated_at`, `email` (unique), `hashed_password`, `is_chirpy_red`

**chirps** — `id`, `created_at`, `updated_at`, `body`, `user_id`

**refresh_tokens** — `token` (primary key), `created_at`, `updated_at`, `user_id`, `expires_at`, `revoked_at`

Revocation is soft: `revoked_at` is set rather than the row being deleted, leaving an audit trail.

### Changing the schema

Edit `src/db/schema.ts`, then:

```bash
npm run generate
```

Review the generated SQL in `src/db/migrations/`. It will be applied the next time the server starts.

## Testing

```bash
npm test
```

Covers password hashing, JWT creation and validation (including expired tokens and wrong secrets), and `Authorization` header parsing.

## Notes

- `src/app` is the only directory exposed by the static file server. Nothing above it is reachable.
- Changing a password does not currently revoke existing refresh tokens.
- Built as part of the Boot.dev "Learn HTTP Servers in TypeScript" course.
