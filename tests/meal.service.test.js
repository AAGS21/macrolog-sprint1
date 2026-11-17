import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers/testContext.js";

describe("MealService: números no representables en JSON", () => {
  it.each([
    ["calories", NaN], ["calories", Infinity], ["calories", -Infinity],
    ["proteinGrams", NaN], ["proteinGrams", Infinity], ["proteinGrams", -Infinity]
  ])("rechaza %s = %s antes de persistir", async (field, value) => {
    const { userService, mealService, mealRepository } = await createTestContext();
    const user = await userService.register({ email: "numeros@example.com", password: "Usuario1234" });
    const data = { name: "Comida", calories: 0, proteinGrams: 0, mealDate: "2026-11-17" };
    const meal = await mealService.create(user.id, data);

    await expect(mealService.create(user.id, { ...data, [field]: value }))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_MEAL_DATA" });
    await expect(mealService.update(user.id, meal.id, { [field]: value }))
      .rejects.toMatchObject({ statusCode: 400, code: "INVALID_MEAL_DATA" });
    expect(await mealRepository.findByDate(user.id, data.mealDate)).toEqual([meal]);
  });
});
