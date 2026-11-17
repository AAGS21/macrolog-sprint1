const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 10;

export function createResendRateLimiter({ clock = Date.now, maxEntries = 10000 } = {}) {
  if (typeof clock !== "function" || !Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("Configuración del limitador no válida");
  }
  const requests = new Map();

  return (request, response, next) => {
    const now = clock();
    const cutoff = now - WINDOW_MS;
    let nextEntryExpiry = Infinity;
    // Limpieza bajo demanda: sin temporizadores y con un máximo de entradas y diez fechas por IP.
    for (const [ip, timestamps] of requests) {
      const expiry = timestamps[timestamps.length - 1] + WINDOW_MS;
      if (expiry <= now) requests.delete(ip);
      else nextEntryExpiry = Math.min(nextEntryExpiry, expiry);
    }

    const ip = request.ip;
    const timestamps = (requests.get(ip) ?? []).filter((timestamp) => timestamp > cutoff);
    const exhausted = timestamps.length >= MAX_REQUESTS;
    // Al saturarse la capacidad no se expulsan IP activas, lo que permitiría eludir su límite.
    const full = !requests.has(ip) && requests.size >= maxEntries;
    if (exhausted || full) {
      const retryAt = exhausted ? timestamps[0] + WINDOW_MS : nextEntryExpiry;
      response.set("Retry-After", String(Math.max(1, Math.ceil((retryAt - now) / 1000))));
      return response.status(429).json({
        error: { code: "TOO_MANY_REQUESTS", message: "Demasiadas solicitudes. Inténtalo de nuevo más tarde." }
      });
    }

    timestamps.push(now);
    requests.set(ip, timestamps);
    return next();
  };
}
