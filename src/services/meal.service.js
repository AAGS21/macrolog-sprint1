import { randomUUID } from "node:crypto";
import { AppError } from "../utils/appError.js";

const MEAL_FIELDS = ["name", "calories", "proteinGrams", "mealDate"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidData(message) {
  return new AppError(message, 400, "INVALID_MEAL_DATA");
}

function validateDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-")
  ) {
    throw invalidData("La fecha debe ser una fecha real con formato YYYY-MM-DD");
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalidData("La fecha debe ser una fecha real con formato YYYY-MM-DD");
  }
  return value;
}

function validateMeal(data, partial = false) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw invalidData("El cuerpo debe ser un objeto con datos de la comida");
  }

  const fields = Object.keys(data);
  if (fields.length === 0 || fields.some((field) => !MEAL_FIELDS.includes(field))) {
    throw invalidData("Debes indicar campos de comida válidos");
  }
  if (!partial && MEAL_FIELDS.some((field) => !Object.hasOwn(data, field))) {
    throw invalidData("Faltan campos obligatorios de la comida");
  }

  const meal = {};
  if (Object.hasOwn(data, "name")) {
    if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 100) {
      throw invalidData("El nombre debe tener entre 1 y 100 caracteres");
    }
    meal.name = data.name.trim();
  }
  if (Object.hasOwn(data, "calories")) {
    // BIGINT en PostgreSQL y enteros representables sin pérdida en JavaScript.
    if (!Number.isSafeInteger(data.calories) || data.calories < 0) {
      throw invalidData("Las calorías deben ser un entero no negativo dentro del rango seguro");
    }
    meal.calories = data.calories;
  }
  if (Object.hasOwn(data, "proteinGrams")) {
    if (
      typeof data.proteinGrams !== "number" ||
      !Number.isFinite(data.proteinGrams) ||
      data.proteinGrams < 0 ||
      data.proteinGrams > Number.MAX_SAFE_INTEGER / 100 ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(data.proteinGrams))
    ) {
      throw invalidData("Las proteínas deben ser un número no negativo con hasta dos decimales dentro del rango seguro");
    }
    meal.proteinGrams = data.proteinGrams;
  }
  if (Object.hasOwn(data, "mealDate")) {
    meal.mealDate = validateDate(data.mealDate);
  }
  return meal;
}

function validateId(id) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw invalidData("El identificador de la comida debe ser un UUID");
  }
  return id.toLowerCase();
}

function mealNotFound() {
  return new AppError("Comida no encontrada", 404, "MEAL_NOT_FOUND");
}

export class MealService {
  constructor(mealRepository, userService) {
    this.mealRepository = mealRepository;
    this.userService = userService;
  }

  async create(userId, data) {
    await this.userService.findActiveActor(userId);
    const meal = validateMeal(data);
    const now = new Date().toISOString();
    return this.mealRepository.create({
      ...meal,
      id: randomUUID(),
      userId,
      createdAt: now,
      updatedAt: now
    });
  }

  async listByDate(userId, date) {
    await this.userService.findActiveActor(userId);
    return this.mealRepository.findByDate(userId, validateDate(date));
  }

  async update(userId, id, data) {
    await this.userService.findActiveActor(userId);
    id = validateId(id);
    const changes = validateMeal(data, true);
    const meal = await this.mealRepository.update(userId, id, {
      ...changes,
      updatedAt: new Date().toISOString()
    });
    if (!meal) throw mealNotFound();
    return meal;
  }

  async delete(userId, id) {
    await this.userService.findActiveActor(userId);
    id = validateId(id);
    if (!await this.mealRepository.delete(userId, id)) {
      throw mealNotFound();
    }
  }
}
