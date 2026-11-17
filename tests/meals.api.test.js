import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "./helpers/testContext.js";

const credentials = { email: "comidas@example.com", password: "Usuario1234" };
const validMeal = {
  name: "  Almuerzo  ", calories: 450, proteinGrams: 32.29, mealDate: "2026-11-17"
};
const invalidFields = [
  ["name", "vacío", "   "], ["name", "largo", "a".repeat(101)],
  ["name", "numérico", 42], ["name", "null", null],
  ["calories", "negativas", -1], ["calories", "fraccionarias", 1.5],
  ["calories", "string", "450"], ["calories", "null", null],
  ["calories", "booleano", true], ["calories", "objeto", {}],
  ["calories", "array", []], ["calories", "fuera de rango", 1e100],
  ["proteinGrams", "negativas", -0.01], ["proteinGrams", "tres decimales", 1.001],
  ["proteinGrams", "string", "32.29"], ["proteinGrams", "null", null],
  ["proteinGrams", "booleano", false], ["proteinGrams", "objeto", {}],
  ["proteinGrams", "array", []], ["proteinGrams", "fuera de rango", 1e100],
  ["mealDate", "día imposible", "2026-02-30"],
  ["mealDate", "año no bisiesto", "2026-02-29"],
  ["mealDate", "mes imposible", "2026-13-01"],
  ["mealDate", "día cero", "2026-01-00"],
  ["mealDate", "formato corto", "2026-1-01"],
  ["mealDate", "timestamp", "2026-11-17T00:00:00Z"],
  ["mealDate", "año cero", "0000-01-01"],
  ["mealDate", "numérica", 20261117], ["mealDate", "null", null]
];

