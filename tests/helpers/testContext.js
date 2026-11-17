import session from "express-session";
import { createApp } from "../../src/app.js";
import { InMemoryUserRepository } from "../../src/repositories/inMemoryUser.repository.js";
import { UserService } from "../../src/services/user.service.js";

export async function createTestContext({ isProduction = false } = {}) {
  const userRepository = new InMemoryUserRepository();
  const sessionStore = new session.MemoryStore();

  const userService = new UserService(userRepository, {
    passwordRounds: 4,
    requireEmailConfirmation: false
  });

  const adminCredentials = {
    email: "admin@macrolog.test",
    password: "Admin1234"
  };

  const admin = await userService.createAdmin(adminCredentials);

  const app = createApp({
    userService,
    sessionSecret: "test-session-secret-with-at-least-32-characters",
    sessionStore,
    isProduction
  });

  return {
    app,
    userRepository,
    userService,
    sessionStore,
    admin,
    adminCredentials
  };
}
