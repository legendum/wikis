# Validation - ElysiaJS

## Overview

Elysia uses **TypeBox** (`t`) for schema validation with runtime checking, type inference, and OpenAPI generation.

```typescript
import { Elysia, t } from 'elysia'

new Elysia()
    .get('/id/:id', ({ params: { id } }) => id, {
        params: t.Object({ id: t.Number() })
    })
```

Also supports Standard Schema (Zod, Valibot, ArkType, etc.).

## Schema Types

### Body
```typescript
.post('/body', ({ body }) => body, {
    body: t.Object({ name: t.String() })
})
```

### Query
```typescript
.get('/query', ({ query }) => query, {
    query: t.Object({ name: t.String() })
})
```
Auto-coerces types. Arrays via `t.Array(t.String())`.

### Params
```typescript
.get('/id/:id', ({ params }) => params, {
    params: t.Object({ id: t.Number() })
})
```

### Headers
```typescript
.get('/', ({ headers }) => headers, {
    headers: t.Object({ authorization: t.String() })
})
```
Headers are lowercase only.

### Cookie
```typescript
.get('/', ({ cookie }) => cookie, {
    cookie: t.Cookie({ name: t.String() }, { secure: true, httpOnly: true })
})
```

### Response
```typescript
.get('/', () => ({ name: 'Jane' }), {
    response: t.Object({ name: t.String() })
})
```

Per-status:
```typescript
response: {
    200: t.Object({ name: t.String() }),
    400: t.Object({ error: t.String() })
}
```

## Guard

Apply schemas to multiple routes:

```typescript
.guard({ query: t.Object({ name: t.String() }) })
.get('/query', ({ query }) => query)
```

## File Upload

```typescript
body: t.Object({
    file: t.File({ format: 'image/*' }),
    multipleFiles: t.Files()
})
```

## Custom Error Messages

```typescript
body: t.Object({
    x: t.Number({ error: 'x must be a number' })
})
```

## Reference Models

```typescript
new Elysia()
    .model({ sign: t.Object({ username: t.String(), password: t.String() }) })
    .post('/sign-in', ({ body }) => body, { body: 'sign' })
```

## TypeScript

```typescript
const MyType = t.Object({ hello: t.Literal('Elysia') })
type MyType = typeof MyType.static
```
