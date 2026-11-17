import { Router } from "express";
import { requireAuthentication } from "../middleware/auth.middleware.js";

export function createMealsRouter({ mealService }) {
  const router = Router();
  router.use(requireAuthentication);

  router.post("/", async (request, response) => {
    const meal = await mealService.create(request.session.userId, request.body);
    response.status(201).json({ meal });
  });

  router.get("/", async (request, response) => {
    const meals = await mealService.listByDate(request.session.userId, request.query.date);
    response.status(200).json({ meals });
  });

  router.patch("/:id", async (request, response) => {
    const meal = await mealService.update(request.session.userId, request.params.id, request.body);
    response.status(200).json({ meal });
  });

  router.delete("/:id", async (request, response) => {
    await mealService.delete(request.session.userId, request.params.id);
    response.status(204).send();
  });

  return router;
}
