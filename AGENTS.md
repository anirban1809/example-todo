# Generated flowstacks.ai Next.js application

- This preset statically exports pages; it does not provide a persistent Next.js runtime.
- Keep Route Handlers below `app/api` or `src/app/api` and use standard Web `Request` and `Response` values.
- Do not introduce SSR pages, Server Actions, middleware, ISR, or Next.js-only server runtime dependencies.
- Each exported HTTP method and path becomes one Lambda and API Gateway route.
- Routes authenticate with Cognito by default. Public routes and rate-limit policies must be explicit in `flowstacks.json`.
- Never trust browser-supplied `x-flowstacks-*` identity headers.
- Preserve production resources, ownership tags, and the direct CDK deployment path.
