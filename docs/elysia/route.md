# Route - ElysiaJS

## Routing

Web servers use the request's **path and method** to locate the correct resource. A route is defined by an HTTP verb method, a path, and a function to execute when matched.

```typescript
import { Elysia } from 'elysia'

new Elysia()
    .get('/', 'hello')
    .get('/hi', 'hi')
    .listen(3000)
```

## Path Types

- **Static paths** - hardcoded strings
- **Dynamic paths** - segments capturing variable values
- **Wildcards** - match everything up to a specific point

```typescript
new Elysia()
    .get('/id/1', 'static path')
    .get('/id/:id', 'dynamic path')
    .get('/id/*', 'wildcard path')
    .listen(3000)
```

### Dynamic Path

Capture values using `:` prefix:

```typescript
new Elysia()
    .get('/id/:id', ({ params: { id } }) => id)
    .get('/id/:id/:name', ({ params: { id, name } }) => id + ' ' + name)
    .listen(3000)
```

Optional parameters with `?`:

```typescript
.get('/id/:id?', ({ params: { id } }) => `id ${id}`)
```

### Wildcards

Capture remaining path with `*`:

```typescript
.get('/id/*', ({ params }) => params['*'])
```

## Path Priority

1. Static paths
2. Dynamic paths
3. Wildcards

## HTTP Verbs

```typescript
new Elysia()
    .get('/', 'hello')
    .post('/hi', 'hi')
    .listen(3000)
```

Custom methods via `Elysia.route`:

```typescript
.route('M-SEARCH', '/m-search', 'connect')
```

Handle any method with `Elysia.all`:

```typescript
.all('/', 'hi')
```

## Handle

Test APIs programmatically:

```typescript
app.handle(new Request('http://localhost/')).then(console.log)
```

## Group

Share route prefixes:

```typescript
new Elysia()
    .group('/user', (app) =>
        app
            .post('/sign-in', 'Sign in')
            .post('/sign-up', 'Sign up')
    )
    .listen(3000)
```

Or use the `prefix` constructor option:

```typescript
const users = new Elysia({ prefix: '/user' })
    .post('/sign-in', 'Sign in')
    .post('/sign-up', 'Sign up')

new Elysia()
    .use(users)
    .listen(3000)
```
