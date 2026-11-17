import {
  createDatabasePool,
  initializeDatabase
} from "./database.js";
import {
  PostgresUserRepository
} from "../repositories/postgresUser.repository.js";
import { UserService } from "../services/user.service.js";
import { PostgresMealRepository } from "../repositories/postgresMeal.repository.js";
import { MealService } from "../services/meal.service.js";
import { BrevoEmailService } from "../services/brevoEmail.service.js";
import { EmailConfirmationService, validateAppBaseUrl } from "../services/emailConfirmation.service.js";
import { AppError } from "../utils/appError.js";

function confirmationConfigurationError() {
  return new AppError("REQUIRE_EMAIL_CONFIRMATION debe ser explícita y true en producción", 500, "EMAIL_CONFIRMATION_CONFIG_ERROR");
}

export function parseEmailConfirmationSetting(value, { isProduction = false } = {}) {
  if (!["true", "false"].includes(value) || (isProduction && value !== "true")) {
    throw confirmationConfigurationError();
  }
  return value === "true";
}

export async function createDependencies({
  databaseUrl,
  requireEmailConfirmation = false,
  brevoApiKey,
  brevoSenderEmail,
  brevoSenderName,
  appBaseUrl,
  isDevelopment = false,
  isProduction = false,
  adminEmail,
  adminPassword,
  passwordRounds = 10
} = {}) {
  if (typeof requireEmailConfirmation !== "boolean" || (isProduction && !requireEmailConfirmation)) {
    throw confirmationConfigurationError();
  }
  const allowLocalHttp = isDevelopment && !isProduction;
  let brevoEmailService;
  if (requireEmailConfirmation) {
    validateAppBaseUrl(appBaseUrl, allowLocalHttp);
    if (typeof brevoSenderName !== "string" || !brevoSenderName.trim()) {
      throw new AppError("La configuración del servicio de correo no es válida", 500, "EMAIL_SERVICE_CONFIG_ERROR");
    }
    brevoEmailService = new BrevoEmailService({
      apiKey: brevoApiKey, senderEmail: brevoSenderEmail, senderName: brevoSenderName, isDevelopment: allowLocalHttp
    });
  }

  const pool = createDatabasePool(databaseUrl);
  await initializeDatabase(pool);

  const userRepository =
    new PostgresUserRepository(pool);
  const emailConfirmationService = requireEmailConfirmation
    ? new EmailConfirmationService({ userRepository, brevoEmailService, appBaseUrl, isDevelopment: allowLocalHttp })
    : undefined;

  const userService = new UserService(
    userRepository,
    {
      requireEmailConfirmation,
      emailConfirmationService,
      passwordRounds
    }
  );
  const mealRepository = new PostgresMealRepository(pool);
  const mealService = new MealService(mealRepository, userService);

  if (adminEmail && adminPassword) {
    const normalizedAdminEmail =
      adminEmail.trim().toLowerCase();

    const existingAdmin =
      await userRepository.findByEmail(
        normalizedAdminEmail
      );

    if (!existingAdmin) {
      await userService.createAdmin({
        email: normalizedAdminEmail,
        password: adminPassword
      });
    }
  }

  return {
    pool,
    userRepository,
    userService,
    emailConfirmationService,
    brevoEmailService,
    mealRepository,
    mealService
  };
}
