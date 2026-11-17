import "dotenv/config";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { createApp } from "./app.js";
import {
  createDependencies,
  parseEmailConfirmationSetting
} from "./config/dependencies.js";
import { logger } from "./utils/logger.js";

const port = Number(process.env.PORT) || 3000;
const sessionSecret = process.env.SESSION_SECRET;
const databaseUrl = process.env.DATABASE_URL;

if (!sessionSecret) {
  throw new Error(
    "Falta SESSION_SECRET. Configúrala en el archivo .env o en el proveedor cloud."
  );
}

if (!databaseUrl) {
  throw new Error(
    "Falta DATABASE_URL. Configúrala en el archivo .env o en el proveedor cloud."
  );
}

const isProduction = process.env.NODE_ENV === "production";
const requireEmailConfirmation = parseEmailConfirmationSetting(
  process.env.REQUIRE_EMAIL_CONFIRMATION, { isProduction }
);

const {
  pool,
  userService,
  mealService
} = await createDependencies({
  databaseUrl,
  requireEmailConfirmation,
  isProduction,
  brevoApiKey: process.env.BREVO_API_KEY,
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL,
  brevoSenderName: process.env.BREVO_SENDER_NAME,
  appBaseUrl: process.env.APP_BASE_URL,
  isDevelopment: (process.env.NODE_ENV ?? "development") === "development",
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD
});

const PostgresSessionStore = connectPgSimple(session);

const sessionStore = new PostgresSessionStore({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true
});

const app = createApp({
  userService,
  mealService,
  sessionSecret,
  sessionStore,
  isProduction
});

app.listen(port, () => {
  logger.info("server.started", {
    port,
    environment:
      process.env.NODE_ENV ?? "development"
  });
});
