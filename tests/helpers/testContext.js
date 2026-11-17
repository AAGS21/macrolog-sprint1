import session from "express-session";
import { createApp } from "../../src/app.js";
import { InMemoryUserRepository } from "../../src/repositories/inMemoryUser.repository.js";
import { UserService } from "../../src/services/user.service.js";
import { InMemoryMealRepository } from "../../src/repositories/inMemoryMeal.repository.js";
import { MealService } from "../../src/services/meal.service.js";
import { EmailConfirmationService } from "../../src/services/emailConfirmation.service.js";

export async function createTestContext({
  isProduction = false,
  requireEmailConfirmation = false,
  brevoEmailService,
  appBaseUrl = "https://macrolog.example"
} = {}) {
  const userRepository = new InMemoryUserRepository();
  const sessionStore = new session.MemoryStore();
  const sentEmails = [];
  const emailSender = brevoEmailService ?? {
    async sendConfirmationEmail(message) {
      sentEmails.push(message);
      return "test-message-id";
    }
  };
  const emailConfirmationService = requireEmailConfirmation
    ? new EmailConfirmationService({ userRepository, brevoEmailService: emailSender, appBaseUrl })
    : undefined;

  const userService = new UserService(userRepository, {
    passwordRounds: 4,
    requireEmailConfirmation,
    emailConfirmationService
  });
  const mealRepository = new InMemoryMealRepository();
  const mealService = new MealService(mealRepository, userService);

  const adminCredentials = {
    email: "admin@macrolog.test",
    password: "Admin1234"
  };

  const admin = await userService.createAdmin(adminCredentials);

  const app = createApp({
    userService,
    mealService,
    sessionSecret: "test-session-secret-with-at-least-32-characters",
    sessionStore,
    isProduction
  });

  return {
    app,
    userRepository,
    userService,
    emailConfirmationService,
    brevoEmailService: emailSender,
    sentEmails,
    mealRepository,
    mealService,
    sessionStore,
    admin,
    adminCredentials
  };
}
