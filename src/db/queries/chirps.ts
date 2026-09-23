import { asc, desc, eq } from "drizzle-orm";

import { db } from "../index.js";
import type { NewChirp } from "../schema.js";
import { chirps } from "../schema.js";

export async function createChirp(chirp: NewChirp) {
  const [result] = await db.insert(chirps).values(chirp).returning();
  return result;
}

export type SortDirection = "asc" | "desc";

export async function getAllChirps(
  options: { authorId?: string; sort?: SortDirection } = {},
) {
  const { authorId, sort = "asc" } = options;

  const result = await db
    .select()
    .from(chirps)
    .where(authorId ? eq(chirps.userId, authorId) : undefined)
    .orderBy(
      sort === "desc" ? desc(chirps.createdAt) : asc(chirps.createdAt),
    );
  return result;
}

export async function getChirp(id: string) {
  const [result] = await db.select().from(chirps).where(eq(chirps.id, id));
  return result;
}

export async function deleteChirp(id: string) {
  const [result] = await db.delete(chirps).where(eq(chirps.id, id)).returning();
  return result;
}
