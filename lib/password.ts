import bcrypt from "bcryptjs";

export const MIN_PASSWORD_LENGTH = 8;

/** Cost factor for bcrypt. Keep in sync with scripts/make-user-sql.mjs. */
const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
