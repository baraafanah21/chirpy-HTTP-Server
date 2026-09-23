import express from "express";
import type { Request, Response, NextFunction } from "express";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";

import { config } from "./config.js";
import {
  createUser,
  deleteAllUsers,
  getUserByEmail,
  updateUser,
  upgradeUserToChirpyRed,
} from "./db/queries/users.js";
import {
  hashPassword,
  checkPasswordHash,
  makeJWT,
  validateJWT,
  getBearerToken,
  getAPIKey,
  makeRefreshToken,
} from "./auth.js";
import {
  createRefreshToken,
  getUserFromRefreshToken,
  revokeRefreshToken,
} from "./db/queries/refresh.js";
import type { User, UserResponse } from "./db/schema.js";
import {
  createChirp,
  deleteChirp,
  getAllChirps,
  getChirp,
} from "./db/queries/chirps.js";
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";

const ACCESS_TOKEN_SECONDS = 60 * 60;

const migrationClient = postgres(config.db.url, { max: 1 });
await migrate(drizzle(migrationClient), config.db.migrationConfig);

const app = express();

function middlewareLogResponses(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  res.on("finish", () => {
    const statusCode = res.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      console.log(`[NON-OK] ${req.method} ${req.url} - Status: ${statusCode}`);
    }
  });
  next();
}

function middlewareMetricsInc(req: Request, res: Response, next: NextFunction) {
  config.api.fileserverHits++;
  next();
}

function handlerReadiness(req: Request, res: Response) {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send("OK");
}

function handlerMetrics(req: Request, res: Response) {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`
<html>
  <body>
    <h1>Welcome, Chirpy Admin</h1>
    <p>Chirpy has been visited ${config.api.fileserverHits} times!</p>
  </body>
</html>
  `);
}
async function handlerCreateChirp(req: Request, res: Response) {
  type parameters = {
    body: string;
  };

  // The author comes from the signed token, never from the request body.
  const userId = validateJWT(getBearerToken(req), config.api.jwtSecret);

  const params: parameters = req.body;

  if (typeof params?.body !== "string") {
    throw new BadRequestError("Invalid request body");
  }

  if (params.body.length > 140) {
    throw new BadRequestError("Chirp is too long. Max length is 140");
  }

  const chirp = await createChirp({
    body: cleanBody(params.body),
    userId: userId,
  });

  if (!chirp) {
    throw new BadRequestError("Could not create chirp");
  }

  res.status(201).json(chirp);
}

async function handlerGetAllChirps(req: Request, res: Response) {
  // Anything can show up in the query string, so only a string is a filter.
  const authorIdQuery = req.query.authorId;
  const authorId =
    typeof authorIdQuery === "string" && authorIdQuery !== ""
      ? authorIdQuery
      : undefined;

  // Anything other than an explicit "desc" keeps the default ascending order.
  const sort = req.query.sort === "desc" ? "desc" : "asc";

  const allChirps = await getAllChirps({ authorId, sort });
  res.status(200).json(allChirps);
}

async function handlerGetChirp(req: Request, res: Response) {
  const { chirpId } = req.params;

  if (typeof chirpId !== "string") {
    throw new BadRequestError("Missing chirp ID");
  }

  const chirp = await getChirp(chirpId);

  if (!chirp) {
    throw new NotFoundError(`Chirp with id ${chirpId} not found`);
  }

  res.status(200).json(chirp);
}

async function handlerDeleteChirp(req: Request, res: Response) {
  const userId = validateJWT(getBearerToken(req), config.api.jwtSecret);

  const { chirpId } = req.params;

  if (typeof chirpId !== "string") {
    throw new BadRequestError("Missing chirp ID");
  }

  const chirp = await getChirp(chirpId);

  if (!chirp) {
    throw new NotFoundError(`Chirp with id ${chirpId} not found`);
  }

  // Only the author may delete their own chirp.
  if (chirp.userId !== userId) {
    throw new ForbiddenError("You are not the author of this chirp");
  }

  await deleteChirp(chirpId);

  res.status(204).send();
}

function toUserResponse(user: User): UserResponse {
  const { hashedPassword, ...rest } = user;
  return rest;
}

async function handlerCreateUser(req: Request, res: Response) {
  type parameters = {
    email: string;
    password: string;
  };

  const params: parameters = req.body;

  if (typeof params?.email !== "string") {
    throw new BadRequestError("Missing required field: email");
  }

  if (typeof params?.password !== "string") {
    throw new BadRequestError("Missing required field: password");
  }

  const user = await createUser({
    email: params.email,
    hashedPassword: await hashPassword(params.password),
  });

  if (!user) {
    throw new BadRequestError("Could not create user");
  }

  res.status(201).json(toUserResponse(user));
}

