import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryMealRepository } from "../src/repositories/inMemoryMeal.repository.js";
import { PostgresMealRepository } from "../src/repositories/postgresMeal.repository.js";

const meal = {
  id: randomUUID(), userId: randomUUID(), name: "Almuerzo", calories: 450,
  proteinGrams: 32.29, mealDate: "2026-11-17",
  createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z"
};
const row = {
  id: meal.id, user_id: meal.userId, name: meal.name, calories: "450",
  protein_grams: "32.29", meal_date: meal.mealDate,
  created_at: new Date(meal.createdAt), updated_at: new Date(meal.updatedAt)
};

describe("InMemoryMealRepository", () => {
  let repository;
  beforeEach(() => { repository = new InMemoryMealRepository(); });

  it("crea copias y filtra lecturas por propietario y fecha", async () => {
    const created = await repository.create(meal);
    expect(created).toEqual(meal);
    created.name = "Cambio externo";
    expect(await repository.findById(meal.userId, meal.id)).toEqual(meal);
    expect(await repository.findById(randomUUID(), meal.id)).toBeNull();
    expect(await repository.findByDate(meal.userId, meal.mealDate)).toEqual([meal]);
    expect(await repository.findByDate(randomUUID(), meal.mealDate)).toEqual([]);
    expect(await repository.findByDate(meal.userId, "2026-11-18")).toEqual([]);
  });

  it("actualiza solo campos editables y elimina únicamente comidas propias", async () => {
    await repository.create(meal);
    expect(await repository.update(randomUUID(), meal.id, { name: "Intrusión" })).toBeNull();
    expect(await repository.delete(randomUUID(), meal.id)).toBe(false);
    const changes = {
      name: "Cena", calories: 0, proteinGrams: 0.29, mealDate: "2026-11-18",
      updatedAt: "2026-11-18T12:00:00.000Z"
    };
    expect(await repository.update(meal.userId, meal.id, {
      ...changes, userId: randomUUID(), id: randomUUID(), createdAt: "otro"
    })).toEqual({ ...meal, ...changes });
    expect(await repository.update(meal.userId, meal.id, {})).toEqual({ ...meal, ...changes });
    expect(await repository.findByDate(meal.userId, meal.mealDate)).toEqual([]);
    expect(await repository.delete(meal.userId, meal.id)).toBe(true);
    expect(await repository.findById(meal.userId, meal.id)).toBeNull();
    expect(await repository.update(meal.userId, meal.id, { name: "Otra" })).toBeNull();
    expect(await repository.delete(meal.userId, meal.id)).toBe(false);
  });

  it("lista por creación y UUID con un orden estable", async () => {
    const first = { ...meal, id: "00000000-0000-4000-8000-000000000001" };
    const second = { ...meal, id: "00000000-0000-4000-8000-000000000002" };
    await repository.create(second);
    await repository.create(first);
    expect(await repository.findByDate(meal.userId, meal.mealDate)).toEqual([first, second]);
  });
});

// Estos dobles verifican SQL y mapeo; no ejecutan PostgreSQL real.
describe("PostgresMealRepository", () => {
  let pool;
  let repository;
  beforeEach(() => {
    pool = { query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
    repository = new PostgresMealRepository(pool);
  });

  it("inserta parámetros sin interpolar datos y devuelve el mismo modelo que memoria", async () => {
    expect(await repository.create(meal)).toEqual(meal);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO meals/);
    expect(sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8)");
    expect(sql).toContain("to_char(meal_date, 'YYYY-MM-DD') AS meal_date");
    expect(sql).not.toContain(meal.name);
    expect(params).toEqual([
      meal.id, meal.userId, meal.name, meal.calories, meal.proteinGrams,
      meal.mealDate, meal.createdAt, meal.updatedAt
    ]);
    const memory = new InMemoryMealRepository();
    expect(await memory.create(meal)).toEqual(await repository.findById(meal.userId, meal.id));
  });

  it("filtra la búsqueda de UUID por propietario", async () => {
    expect(await repository.findById(meal.userId, meal.id)).toEqual(meal);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE user_id = \$1 AND id = \$2/), [meal.userId, meal.id]
    );
    pool.query.mockResolvedValue({ rows: [] });
    expect(await repository.findById(randomUUID(), meal.id)).toBeNull();
  });

  it("lista por usuario y fecha y devuelve números JSON con fechas sin conversión de zona", async () => {
    const result = await repository.findByDate(meal.userId, meal.mealDate);
    expect(result).toEqual([meal]);
    expect(typeof result[0].calories).toBe("number");
    expect(typeof result[0].proteinGrams).toBe("number");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE user_id = \$1 AND meal_date = \$2\s+ORDER BY created_at ASC, id ASC/),
      [meal.userId, meal.mealDate]
    );
    pool.query.mockResolvedValue({ rows: [] });
    expect(await repository.findByDate(meal.userId, "2026-11-18")).toEqual([]);
  });

  it("parametriza la edición parcial y conserva el filtro de propietario", async () => {
    pool.query.mockResolvedValue({ rows: [{ ...row, calories: "0", protein_grams: "0.29" }] });
    const updated = await repository.update(meal.userId, meal.id, {
      calories: 0, proteinGrams: 0.29, userId: randomUUID(), id: randomUUID()
    });
    expect(updated).toEqual({ ...meal, calories: 0, proteinGrams: 0.29 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("UPDATE meals SET calories = $3, protein_grams = $4");
    expect(sql).toContain("WHERE user_id = $1 AND id = $2 RETURNING");
    expect(params).toEqual([meal.userId, meal.id, 0, 0.29]);
    pool.query.mockResolvedValue({ rows: [] });
    expect(await repository.update(randomUUID(), meal.id, { name: "Ajena" })).toBeNull();
  });

  it("conserva el contrato de edición sin campos y timestamps string", async () => {
    pool.query.mockResolvedValue({ rows: [{ ...row, created_at: meal.createdAt, updated_at: meal.updatedAt }] });
    expect(await repository.update(meal.userId, meal.id, {})).toEqual(meal);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT[\s\S]+WHERE user_id = \$1 AND id = \$2/),
      [meal.userId, meal.id]
    );
  });

  it("elimina por propietario y devuelve booleanos igual que memoria", async () => {
    expect(await repository.delete(meal.userId, meal.id)).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      "DELETE FROM meals WHERE user_id = $1 AND id = $2", [meal.userId, meal.id]
    );
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await repository.delete(randomUUID(), meal.id)).toBe(false);
  });
});
