export class InMemoryMealRepository {
  constructor() {
    this.meals = new Map();
  }

  async create(meal) {
    this.meals.set(meal.id, { ...meal });
    return { ...meal };
  }

  async findById(userId, id) {
    const meal = this.meals.get(id);
    return meal?.userId === userId ? { ...meal } : null;
  }

  async findByDate(userId, mealDate) {
    return [...this.meals.values()]
      .filter((meal) => meal.userId === userId && meal.mealDate === mealDate)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((meal) => ({ ...meal }));
  }

  async update(userId, id, changes) {
    const meal = await this.findById(userId, id);
    if (!meal) return null;

    const updated = { ...meal };
    for (const field of ["name", "calories", "proteinGrams", "mealDate", "updatedAt"]) {
      if (Object.hasOwn(changes, field)) updated[field] = changes[field];
    }
    this.meals.set(id, updated);
    return { ...updated };
  }

  async delete(userId, id) {
    if (!await this.findById(userId, id)) return false;
    return this.meals.delete(id);
  }
}
