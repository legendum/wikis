# Handler - ElysiaJS

## Overview

A handler accepts an HTTP request and returns a response.

```typescript
new Elysia()
    .get('/', () => 'hello world')
    .listen(3000)
```

## Context

Contains request-specific information:

- **body** - HTTP message, form, or file upload
- **query** - Query string parameters
- **params** - Path parameters
- **headers** - HTTP headers
- **cookie** - Mutable cookie store
- **store** - Global mutable state
- **request** - Web Standard Request object
- **server** - Bun server instance
- **path** - Request pathname

### Utility Functions

- **redirect()** - Redirect to another resource
- **status()** - Return custom status code with type narrowing
- **set** - Shape response (headers, status)

## Status Code

```typescript
.get('/', ({ status }) => status(418, "I'm a teapot"))
```

## Set Headers

```typescript
.get('/', ({ set }) => {
    set.headers['x-powered-by'] = 'Elysia'
    return 'hello'
})
```

## Redirect

```typescript
.get('/', ({ redirect }) => redirect('https://example.com'))
.get('/custom', ({ redirect }) => redirect('https://example.com', 302))
```

## Cookie

```typescript
.get('/set', ({ cookie: { name } }) => {
    name.value        // Get
    name.value = "X"  // Set
})
```

Mutable cookie fields include `httpOnly`, `secure`, `sameSite`, `maxAge`, `path` (see `CookieOptions` in `elysia/dist/cookies.d.ts`). Use **`httpOnly: false`** when the SPA must read the cookie (e.g. `document.cookie`) to choose between two server routes.

## FormData

```typescript
import { Elysia, form, file } from 'elysia'

new Elysia()
    .get('/', () => form({
        name: 'Tea Party',
        images: [file('a.webp'), file('b.webp')]
    }))
```

## Streaming

```typescript
.get('/stream', function* () {
    yield 1
    yield 2
    yield 3
})
```

## Server Sent Events

```typescript
import { sse } from 'elysia'

.get('/sse', function* () {
    yield sse({ event: 'message', data: { hello: 'world' } })
})
```

## Request

Access the Web Standard Request object:

```typescript
.get('/', ({ request }) => request.headers.get('user-agent'))
```

## Server (Bun Only)

```typescript
.get('/ip', ({ server, request }) => server?.requestIP(request))
```
