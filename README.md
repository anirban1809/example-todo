# example-todo

This standalone flowstacks.ai project contains statically exported Next.js pages and Route Handlers deployed as individual Lambda functions.

```sh
npm install
npm run dev
```

Place backend routes below `app/api/**/route.ts` or `src/app/api/**/route.ts`. Each exported HTTP method and path becomes one Lambda. Use standard Web `Request` and `Response` values; do not depend on a persistent Next.js server.

The first-release runtime intentionally excludes SSR pages, Server Actions, middleware, ISR, and Next.js request-scoped server helpers. Routes use Cognito and tier-aware rate limiting by default. Public access must be declared explicitly in `flowstacks.json`.

Run `npm run synth` to inspect the generated CloudFormation or `npm run deploy` to manage the application directly in AWS.
