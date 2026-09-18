import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/);
export const permanentEnvironmentSchema = z.enum(['development', 'staging', 'production']);
export const featureEnvironmentSchema = z.string().regex(/^feature-[a-f0-9]{16}$/);
export const environmentSchema = z.union([permanentEnvironmentSchema, featureEnvironmentSchema]);
export const projectFrameworkSchema = z.enum(['react-vite', 'nextjs']);
export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export const routeAuthSchema = z.enum(['cognito', 'public']);
export const rateLimitScopeSchema = z.enum(['ip', 'user', 'tenant', 'global']);
export const quotaPeriodSchema = z.enum(['hour', 'day', 'month', 'lifetime']);
export const routeKeySchema = z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/api(?:\/[^\s?#{}]+)*$/);
export const rateRuleSchema = z.object({ scope: rateLimitScopeSchema, requests: z.number().int().positive(), windowSeconds: z.number().int().min(1).max(86_400) });
export const quotaRuleSchema = z.object({ scope: rateLimitScopeSchema, requests: z.number().int().positive(), period: quotaPeriodSchema });
export const tierLimitSchema = z.object({ rate: z.array(rateRuleSchema).min(1), quota: quotaRuleSchema.optional(), concurrency: z.number().int().min(1).max(1_000) });
export const rateLimitPolicySchema = z.object({
  anonymous: tierLimitSchema.optional(),
  tiers: z.record(idSchema, tierLimitSchema).refine((tiers) => Boolean(tiers.free), { message: 'Every rate-limit policy must define a free tier' }),
});
export const routePolicySchema = z.object({ auth: routeAuthSchema.default('cognito'), rateLimitPolicy: idSchema });
const defaultStandardPolicy = {
  anonymous: {
    rate: [
      { scope: 'ip' as const, requests: 30, windowSeconds: 60 },
      { scope: 'global' as const, requests: 300, windowSeconds: 60 },
    ],
    quota: { scope: 'global' as const, requests: 10_000, period: 'month' as const },
    concurrency: 5,
  },
  tiers: {
    free: {
      rate: [
        { scope: 'user' as const, requests: 60, windowSeconds: 60 },
        { scope: 'tenant' as const, requests: 300, windowSeconds: 60 },
      ],
      quota: { scope: 'tenant' as const, requests: 25_000, period: 'month' as const },
      concurrency: 10,
    },
    paid: {
      rate: [
        { scope: 'user' as const, requests: 600, windowSeconds: 60 },
        { scope: 'tenant' as const, requests: 3_000, windowSeconds: 60 },
      ],
      quota: { scope: 'tenant' as const, requests: 1_000_000, period: 'month' as const },
      concurrency: 100,
    },
  },
};
export const projectConfigSchema = z.object({
  tenantId: idSchema,
  projectId: idSchema,
  name: z.string().min(1).max(80),
  repository: z.url().nullable().default(null),
  environments: z.array(environmentSchema).min(1).refine((values) => values.every((value) => permanentEnvironmentSchema.safeParse(value).success)).default(['development']),
  featureEnvironments: z.boolean().optional(),
  framework: projectFrameworkSchema.default('react-vite'),
  defaultRoutePolicy: routePolicySchema.default({ auth: 'cognito', rateLimitPolicy: 'standard' }),
  routes: z.record(routeKeySchema, routePolicySchema).default({}),
  rateLimitPolicies: z.record(idSchema, rateLimitPolicySchema).default({ standard: defaultStandardPolicy }),
}).superRefine((config, context) => {
  const referenced = new Set([config.defaultRoutePolicy.rateLimitPolicy, ...Object.values(config.routes).map((route) => route.rateLimitPolicy)]);
  for (const policy of referenced) if (!config.rateLimitPolicies[policy]) context.addIssue({ code: 'custom', path: ['rateLimitPolicies', policy], message: `Missing rate-limit policy ${policy}` });
  for (const [route, policy] of Object.entries(config.routes)) if (policy.auth === 'public' && !config.rateLimitPolicies[policy.rateLimitPolicy]?.anonymous) context.addIssue({ code: 'custom', path: ['routes', route], message: `Public route ${route} requires anonymous limits` });
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type EnvironmentName = z.infer<typeof environmentSchema>;
export type HttpMethod = z.infer<typeof httpMethodSchema>;
export type RoutePolicy = z.infer<typeof routePolicySchema>;
export type RateLimitPolicy = z.infer<typeof rateLimitPolicySchema>;
export type TierLimit = z.infer<typeof tierLimitSchema>;

const safeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
export const resourcePrefix = (environment: string, tenantId: string, projectId: string) => ['flowstacks', environment, tenantId, projectId].map(safeName).join('-');
export const bucketName = (prefix: string, purpose: string, account: string, region: string) => {
  const fullName = `${prefix}-${safeName(purpose)}-${account}-${region}`;
  if (fullName.length <= 63) return fullName;
  let hash = 2166136261;
  for (const character of prefix) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const suffix = `-${safeName(purpose)}-${(hash >>> 0).toString(36).padStart(7, '0')}-${account}-${region}`;
  return `${prefix.slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
};
export const ownershipTags = (tenantId: string, projectId: string, environment: string) => ({
  'flowstacks:managed': 'true',
  'flowstacks:tenant-id': tenantId,
  'flowstacks:project-id': projectId,
  'flowstacks:environment': environment,
});
