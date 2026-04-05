# Lifecycle - ElysiaJS

## Lifecycle Events (In Order)

1. **Request** - New incoming event
2. **Parse** - Parse body into Context.body
3. **Transform** - Modify Context before validation
4. **Before Handle** - Custom validation before route handler
5. **After Handle** - Tweak returned value from route handler
6. **Map Response** - Map returned value into HTTP response
7. **On Error** - Handle errors thrown in lifecycle
8. **After Response** - Cleanup after response sent
9. **Trace** - Audit and capture timespan

## Hooks

### Local Hooks (on specific route)

```typescript
.get('/', () => '<h1>Hello</h1>', {
    afterHandle({ responseValue, set }) {
        if (isHtml(responseValue))
            set.headers['Content-Type'] = 'text/html; charset=utf8'
    }
})
```

### Interceptor Hooks (on all subsequent routes)

```typescript
.onAfterHandle(({ responseValue, set }) => {
    if (isHtml(responseValue))
        set.headers['Content-Type'] = 'text/html; charset=utf8'
})
.get('/', () => '<h1>Hello</h1>')
```

**Important:** Hooks only apply to routes registered *after* the hook (except `onRequest` which is global).

## Key Stages

### Before Handle

Ideal for auth. Returning a value skips the route handler:

```typescript
.get('/', () => 'hi', {
    beforeHandle({ cookie: { session }, status }) {
        if (!validateSession(session.value)) return status(401)
    }
})
```

### Guard

Apply same beforeHandle to multiple routes:

```typescript
.guard(
    { beforeHandle({ status }) { if (!isAuthorized()) return status(401) } },
    (app) => app.get('/user/:id', handler)
)
```

### Derive

Append values to context before validation (runs per-request):

```typescript
.derive(({ headers }) => ({
    bearer: headers['Authorization']?.slice(7) ?? null
}))
```

### Resolve

Append values to context after validation:

```typescript
.resolve(({ headers: { authorization } }) => ({
    bearer: authorization.split(' ')[1]
}))
```

### On Error

```typescript
.onError(({ error, code, status }) => {
    if (code === 'NOT_FOUND') return status(404, 'Not Found')
})
```

Error codes: `NOT_FOUND`, `PARSE`, `VALIDATION`, `INTERNAL_SERVER_ERROR`, `INVALID_COOKIE_SIGNATURE`, `UNKNOWN`.

### After Response

Cleanup and analytics:

```typescript
.onAfterResponse(({ responseValue, set }) => {
    console.log(set.status, set.headers)
})
```
