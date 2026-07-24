#!/usr/bin/env node
/**
 * Generate a ready-to-paste SQL INSERT for a new OpenReply user.
 *
 * There is no self-service registration — accounts are created by an admin.
 * This hashes the password with bcrypt (cost 12, matching lib/password.ts) and
 * prints an INSERT you can run in the Supabase SQL editor (or via psql).
 *
 * Usage:
 *   node scripts/make-user-sql.mjs <email> <password> [name]
 *
 * Example:
 *   node scripts/make-user-sql.mjs admin@acme.com "s3cret-pass" "Admin"
 */
import bcrypt from "bcryptjs";

const [, , emailArg, password, name] = process.argv;

if (!emailArg || !password) {
  console.error(
    "Usage: node scripts/make-user-sql.mjs <email> <password> [name]"
  );
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const hash = bcrypt.hashSync(password, 12);
// Escape single quotes for safe SQL string literals.
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const nameValue = name ? q(name) : "NULL";

console.log(`insert into "User" (id, name, email, "emailVerified", password, "createdAt", "updatedAt")
values (gen_random_uuid()::text, ${nameValue}, ${q(email)}, now(), ${q(hash)}, now(), now());`);
