// to_char evita que pg transforme DATE en un Date dependiente de la zona horaria.
const SELECT_COLUMNS = `
  id, user_id, name, calories, protein_grams,
  to_char(meal_date, 'YYYY-MM-DD') AS meal_date,
  created_at, updated_at
`;

function mapMeal(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    calories: Number(row.calories),
    proteinGrams: Number(row.protein_grams),
    mealDate: row.meal_date,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

export class PostgresMealRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create(meal) {
    const result = await this.pool.query(
      `INSERT INTO meals (
         id, user_id, name, calories, protein_grams, meal_date, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${SELECT_COLUMNS}`,
      [meal.id, meal.userId, meal.name, meal.calories, meal.proteinGrams,
        meal.mealDate, meal.createdAt, meal.updatedAt]
    );
    return mapMeal(result.rows[0]);
  }

  async findById(userId, id) {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM meals WHERE user_id = $1 AND id = $2`,
      [userId, id]
    );
    return mapMeal(result.rows[0]);
  }

  async findByDate(userId, mealDate) {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM meals
       WHERE user_id = $1 AND meal_date = $2
       ORDER BY created_at ASC, id ASC`,
      [userId, mealDate]
    );
    return result.rows.map(mapMeal);
  }

  async update(userId, id, changes) {
    const columns = {
      name: "name",
      calories: "calories",
      proteinGrams: "protein_grams",
      mealDate: "meal_date",
      updatedAt: "updated_at"
    };
    const entries = Object.entries(changes).filter(([field]) => Object.hasOwn(columns, field));
    if (entries.length === 0) return this.findById(userId, id);

    const assignments = entries.map(([field], index) => `${columns[field]} = $${index + 3}`);
    const result = await this.pool.query(
      `UPDATE meals SET ${assignments.join(", ")}
       WHERE user_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
      [userId, id, ...entries.map(([, value]) => value)]
    );
    return mapMeal(result.rows[0]);
  }

  async delete(userId, id) {
    const result = await this.pool.query(
      "DELETE FROM meals WHERE user_id = $1 AND id = $2",
      [userId, id]
    );
    return result.rowCount > 0;
  }
}
