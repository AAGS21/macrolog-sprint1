import { describe, expect, it, vi } from "vitest";
import { createResendRateLimiter } from "../src/middleware/resendRateLimit.middleware.js";

const WINDOW = 15 * 60 * 1000;

function send(limiter, ip = "192.0.2.1") {
  const response = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  limiter({ ip }, response, next);
  return { response, next };
}

describe("Limitador de reenvío por IP: ventana móvil y memoria acotada", () => {
  it("aplica una ventana deslizante por solicitud sin reiniciar todo el contador al vencer la primera", () => {
    let now = 0;
    const limiter = createResendRateLimiter({ clock: () => now });
    expect(send(limiter).next).toHaveBeenCalledOnce();
    now = 60000;
    for (let index = 0; index < 9; index++) expect(send(limiter).next).toHaveBeenCalledOnce();
    const blocked = send(limiter);
    expect(blocked.response.status).toHaveBeenCalledWith(429);
    expect(blocked.response.set).toHaveBeenCalledWith("Retry-After", "840");
    now = WINDOW;
    expect(send(limiter).next).toHaveBeenCalledOnce();
    const stillBlocked = send(limiter);
    expect(stillBlocked.response.status).toHaveBeenCalledWith(429);
    expect(stillBlocked.response.set).toHaveBeenCalledWith("Retry-After", "60");
    now += 60000;
    expect(send(limiter).next).toHaveBeenCalledOnce();
  });

  it("acota las entradas, no expulsa IP activas y limpia las caducadas sin temporizadores", () => {
    let now = 0;
    const limiter = createResendRateLimiter({ clock: () => now, maxEntries: 1 });
    for (let index = 0; index < 10; index++) expect(send(limiter).next).toHaveBeenCalledOnce();
    expect(send(limiter, "192.0.2.2").response.status).toHaveBeenCalledWith(429);
    expect(send(limiter).response.status).toHaveBeenCalledWith(429);
    now = WINDOW;
    expect(send(limiter, "192.0.2.2").next).toHaveBeenCalledOnce();
  });
});
