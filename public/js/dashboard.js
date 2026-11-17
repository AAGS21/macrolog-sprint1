import {
  createMeal,
  deleteMeal,
  deleteUser,
  getMeals,
  logoutUser,
  updateMeal
} from "./apiClient.js";
import { requireUser } from "./session.js";

const emailElement = document.querySelector("#user-email");
const adminLink = document.querySelector("#admin-link");
const logoutButton = document.querySelector("#logout-button");
const deleteAccountButton =
  document.querySelector("#delete-account-button");
const pageMessage = document.querySelector("#page-message");
const selectedDate = document.querySelector("#selected-date");
const summary = document.querySelector("#daily-summary");
const caloriesTotal = document.querySelector("#calories-total");
const proteinTotal = document.querySelector("#protein-total");
const mealCount = document.querySelector("#meal-count");
const form = document.querySelector("#meal-form");
const fields = document.querySelector("#meal-fields");
const formTitle = document.querySelector("#meal-form-title");
const nameInput = document.querySelector("#meal-name");
const caloriesInput = document.querySelector("#meal-calories");
const proteinInput = document.querySelector("#meal-protein");
const mealDateInput = document.querySelector("#meal-date");
const saveButton = document.querySelector("#save-meal-button");
const cancelButton = document.querySelector("#cancel-meal-button");
const mealsPanel = document.querySelector("#meals-panel");
const mealsStatus = document.querySelector("#meals-status");
const retryButton = document.querySelector("#retry-meals-button");
const emptyState = document.querySelector("#meals-empty");
const tableContainer = document.querySelector("#meals-table-container");
const tableBody = document.querySelector("#meals-table-body");
const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

let currentUser = null;
let meals = [];
let editingId = null;
let mutationPending = false;
let loading = false;
let loadVersion = 0;

function localToday() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function showMessage(message = "", type = "error") {
  pageMessage.textContent = message;
  pageMessage.className = `form-message${message ? ` form-message-${type}` : ""}`;
}

function handleMealError(error) {
  if (error.status === 401) {
    currentUser = null;
    syncControls();
    window.location.replace("/login.html");
    return;
  }
  showMessage(error.status ? error.message : "No se pudo conectar con el servidor. Inténtalo de nuevo.");
}

function syncControls() {
  selectedDate.disabled = !currentUser || mutationPending;
  fields.disabled = !currentUser || mutationPending || !validDate(selectedDate.value);
  retryButton.disabled = loading || mutationPending;
  cancelButton.hidden = !editingId;
  saveButton.textContent = mutationPending ? "Guardando…" : editingId ? "Guardar cambios" : "Guardar comida";
  tableBody.querySelectorAll("button").forEach((button) => {
    button.disabled = !currentUser || mutationPending || loading;
  });
}

function resetForm() {
  form.reset();
  editingId = null;
  formTitle.textContent = "Registrar comida";
  mealDateInput.value = selectedDate.value;
  syncControls();
}

function clearResults() {
  meals = [];
  tableBody.replaceChildren();
  emptyState.hidden = true;
  tableContainer.hidden = true;
  caloriesTotal.textContent = "— kcal";
  proteinTotal.textContent = "— g";
  mealCount.textContent = "—";
}

function startEditing(meal) {
  if (mutationPending || loading) return;
  editingId = meal.id;
  nameInput.value = meal.name;
  caloriesInput.value = meal.calories;
  proteinInput.value = meal.proteinGrams;
  mealDateInput.value = meal.mealDate;
  formTitle.textContent = "Editar comida";
  showMessage();
  syncControls();
  nameInput.focus();
}

function renderMeals() {
  tableBody.replaceChildren();
  meals.forEach((meal) => {
    const row = document.createElement("tr");
    [meal.name, numberFormat.format(meal.calories), `${numberFormat.format(meal.proteinGrams)} g`]
      .forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "meal-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "table-button";
    editButton.textContent = "Editar";
    editButton.setAttribute("aria-label", `Editar ${meal.name}`);
    editButton.addEventListener("click", () => startEditing(meal));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "table-button table-button-danger";
    deleteButton.textContent = "Eliminar";
    deleteButton.setAttribute("aria-label", `Eliminar ${meal.name}`);
    deleteButton.addEventListener("click", () => removeMeal(meal));
    actions.append(editButton, deleteButton);
    actionsCell.append(actions);
    row.append(actionsCell);
    tableBody.append(row);
  });

  const calories = meals.reduce((total, meal) => total + meal.calories, 0);
  const proteinCents = meals.reduce((total, meal) => total + Math.round(meal.proteinGrams * 100), 0);
  caloriesTotal.textContent = `${numberFormat.format(calories)} kcal`;
  proteinTotal.textContent = `${numberFormat.format(proteinCents / 100)} g`;
  mealCount.textContent = String(meals.length);
  emptyState.hidden = meals.length !== 0;
  tableContainer.hidden = meals.length === 0;
  syncControls();
}

