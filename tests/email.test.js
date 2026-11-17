import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEmail } from "../src/utils/email.js";
import { UserService } from "../src/services/user.service.js";
import { BrevoEmailService } from "../src/services/brevoEmail.service.js";
import { InMemoryUserRepository } from "../src/repositories/inMemoryUser.repository.js";

describe("Criterio de email compartido entre usuarios y Brevo", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "user..name@example.test", ".user@example.test", "user.@example.test", "user@-example.test",
    "user@example..test", "<user>@example.test", "user@example_test.test", "usuário@example.test",
    `${"a".repeat(65)}@example.test`, `user@${"a".repeat(64)}.test`
  ])("rechaza en ambas capas el correo anteriormente aceptado por UserService: %s", async (email) => {
    const repository = new InMemoryUserRepository();
    const users = new UserService(repository, { passwordRounds: 4 });
    const fetchImpl = vi.fn();
    const brevo = new BrevoEmailService({ apiKey: "unit-test-key", senderEmail: "sender@example.test", fetchImpl });
    expect(normalizeEmail(email)).toBeNull();
    await expect(users.register({ email, password: "Usuario1234" }))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_EMAIL" });
    await expect(brevo.sendConfirmationEmail({ to: email, confirmationUrl: "https://example.test/confirm.html#token=fixture" }))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_EMAIL_RECIPIENT" });
    expect(repository.users).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normaliza igual el registro y el destinatario sin cambiar el criterio original de Brevo", async () => {
    const email = "  User+Tag@Example.Test  ";
    const users = new UserService(new InMemoryUserRepository(), { passwordRounds: 4 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "test-message-id" }), { status: 201 }));
    const brevo = new BrevoEmailService({ apiKey: "unit-test-key", senderEmail: "sender@example.test", fetchImpl });
    const user = await users.register({ email, password: "Usuario1234" });
    await brevo.sendConfirmationEmail({ to: email, confirmationUrl: "https://example.test/confirm.html#token=fixture" });
    expect(normalizeEmail(email)).toBe("user+tag@example.test");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).to).toEqual([{ email: user.email }]);
  });
});
