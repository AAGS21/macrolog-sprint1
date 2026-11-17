import session from "express-session";
import { createApp } from "../../src/app.js";
import { InMemoryUserRepository } from "../../src/repositories/inMemoryUser.repository.js";
import { UserService } from "../../src/services/user.service.js";
import { InMemoryMealRepository } from "../../src/repositories/inMemoryMeal.repository.js";
import { MealService } from "../../src/services/meal.service.js";

export async function createTestContext({ isProduction = false } = {}) {
  const userRepository = new InMemoryUserRepository();
  const sessionStore = new session.MemoryStore();

  const userService = new UserService(userRepository, {
    passwordRounds: 4,
    requireEmailConfirmation: false
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
    mealRepository,
    mealService,
    sessionStore,
    admin,
    adminCredentials
  };
}
