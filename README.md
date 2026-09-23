# Chirpy

A small social API where users post 140-character messages called **chirps**. Built with Express 5, TypeScript, Postgres, and Drizzle ORM.

## Getting started

### Requirements

- Node (see [.nvmrc](.nvmrc))
- A Postgres database

### Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
DB_URL=postgres://user:password@localhost:5432/chirpy
PORT=8080
PLATFORM="dev"
JWT_SECRET=<a long random string>
POLKA_KEY=<the API key Polka sends on its webhooks>
```

Every variable is required — the server throws on startup if one is missing. Generate a `JWT_SECRET` with:

```bash
openssl rand -base64 64
```

Set `PLATFORM` to `dev` only in local development; it gates the destructive reset endpoint.

### Running

```bash
npm run dev    # compile and start
npm run build  # compile only
npm start      # run the compiled output
npm test       # run the unit tests
```

Pending migrations are applied automatically on startup. To create a new migration after editing [src/db/schema.ts](src/db/schema.ts):

```bash
npm run generate   # write a migration from the schema diff
npm run migrate    # apply it without starting the server
```

## Authentication

Chirpy uses two tokens.

**Access token** — a JWT, valid for **1 hour**. Send it on authenticated requests:

```
Authorization: Bearer <access token>
```

**Refresh token** — a 64-character hex string, valid for **60 days**. It is used only to obtain a new access token, and is sent the same way (`Authorization: Bearer <refresh token>`) to `/api/refresh` and `/api/revoke`.

Both are issued by `POST /api/login`. The usual flow is: log in once, keep the refresh token in durable storage, and exchange it for a fresh access token whenever the old one expires.

A missing, malformed, or expired token on an authenticated endpoint returns `401`.

## Resources

### User

```json
{
  "id": "3311741c-680c-4546-99f3-fc9efac2036c",
  "createdAt": "2026-09-23T10:00:00.000Z",
  "updatedAt": "2026-09-23T10:00:00.000Z",
  "email": "bara@example.com",
  "isChirpyRed": false
}
```

`isChirpyRed` marks a paid Chirpy Red membership. The password hash is never included in any response.

### Chirp

```json
{
  "id": "94b7e44c-3604-42e3-bef7-ebfcc3efff8f",
  "createdAt": "2026-09-23T10:00:00.000Z",
  "updatedAt": "2026-09-23T10:00:00.000Z",
  "body": "Hello, world!",
  "userId": "3311741c-680c-4546-99f3-fc9efac2036c"
}
```

## Errors

Every error response is JSON with a single `error` field:

```json
{ "error": "Chirp is too long. Max length is 140" }
```

| Status | Meaning |
| --- | --- |
| `400` | The request body is missing a field or has the wrong type |
| `401` | Authentication failed — no token, a malformed one, or bad credentials |
| `403` | Authenticated, but not allowed to touch this resource |
| `404` | No such resource |
| `500` | Something went wrong server-side |

## Endpoints

### Users

#### `POST /api/users`

Create a user. No authentication.

```json
{ "email": "bara@example.com", "password": "hunter2" }
```

`201` with the [User](#user) resource. `400` if either field is missing.

#### `PUT /api/users`

Update the authenticated user's email and password. **Requires an access token.**

```json
{ "email": "new@example.com", "password": "new-password" }
```

`200` with the updated [User](#user). The user being updated is taken from the token, so you can only ever update yourself. `400` if either field is missing, `401` if the token is missing or invalid.

#### `POST /api/login`

Exchange credentials for tokens. No authentication.

```json
{ "email": "bara@example.com", "password": "hunter2" }
```

`200` with the [User](#user) resource plus two extra fields:

```json
{
  "id": "3311741c-680c-4546-99f3-fc9efac2036c",
  "createdAt": "2026-09-23T10:00:00.000Z",
  "updatedAt": "2026-09-23T10:00:00.000Z",
  "email": "bara@example.com",
  "isChirpyRed": false,
  "token": "<access token>",
  "refreshToken": "<refresh token>"
}
```

`401` on a wrong email or password — the message is identical either way, so it does not reveal whether an account exists.

#### `POST /api/refresh`

Get a new access token. Send a **refresh token** in the `Authorization` header; no request body.

`200` with `{ "token": "<access token>" }`. `401` if the refresh token is unknown, revoked, or expired.

#### `POST /api/revoke`

Revoke a refresh token, ending that session. Send the **refresh token** in the `Authorization` header; no request body.

`204` with no body.

### Chirps

#### `POST /api/chirps`

Post a chirp. **Requires an access token.**

```json
{ "body": "Hello, world!" }
```

`201` with the [Chirp](#chirp) resource. The author is taken from the token — there is no way to post as someone else. A body over 140 characters returns `400`. The words *kerfuffle*, *sharbert*, and *fornax* are replaced with `****` before the chirp is stored.

#### `GET /api/chirps`

List chirps. No authentication.

| Query parameter | Description |
| --- | --- |
| `authorId` | Optional. Return only chirps by this user. |
| `sort` | Optional. `asc` (default) for oldest first, `desc` for newest first, by creation time. |

Both parameters can be combined, and an unrecognized value for either is ignored rather than rejected.

```
GET /api/chirps
GET /api/chirps?authorId=3311741c-680c-4546-99f3-fc9efac2036c
GET /api/chirps?sort=desc
GET /api/chirps?authorId=3311741c-680c-4546-99f3-fc9efac2036c&sort=desc
```

`200` with an array of [Chirp](#chirp) resources, or `[]` if there are no matches.

#### `GET /api/chirps/:chirpId`

Fetch one chirp. No authentication.

`200` with the [Chirp](#chirp) resource, or `404` if no chirp has that id.

#### `DELETE /api/chirps/:chirpId`

Delete a chirp. **Requires an access token.**

`204` with no body. `403` if you are not the chirp's author, `404` if no chirp has that id.

### Webhooks

#### `POST /api/polka/webhooks`

Called by Polka, the payment provider, when a user's membership changes. Not for client use.

Authenticated with Polka's API key rather than a user token:

```
Authorization: ApiKey <POLKA_KEY>
```

```json
{
  "event": "user.upgraded",
  "data": { "userId": "3311741c-680c-4546-99f3-fc9efac2036c" }
}
```

`204` with no body on success, and also `204` for any `event` other than `user.upgraded` — those are ignored. `401` if the API key is missing or wrong, `404` if no user has that id.

The handler is idempotent: granting Chirpy Red to a member who already has it changes nothing, so Polka's retries are safe. Polka retries on any non-`2XX` response.

### Admin and health

#### `GET /api/healthz`

Readiness check. `200` with the plain text body `OK`.

#### `GET /admin/metrics`

An HTML page showing how many times the static file server has been hit.

#### `POST /admin/reset`

**Deletes every user**, and all chirps and refresh tokens along with them via cascade, then zeroes the hit counter. Only available when `PLATFORM=dev`; returns `403` otherwise.

### Static files

`GET /app` serves the static site in [src/app/](src/app/). Requests here increment the counter reported by `/admin/metrics`.

## Project layout

```
src/
  index.ts          Express app: handlers, routes, error handling
  auth.ts           Password hashing, JWTs, Authorization header parsing
  auth.test.ts      Unit tests for auth.ts
  config.ts         Environment variables, validated at startup
  errors.ts         Error classes that map to HTTP status codes
  db/
    index.ts        Database connection
    schema.ts       Drizzle table definitions and inferred types
    queries/        One module per table
    migrations/     Generated SQL — edit the schema, not these
  app/              Static files served at /app
```

Handlers throw the error classes from [src/errors.ts](src/errors.ts); the error handler at the bottom of [src/index.ts](src/index.ts) turns each one into its status code. Adding a new failure mode means throwing the matching class, not writing a response.
