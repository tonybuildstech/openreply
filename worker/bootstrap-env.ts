// Loads a local `.env` into process.env before anything else in the worker
// evaluates. MUST be imported first (import side-effects run top-to-bottom, and
// the modules below read env). The web app gets this for free from Next; the
// worker process does not, and nothing in the codebase uses dotenv.
//
// Safe everywhere: on hosts that inject env (Railway, PM2 with a sourced .env)
// there is either no ./.env or it holds the same values, so loading it is a
// harmless no-op. Skipped entirely when no .env file is present.
import { existsSync } from "node:fs";

const loadEnvFile = (
  process as unknown as { loadEnvFile?: (path?: string) => void }
).loadEnvFile;

if (typeof loadEnvFile === "function" && existsSync(".env")) {
  loadEnvFile(".env");
}