describe("API de comidas", () => {
  let context;
  let agent;
  let user;

  beforeEach(async () => {
    context = await createTestContext();
    agent = request.agent(context.app);
    const registered = await agent.post("/api/auth/register").send(credentials);
    user = registered.body.user;
    const login = await agent.post("/api/auth/login").send(credentials);
    expect(login.status).toBe(200);
  });

  afterEach(() => vi.restoreAllMocks());

  async function createMeal(data = validMeal) {
    const response = await agent.post("/api/meals").send(data);
    expect(response.status).toBe(201);
    return response.body.meal;
  }

  it("crea una comida con propietario, UUID, nombre recortado y timestamps", async () => {
    const meal = await createMeal();
    expect(meal).toEqual({
      ...validMeal, name: "Almuerzo", userId: user.id,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      createdAt: expect.any(String), updatedAt: expect.any(String)
    });
    expect(new Date(meal.createdAt).toISOString()).toBe(meal.createdAt);
    expect(meal.updatedAt).toBe(meal.createdAt);
  });

  it("recupera la comida creada en otra petición y solo lista la fecha indicada", async () => {
    const first = await createMeal();
    const second = await createMeal({ ...validMeal, name: "Cena" });
    await createMeal({ ...validMeal, mealDate: "2026-11-18" });

    const response = await agent.get("/api/meals").query({ date: validMeal.mealDate });
    expect(response.status).toBe(200);
    expect(response.body.meals).toHaveLength(2);
    expect(response.body.meals).toEqual(expect.arrayContaining([first, second]));
    const empty = await agent.get("/api/meals").query({ date: "2026-11-19" });
    expect(empty.body).toEqual({ meals: [] });
  });

  it.each(["2024-02-29", "0001-01-01", "9999-12-31"])(
    "conserva la fecha %s y admite valores nutricionales cero", async (mealDate) => {
      const meal = await createMeal({ ...validMeal, calories: 0, proteinGrams: 0, mealDate });
      const listed = await agent.get("/api/meals").query({ date: mealDate });
      expect(listed.body.meals).toEqual([meal]);
      expect(meal.mealDate).toBe(mealDate);
      expect(meal.calories).toBe(0);
      expect(meal.proteinGrams).toBe(0);
    }
  );

  it("edita parcialmente y mueve una comida de fecha sin alterar propietario ni creación", async () => {
    const meal = await createMeal();
    const renamed = await agent.patch(`/api/meals/${meal.id.toUpperCase()}`).send({ name: "  Merienda " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.meal).toMatchObject({ ...meal, name: "Merienda", updatedAt: expect.any(String) });

    const changed = await agent.patch(`/api/meals/${meal.id}`).send({
      calories: 0, proteinGrams: 0.29, mealDate: "2026-11-18"
    });
    expect(changed.status).toBe(200);
    expect(changed.body.meal).toMatchObject({
      id: meal.id, userId: user.id, createdAt: meal.createdAt,
      name: "Merienda", calories: 0, proteinGrams: 0.29, mealDate: "2026-11-18"
    });
    const oldDate = await agent.get("/api/meals").query({ date: validMeal.mealDate });
    expect(oldDate.body).toEqual({ meals: [] });
    const newDate = await agent.get("/api/meals").query({ date: "2026-11-18" });
    expect(newDate.body.meals).toEqual([changed.body.meal]);
  });

  it("elimina con 204 y devuelve 404 en posteriores modificaciones y eliminaciones", async () => {
    const meal = await createMeal();
    const deleted = await agent.delete(`/api/meals/${meal.id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe("");
    const listed = await agent.get("/api/meals").query({ date: validMeal.mealDate });
    expect(listed.body).toEqual({ meals: [] });
    for (const method of ["patch", "delete"]) {
      const response = await agent[method](`/api/meals/${meal.id}`).send({ name: "Otra" });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("MEAL_NOT_FOUND");
    }
  });

  it.each(["patch", "delete"])("devuelve 404 al hacer %s sobre un UUID inexistente", async (method) => {
    const response = await agent[method](`/api/meals/${randomUUID()}`).send({ name: "Otra" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("MEAL_NOT_FOUND");
  });

  it.each(["get", "post", "patch", "delete"])("impide %s sin sesión", async (method) => {
    const path = ["get", "post"].includes(method) ? "/api/meals" : `/api/meals/${randomUUID()}`;
    const response = await request(context.app)[method](path)
      .query({ date: validMeal.mealDate }).send(validMeal);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it.each(["user", "admin"])("aísla las comidas incluso frente a otra cuenta %s", async (role) => {
    const meal = await createMeal();
    const stranger = request.agent(context.app);
    let loginCredentials = context.adminCredentials;
    if (role === "user") {
      loginCredentials = { ...credentials, email: "otra@example.com" };
      await stranger.post("/api/auth/register").send(loginCredentials);
    }
    expect((await stranger.post("/api/auth/login").send(loginCredentials)).status).toBe(200);
    const foreignMeal = await stranger.post("/api/meals").send({ ...validMeal, name: "Ajena" });
    expect(foreignMeal.status).toBe(201);
    const ownList = await agent.get("/api/meals").query({ date: validMeal.mealDate });
    expect(ownList.body.meals).toEqual([meal]);
    const otherList = await stranger.get("/api/meals").query({ date: validMeal.mealDate });
    expect(otherList.body.meals).toEqual([foreignMeal.body.meal]);

    for (const method of ["patch", "delete"]) {
      const response = await stranger[method](`/api/meals/${meal.id}`).send({ name: "Intrusión" });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("MEAL_NOT_FOUND");
    }
    expect(await context.mealRepository.findById(user.id, meal.id)).toEqual(meal);
  });

  it.each(["deleted", "pending", "missing"])("rechaza todas las operaciones con cuenta %s y sesión previa", async (state) => {
    const meal = await createMeal();
    if (state === "missing") {
      vi.spyOn(context.userRepository, "findById").mockResolvedValue(null);
    } else {
      await context.userRepository.update(user.id,
        state === "deleted" ? { deletedAt: new Date().toISOString() } : { confirmed: false });
    }

    for (const method of ["get", "post", "patch", "delete"]) {
      const path = ["get", "post"].includes(method) ? "/api/meals" : `/api/meals/${meal.id}`;
      const response = await agent[method](path).query({ date: validMeal.mealDate }).send(validMeal);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACTOR");
    }
    expect(await context.mealRepository.findById(user.id, meal.id)).toEqual(meal);
  });

  it.each(invalidFields)("rechaza %s: %s en creación y edición", async (field, _, value) => {
    const meal = await createMeal();
    const created = await agent.post("/api/meals").send({ ...validMeal, [field]: value });
    const patched = await agent.patch(`/api/meals/${meal.id}`).send({ [field]: value });
    for (const response of [created, patched]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_MEAL_DATA");
    }
    expect(await context.mealRepository.findById(user.id, meal.id)).toEqual(meal);
    expect(await context.mealRepository.findByDate(user.id, validMeal.mealDate)).toHaveLength(1);
  });

  it.each(["name", "calories", "proteinGrams", "mealDate"])("rechaza creación sin %s", async (field) => {
    const body = { ...validMeal };
    delete body[field];
    const response = await agent.post("/api/meals").send(body);
    expect(response.status).toBe(400);
  });

  it.each([{}, [], null, { userId: randomUUID() }, { unknown: true }, { id: randomUUID() }])(
    "rechaza cuerpos vacíos, incorrectos o con campos desconocidos: %j", async (body) => {
      const meal = await createMeal();
      const post = await agent.post("/api/meals").send(body);
      const patch = await agent.patch(`/api/meals/${meal.id}`).send(body);
      expect(post.status).toBe(400);
      expect(patch.status).toBe(400);
    }
  );

  it("rechaza campos desconocidos aunque el resto de datos sea válido", async () => {
    const meal = await createMeal();
    expect((await agent.post("/api/meals").send({ ...validMeal, userId: randomUUID() })).status).toBe(400);
    expect((await agent.patch(`/api/meals/${meal.id}`).send({ name: "Otra", extra: 1 })).status).toBe(400);
  });

  it.each([undefined, "", "2026-02-30", "2026-1-01", "0000-01-01"])("exige fecha de consulta válida: %s", async (date) => {
    const response = await agent.get("/api/meals").query(date === undefined ? {} : { date });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_MEAL_DATA");
  });

  it("rechaza fechas de consulta repetidas", async () => {
    const response = await agent.get("/api/meals?date=2026-11-17&date=2026-11-18");
    expect(response.status).toBe(400);
  });

  it.each(["patch", "delete"])("rechaza UUID malformado en %s sin error SQL", async (method) => {
    const response = await agent[method]("/api/meals/no-es-uuid").send({ name: "Otra" });
    expect(response.status).toBe(400);
  });

  it("trata JSON malformado como 400", async () => {
    const response = await agent.post("/api/meals").set("Content-Type", "application/json").send('{"name":');
    expect(response.status).toBe(400);
  });

  it("reserva 500 para fallos internos y no devuelve detalles del repositorio", async () => {
    vi.spyOn(context.mealRepository, "findByDate").mockRejectedValue(new Error("Fallo interno simulado"));
    const response = await agent.get("/api/meals").query({ date: validMeal.mealDate });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Se ha producido un error interno" } });
  });
});