async function loadMeals() {
  const version = ++loadVersion;
  const date = selectedDate.value;
  clearResults();
  retryButton.hidden = true;
  if (!validDate(date)) {
    loading = false;
    summary.setAttribute("aria-busy", "false");
    mealsPanel.setAttribute("aria-busy", "false");
    mealsStatus.textContent = "Selecciona una fecha válida para consultar tus comidas.";
    syncControls();
    return false;
  }

  loading = true;
  summary.setAttribute("aria-busy", "true");
  mealsPanel.setAttribute("aria-busy", "true");
  mealsStatus.textContent = "Cargando comidas…";
  syncControls();
  try {
    const result = await getMeals(date);
    if (version !== loadVersion) return false;
    meals = result.meals;
    renderMeals();
    mealsStatus.textContent = `${meals.length} ${meals.length === 1 ? "comida registrada" : "comidas registradas"} para el ${date}.`;
    return true;
  } catch (error) {
    if (version !== loadVersion) return false;
    mealsStatus.textContent = "No se pudieron cargar las comidas. Puedes reintentar la carga.";
    retryButton.hidden = false;
    handleMealError(error);
    return false;
  } finally {
    if (version === loadVersion) {
      loading = false;
      summary.setAttribute("aria-busy", "false");
      mealsPanel.setAttribute("aria-busy", "false");
      syncControls();
    }
  }
}

function readMeal() {
  const name = nameInput.value.trim();
  if (!name || name.length > 100) {
    nameInput.focus();
    throw new Error("Indica un nombre de entre 1 y 100 caracteres.");
  }
  const calories = Number(caloriesInput.value);
  if (!/^\d+$/.test(caloriesInput.value) || !Number.isSafeInteger(calories) || calories < 0) {
    caloriesInput.focus();
    throw new Error("Las calorías deben ser un entero no negativo dentro del rango permitido.");
  }
  const proteinGrams = Number(proteinInput.value);
  if (
    !/^\d+(?:\.\d{1,2})?$/.test(proteinInput.value) || !Number.isFinite(proteinGrams) ||
    proteinGrams < 0 || proteinGrams > Number.MAX_SAFE_INTEGER / 100
  ) {
    proteinInput.focus();
    throw new Error("Las proteínas deben ser un número no negativo con hasta dos decimales.");
  }
  if (!validDate(mealDateInput.value)) {
    mealDateInput.focus();
    throw new Error("Indica una fecha de consumo válida.");
  }
  return { name, calories, proteinGrams, mealDate: mealDateInput.value };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || mutationPending || fields.disabled || !form.reportValidity()) return;
  let data;
  try {
    data = readMeal();
  } catch (error) {
    showMessage(error.message);
    return;
  }

  mutationPending = true;
  syncControls();
  showMessage();
  try {
    const result = editingId ? await updateMeal(editingId, data) : await createMeal(data);
    selectedDate.value = result.meal.mealDate;
    resetForm();
    const refreshed = await loadMeals();
    if (currentUser) {
      showMessage(refreshed ? "Comida guardada correctamente." : "Comida guardada. Reintenta la carga para actualizar el listado.", refreshed ? "success" : "error");
    }
  } catch (error) {
    if (error.status === 404) {
      resetForm();
      await loadMeals();
      showMessage("La comida ya no está disponible. Se ha vuelto a consultar el listado.");
    } else {
      handleMealError(error);
    }
  } finally {
    mutationPending = false;
    syncControls();
  }
});

async function removeMeal(meal) {
  if (!currentUser || mutationPending || loading || !window.confirm(`¿Eliminar la comida «${meal.name}»?`)) return;
  mutationPending = true;
  syncControls();
  showMessage();
  try {
    await deleteMeal(meal.id);
    if (editingId === meal.id) resetForm();
    const refreshed = await loadMeals();
    if (currentUser) {
      showMessage(refreshed ? "Comida eliminada correctamente." : "Comida eliminada. Reintenta la carga para actualizar el listado.", refreshed ? "success" : "error");
    }
  } catch (error) {
    if (error.status === 404) {
      if (editingId === meal.id) resetForm();
      await loadMeals();
      showMessage("La comida ya no está disponible. Se ha vuelto a consultar el listado.");
    } else {
      handleMealError(error);
    }
  } finally {
    mutationPending = false;
    syncControls();
  }
}

selectedDate.addEventListener("change", () => {
  resetForm();
  showMessage();
  loadMeals();
});
cancelButton.addEventListener("click", () => {
  resetForm();
  showMessage();
  nameInput.focus();
});
retryButton.addEventListener("click", () => {
  showMessage();
  loadMeals();
});

async function loadDashboard() {
  selectedDate.value = localToday();
  mealDateInput.value = selectedDate.value;
  currentUser = await requireUser();

  if (!currentUser) {
    return;
  }

  emailElement.textContent = currentUser.email;

  if (currentUser.role === "admin") {
    adminLink.classList.remove("hidden");
  }
  syncControls();
  await loadMeals();
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await logoutUser();
    window.location.replace("/");
  } catch (error) {
    pageMessage.textContent = error.message;
    pageMessage.className =
      "form-message form-message-error";
    logoutButton.disabled = false;
  }
});

deleteAccountButton.addEventListener("click", async () => {
  if (!currentUser) {
    return;
  }

  const confirmed = window.confirm(
    "¿Seguro que quieres eliminar tu cuenta?"
  );

  if (!confirmed) {
    return;
  }

  deleteAccountButton.disabled = true;

  try {
    await deleteUser(currentUser.id);
    await logoutUser();
    window.location.replace("/");
  } catch (error) {
    pageMessage.textContent = error.message;
    pageMessage.className =
      "form-message form-message-error";
    deleteAccountButton.disabled = false;
  }
});

loadDashboard();
