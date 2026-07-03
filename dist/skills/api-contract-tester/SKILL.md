---
name: api-contract-tester
description: "Use when writing or reviewing contract tests for an HTTP API — asserting request/response shape, status codes, and schema conformance against a JSON Schema or OpenAPI spec. Triggers: 'write a contract test', 'add a schema assertion', 'test the API response shape', 'add a negative test case', 'validate against the OpenAPI spec'."
---

# API Contract Tester

Conventions for contract tests on API-first projects: tests that verify an endpoint honors its documented request/response contract, independent of the internal implementation. Applies to REST endpoints tested against a JSON Schema or OpenAPI specification, in whatever test runner the project already uses.

## What a contract test asserts (and what it doesn't)

A contract test verifies the *shape* of the interface, not business logic correctness:

- Status code for a given input class (success, validation error, auth failure, not-found).
- Response body matches the declared schema: required fields present, types correct, no undocumented fields leaking through (when the spec declares `additionalProperties: false`).
- Request body/params required by the spec are actually required by the endpoint (and vice versa — undeclared params don't silently become mandatory).
- Headers the contract promises (`Content-Type`, pagination headers, rate-limit headers) are present and correctly formed.

A contract test does *not* assert specific business values ("the third item in the list is called X") — that's a functional/integration test's job. Keep the two test types separate; a contract test should stay green through data changes and only break when the shape of the API changes.

## Structure: one contract test per endpoint + status-code pair

Group tests by endpoint, then by the response scenario:

```
describe('GET /users/:id')
  it('200: returns a user matching the schema')
  it('404: returns an error body matching the schema when the id does not exist')
  it('400: returns a validation error when :id is not a valid UUID')
```

- Test file lives alongside the API-first source of truth for that resource (co-located with the route handler, or in a dedicated `contract/` test directory — follow whatever the project already does; establish the convention explicitly if none exists yet).
- Name the schema/spec source explicitly in the test (which OpenAPI operation ID or JSON Schema file is being validated against) so a spec update and a failing test are easy to connect.

## Schema assertions

Validate the actual response against the declared schema using a validator library (`ajv` for JSON Schema, `openapi-response-validator` / `express-openapi-validator` for OpenAPI) — never hand-roll field-by-field `expect(body.field).toBeDefined()` checks as a schema-validation substitute; hand-rolled checks drift from the spec silently, a real validator catches every field including ones nobody thought to check manually.

```js
import Ajv from 'ajv';
import userSchema from '../schemas/user.schema.json' assert { type: 'json' };

const ajv = new Ajv({ allErrors: true, strict: true });
const validateUser = ajv.compile(userSchema);

it('200: returns a user matching the schema', async () => {
  const res = await request(app).get('/users/123');
  expect(res.status).toBe(200);

  const valid = validateUser(res.body);
  expect(valid, ajv.errorsText(validateUser.errors)).toBe(true);
});
```

- `strict: true` / `additionalProperties: false` in the schema catches undocumented fields leaking into responses — a common source of accidental contract breaks (a field added for internal debugging that consumers start depending on).
- When testing against an OpenAPI spec directly, validate against the operation's response schema for that exact status code — a 200 and a 404 for the same path have different schemas; don't validate both against a merged "any response" shape.

## Status codes

- Assert the exact status code, not a range check (`expect(res.status).toBe(201)`, not `expect(res.status).toBeGreaterThanOrEqual(200)`).
- Cover the full documented status-code surface for the endpoint: success, each distinct 4xx the spec declares (400 validation, 401 unauthenticated, 403 unauthorized, 404 not found, 409 conflict), and any 5xx behavior the contract explicitly promises (e.g. a documented 503 during maintenance mode).
- A status code the spec doesn't document appearing in a real response is itself a contract violation worth its own test/assertion, not just a shape mismatch.

## Positive and negative cases

Every endpoint gets both:

- **Positive case(s)**: valid request → documented success status + schema-conformant body. Include boundary-valid inputs (minimum-length string, empty-but-allowed array) where the spec defines constraints.
- **Negative case(s)**: invalid request → documented error status + schema-conformant *error* body. Cover each declared failure mode separately (missing required field, wrong type, value outside declared enum/range, malformed auth token) rather than one generic "bad request" test — each failure mode is a distinct contract promise.

```js
describe('POST /users')
  it('201: creates a user and returns it matching the schema')                 // positive
  it('400: rejects a request missing the required "email" field')              // negative
  it('400: rejects a request where "email" is not a valid email format')       // negative
  it('409: rejects a request with an email that already exists')               // negative
```

- Negative-case error bodies get schema-validated too, against the spec's declared error schema — an inconsistent error shape across endpoints is exactly the kind of contract drift these tests exist to catch.

## Keeping tests in sync with the spec

- If the project has a machine-readable OpenAPI/JSON Schema file, generate the validator input from it directly (don't hand-maintain a second copy of the schema inside the test file — that's the two-sources-of-truth drift this whole skill exists to prevent).
- When the spec changes, the contract test suite should be the first thing that surfaces the break — treat a contract test failure after a spec change as expected signal, not noise to silence.
- Contract tests run independent of a full integration environment where possible (mocked/stubbed downstream dependencies) — the point is verifying *this service's* interface, not its dependencies' correctness.

## Conventions summary

- One test group per endpoint; one test per status-code scenario within it.
- Validate response shape with a real schema validator, never hand-rolled field checks.
- Assert exact status codes; cover every documented status, not just the happy path.
- Every endpoint has at least one negative case per distinct declared failure mode.
- Schema is sourced from the single spec file the project maintains — never duplicated inline.
