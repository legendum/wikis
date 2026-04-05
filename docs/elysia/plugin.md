# Plugin - ElysiaJS

## Overview

Every Elysia instance can run independently or be used as part of another instance via `.use()`:

```typescript
const plugin = new Elysia()
    .decorate('plugin', 'hi')
    .get('/plugin', ({ plugin }) => plugin)

const app = new Elysia()
    .use(plugin)
    .get('/', ({ plugin }) => plugin)
    .listen(3000)
```

Plugins inherit state/decorators but NOT lifecycle hooks (isolated by default).

## Deduplication

Prevent repeated execution with `name`:

```typescript
const ip = new Elysia({ name: 'ip' })
    .derive({ as: 'global' }, ({ server, request }) => ({
        ip: server?.requestIP(request)
    }))
```

## Scope Levels

1. **local** (default) - current instance and descendants
2. **scoped** - parent, current, and descendants
3. **global** - all instances using the plugin

```typescript
.onBeforeHandle({ as: 'global' }, ({ cookie }) => {
    throwIfNotSignIn(cookie)
})
```

## Guard

Apply schemas/hooks to multiple routes:

```typescript
new Elysia()
    .guard(
        { body: t.Object({ username: t.String(), password: t.String() }) },
        (app) =>
            app
                .post('/sign-up', ({ body }) => signUp(body))
                .post('/sign-in', ({ body }) => signIn(body))
    )
```

## Configuration

Configurable plugins via functions:

```typescript
const version = (v = 1) => new Elysia()
    .get('/version', v)

new Elysia()
    .use(version(1))
    .listen(3000)
```

## Scope Casting

### Inline: `{ as: 'scoped' }`
### Instance-wide: `.as('scoped')`

## Lazy Loading

```typescript
const app = new Elysia().use(import('./plugin'))
await app.modules // for testing
```
