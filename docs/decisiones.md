---
type: Decisiones
title: Decisiones técnicas de MacroLog en los Sprints 1 y 2
description: Decisiones del Sprint 1 y decisiones aprobadas para RF-02 en el Sprint 2, con motivaciones pendientes de aportar.
timestamp: 2026-11-05
---

# Decisiones de MacroLog · Sprints 1 y 2

Este registro reconstruye elecciones presentes en el código y el historial de `ddbe86b`. No afirma que existiera previamente un registro formal de decisiones. «Vigente» se refiere a la base documentada. Las finalidades declaradas en PR se citan como tales; las razones personales no documentadas quedan para el alumno.

## D-01 · Node.js, ES Modules y Express

- Qué: backend JavaScript con módulos ES y Express; Node.js declarado en CI y Render.
- Evidencia: [package.json](../package.json), [app.js](../src/app.js), [CI](../.github/workflows/ci.yml) y [Render](../render.yaml); incorporación de la base en el [PR #1](https://github.com/AdrianMompo/macrolog-sprint1/pull/1).
- Por qué: TODO(alumno): ¿Qué criterios llevaron a elegir Node.js, JavaScript ES Modules y Express para este sprint?
- Estado: vigente.

## D-02 · Frontend vanilla servido por Express

- Qué: HTML, CSS y JavaScript, con controladores de interfaz y cliente HTTP separado, bajo el mismo origen que la API.
- Evidencia: [public/](../public/), [apiClient.js](../public/js/apiClient.js), [app.js](../src/app.js); los [PR #1](https://github.com/AdrianMompo/macrolog-sprint1/pull/1) y [#5](https://github.com/AdrianMompo/macrolog-sprint1/pull/5) describen la estructura y la interfaz.
- Por qué: el mismo origen y la separación de presentación y comunicación figuran en los requisitos suministrados. TODO(alumno): ¿Por qué elegiste JavaScript vanilla para la interfaz?
- Estado: vigente.

## D-03 · Repositorio inicial de usuarios en memoria

- Qué: implementación de acceso a usuarios mediante una colección en memoria, detrás de métodos de repositorio.
- Evidencia: [PR #3](https://github.com/AdrianMompo/macrolog-sprint1/pull/3), commit `8a6f97e`, [InMemoryUserRepository](../src/repositories/inMemoryUser.repository.js).
- Por qué: el PR documenta esta implementación inicial y sus pruebas, sin justificar la elección temporal. TODO(alumno): ¿Qué motivó empezar con memoria antes de integrar la base de datos?
- Estado: sustituida por D-04 en la aplicación. El adaptador se conserva para las pruebas, como declara el PR #6.

## D-04 · PostgreSQL en la aplicación y memoria en pruebas

- Qué: `pg` y un repositorio PostgreSQL en el arranque normal; el servicio conserva la inyección del repositorio. Las pruebas siguen usando memoria.
- Evidencia: [PR #6](https://github.com/AdrianMompo/macrolog-sprint1/pull/6), commit `fd8aceb`, [dependencies.js](../src/config/dependencies.js), [repositorio PostgreSQL](../src/repositories/postgresUser.repository.js), [contexto de pruebas](../tests/helpers/testContext.js).
- Por qué: el PR declara persistencia de usuarios y sesiones después de reinicios y conservación del repositorio en memoria para pruebas. Esa finalidad está documentada; la comprobación real de reinicios no se ha reproducido aquí. TODO(alumno): ¿Qué criterio motivó elegir PostgreSQL y, si se confirma, Neon como proveedor?
- Estado: vigente; sustituye D-03 para la ejecución normal.

## D-05 · Contraseñas mediante bcrypt

- Qué: `bcryptjs` para generar y comparar hashes; proyección pública de usuarios sin hash.
- Evidencia: [servicio de usuarios](../src/services/user.service.js), [pruebas](../tests/user.service.test.js) y [PR #3](https://github.com/AdrianMompo/macrolog-sprint1/pull/3).
- Por qué: el PR declara proteger las contraseñas y evitar que sus hashes salgan de la capa de negocio. No se atribuye al alumno una comparación con otros algoritmos que no esté documentada.
- Estado: vigente.

## D-06 · Sesiones de servidor persistidas en PostgreSQL

- Qué: `express-session`, cookie de sesión y `connect-pg-simple`; regeneración en login y destrucción en logout.
- Evidencia: [app.js](../src/app.js), [server.js](../src/server.js), [rutas de autenticación](../src/api/auth.routes.js), [PR #4](https://github.com/AdrianMompo/macrolog-sprint1/pull/4) y [PR #6](https://github.com/AdrianMompo/macrolog-sprint1/pull/6).
- Por qué: los PR declaran mantener la sesión entre peticiones y recargas y persistirla tras reinicios. TODO(alumno): ¿Qué criterios motivaron elegir sesiones de servidor para la autenticación?
- Estado: vigente. El almacenamiento en memoria usado por las pruebas no acredita persistencia en producción.

## D-07 · Vitest y Supertest

- Qué: pruebas de servicios y pruebas HTTP automatizadas mediante el script `npm test`.
- Evidencia: [package.json](../package.json), [tests/](../tests/) y [PR #1](https://github.com/AdrianMompo/macrolog-sprint1/pull/1).
- Por qué: el PR documenta la incorporación de pruebas automatizadas. TODO(alumno): ¿Por qué elegiste Vitest y Supertest y cómo decidiste los casos que debían cubrir?
- Estado: vigente.

## D-08 · CI en GitHub Actions y despliegue declarado en Render

- Qué: CI en PR y push a `main`; configuración de Render con despliegue desde `main` condicionado a comprobaciones satisfactorias.
- Evidencia: [workflow](../.github/workflows/ci.yml), [render.yaml](../render.yaml), [PR #1](https://github.com/AdrianMompo/macrolog-sprint1/pull/1) y [PR #2](https://github.com/AdrianMompo/macrolog-sprint1/pull/2).
- Por qué: el PR #2 declara automatizar el despliegue después de CI. TODO(alumno): ¿Qué criterios motivaron elegir GitHub Actions y Render?
- Estado: vigente como configuración versionada. Por verificar: configuración efectiva del servicio Render e historial de despliegues vinculados a CI.

## D-09 · Baja lógica y autorización en el servicio

- Qué: una baja actualiza `deletedAt`; el servicio autoriza al administrador o al propietario y comprueba que el actor está activo.
- Evidencia: [UserService.deleteUser](../src/services/user.service.js), [repositorio PostgreSQL](../src/repositories/postgresUser.repository.js), [pruebas de negocio](../tests/user.service.test.js).
- Por qué: los PR describen eliminación y permisos, pero no justifican conservar la fila. TODO(alumno): ¿Por qué elegiste baja lógica en lugar de eliminación física?
- Estado: vigente.

Las decisiones describen la implementación, sin convertir las menciones a OAuth en la Variante 6 en una decisión de autenticación funcional. [Requisitos](requisitos.md) mantiene OAuth y confirmación por correo como pendientes.

Las decisiones D-10 y D-11 corresponden a RF-02 en el Sprint 2 y están expresamente aprobadas por el alumno. Su estado vigente documenta la decisión adoptada, sin acreditar la implementación de RF-02.

## D-10 · Servicio de correo transaccional mediante Brevo

- Qué: utilizar Brevo mediante su API REST para enviar los correos transaccionales de confirmación de cuentas.
- Por qué: TODO(alumno): ¿Qué motivos te llevaron a elegir Brevo frente a otras alternativas?
- Estado: vigente.

## D-11 · Tratamiento de correos ya registrados

- Qué: mantener HTTP 409 EMAIL_ALREADY_EXISTS al intentar registrar un correo existente. El endpoint de reenvío de confirmación utilizará una respuesta genérica y solo enviará un nuevo enlace cuando la cuenta esté pendiente.
- Por qué: TODO(alumno): ¿Por qué decidiste mantener el 409 durante el registro y utilizar una respuesta genérica en el reenvío?
- Estado: vigente.