async function handlerUpdateUser(req: Request, res: Response) {
  type parameters = {
    email: string;
    password: string;
  };

  // The user being updated comes from the signed token, never from the request.
  const userId = validateJWT(getBearerToken(req), config.api.jwtSecret);

  const params: parameters = req.body;

  if (typeof params?.email !== "string") {
    throw new BadRequestError("Missing required field: email");
  }

  if (typeof params?.password !== "string") {
    throw new BadRequestError("Missing required field: password");
  }

  const user = await updateUser(userId, {
    email: params.email,
    hashedPassword: await hashPassword(params.password),
  });

  if (!user) {
    throw new NotFoundError(`User with id ${userId} not found`);
  }

  res.status(200).json(toUserResponse(user));
}

async function handlerLogin(req: Request, res: Response) {
  type parameters = {
    email: string;
    password: string;
  };

  const params: parameters = req.body;

  if (
    typeof params?.email !== "string" ||
    typeof params?.password !== "string"
  ) {
    throw new UnauthorizedError("incorrect email or password");
  }

  const user = await getUserByEmail(params.email);

  if (!user) {
    throw new UnauthorizedError("incorrect email or password");
  }

  const matches = await checkPasswordHash(params.password, user.hashedPassword);

  if (!matches) {
    throw new UnauthorizedError("incorrect email or password");
  }

  const token = makeJWT(user.id, ACCESS_TOKEN_SECONDS, config.api.jwtSecret);

  const refreshToken = makeRefreshToken();
  await createRefreshToken(refreshToken, user.id);

  res.status(200).json({ ...toUserResponse(user), token, refreshToken });
}

async function handlerRefresh(req: Request, res: Response) {
  const refreshToken = getBearerToken(req);

  // The query only matches tokens that are unrevoked and unexpired.
  const user = await getUserFromRefreshToken(refreshToken);

  if (!user) {
    throw new UnauthorizedError("Invalid refresh token");
  }

  const token = makeJWT(user.id, ACCESS_TOKEN_SECONDS, config.api.jwtSecret);

  res.status(200).json({ token });
}

async function handlerRevoke(req: Request, res: Response) {
  const refreshToken = getBearerToken(req);

  await revokeRefreshToken(refreshToken);

  res.status(204).send();
}

async function handlerPolkaWebhook(req: Request, res: Response) {
  type parameters = {
    event: string;
    data: {
      userId: string;
    };
  };

  // Only Polka knows this key, so only Polka can grant Chirpy Red.
  if (getAPIKey(req) !== config.api.polkaKey) {
    throw new UnauthorizedError("Invalid API key");
  }

  const params: parameters = req.body;

  // Polka sends every event type; we only act on upgrades.
  if (params?.event !== "user.upgraded") {
    res.status(204).send();
    return;
  }

  if (typeof params?.data?.userId !== "string") {
    throw new BadRequestError("Missing required field: data.userId");
  }

  // Setting the flag that's already set is a no-op, so retries are harmless.
  const user = await upgradeUserToChirpyRed(params.data.userId);

  if (!user) {
    throw new NotFoundError(`User with id ${params.data.userId} not found`);
  }

  res.status(204).send();
}

async function handlerReset(req: Request, res: Response) {
  if (config.api.platform !== "dev") {
    throw new ForbiddenError("Reset is only allowed in dev environment");
  }

  config.api.fileserverHits = 0;
  await deleteAllUsers();

  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send("OK");
}

function cleanBody(body: string): string {
  const badWords = ["kerfuffle", "sharbert", "fornax"];

  const words = body.split(" ");

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word && badWords.includes(word.toLowerCase())) {
      words[i] = "****";
    }
  }

  return words.join(" ");
}
app.use(express.json());
app.use(middlewareLogResponses);

app.use("/app", middlewareMetricsInc, express.static("./src/app"));

app.get("/api/healthz", handlerReadiness);
app.get("/admin/metrics", handlerMetrics);
app.post("/admin/reset", handlerReset);
app.post("/api/users", handlerCreateUser);
app.put("/api/users", handlerUpdateUser);
app.post("/api/login", handlerLogin);
app.post("/api/refresh", handlerRefresh);
app.post("/api/revoke", handlerRevoke);
app.post("/api/chirps", handlerCreateChirp);
app.get("/api/chirps", handlerGetAllChirps);
app.get("/api/chirps/:chirpId", handlerGetChirp);
app.delete("/api/chirps/:chirpId", handlerDeleteChirp);
app.post("/api/polka/webhooks", handlerPolkaWebhook);
app.use(errorHandler);
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof UnauthorizedError) {
    res.status(401).json({ error: err.message });
    return;
  }
  if (err instanceof ForbiddenError) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }

  console.log(err.message);
  res.status(500).json({ error: "Something went wrong on our end" });
}
app.listen(config.api.port, () => {
  console.log(`Server is running at http://localhost:${config.api.port}`);
});
