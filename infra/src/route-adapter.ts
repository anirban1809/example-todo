import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { HttpMethod, RateLimitPolicy, RoutePolicy, TierLimit } from '@flowstacks/core';

interface JwtAuthorizer { jwt?: { claims?: Record<string, string | number | boolean> } }
interface HttpApiEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined>;
  requestContext: {
    domainName?: string;
    authorizer?: JwtAuthorizer;
    http: { method: string; sourceIp?: string };
  };
}

type HandlerContext = { params: Promise<Record<string, string | string[]>> };
type RouteHandler = (request: Request, context: HandlerContext) => Response | Promise<Response>;
type RouteModule = Partial<Record<HttpMethod, RouteHandler>>;
interface AdapterOptions {
  method: HttpMethod;
  parameters: Array<{ gatewayName: string; routeName: string; catchAll: boolean }>;
  routePolicy?: RoutePolicy;
  ratePolicy?: RateLimitPolicy;
}
interface RuntimeIdentity {
  userId?: string;
  tenantId: string;
  tier: string;
  roles: string[];
  ip: string;
}

const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    ...(process.env.DYNAMODB_ENDPOINT
      ? {
          endpoint: process.env.DYNAMODB_ENDPOINT,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);

function requestUrl(event: HttpApiEvent): string {
  const protocol = event.headers?.['x-forwarded-proto'] ?? 'https';
  const host = event.headers?.['x-forwarded-host'] ?? event.headers?.host ?? event.requestContext.domainName ?? 'localhost';
  return `${protocol}://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
}

function requestBody(event: HttpApiEvent): ArrayBuffer | undefined {
  if (!event.body) return undefined;
  const buffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function routeParams(event: HttpApiEvent, options: AdapterOptions) {
  const params: Record<string, string | string[]> = {};
  for (const parameter of options.parameters) {
    const value = event.pathParameters?.[parameter.gatewayName];
    if (value === undefined) continue;
    params[parameter.routeName] = parameter.catchAll
      ? value.split('/').map(decodeURIComponent)
      : decodeURIComponent(value);
  }
  return params;
}

async function lambdaResponse(response: Response, omitBody = false) {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value;
  }
  const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = cookieHeaders.getSetCookie?.();
  const bytes = omitBody ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers,
    ...(cookies?.length ? { cookies } : {}),
    ...(bytes.byteLength
      ? { body: Buffer.from(bytes).toString('base64'), isBase64Encoded: true }
      : { body: '' }),
  };
}

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers });
}

function environmentJson<T>(name: string): T {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return JSON.parse(value) as T;
}

async function resolveIdentity(event: HttpApiEvent, policy: RoutePolicy): Promise<RuntimeIdentity> {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const userId = claims?.sub ? String(claims.sub) : undefined;
  if (policy.auth === 'cognito' && !userId) throw new Response(null, { status: 401 });
  const ip = event.requestContext.http.sourceIp ?? event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
  if (!userId) return { tenantId: 'anonymous', tier: 'anonymous', roles: [], ip };

  const requestedTenant = event.headers?.['x-flowstacks-tenant-id'];
  const tenantId = requestedTenant || userId;
  const identityTable = process.env.IDENTITY_TABLE;
  if (!identityTable || process.env.FLOWSTACKS_LOCAL === 'true') {
    return { userId, tenantId, tier: 'free', roles: ['owner'], ip };
  }
  let roles = requestedTenant ? ['member'] : ['owner'];
  if (requestedTenant) {
    const membership = await documentClient.send(new GetCommand({
      TableName: identityTable,
      Key: { pk: `TENANT#${tenantId}`, sk: `MEMBER#${userId}` },
      ConsistentRead: true,
    }));
    if (!membership.Item) throw new Response(null, { status: 403 });
    roles = Array.isArray(membership.Item.roles)
      ? membership.Item.roles.filter((role): role is string => typeof role === 'string')
      : typeof membership.Item.role === 'string'
        ? [membership.Item.role]
        : ['member'];
  }
  const account = await documentClient.send(new GetCommand({
    TableName: identityTable,
    Key: { pk: `TENANT#${tenantId}`, sk: 'META' },
    ConsistentRead: true,
  }));
  return {
    userId,
    tenantId,
    tier: typeof account.Item?.tier === 'string' ? account.Item.tier : 'free',
    roles,
    ip,
  };
}

function periodBucket(period: 'hour' | 'day' | 'month' | 'lifetime', now: Date): { key: string; reset: number } {
  const seconds = Math.floor(now.getTime() / 1000);
  if (period === 'lifetime') return { key: 'lifetime', reset: 253_402_300_799 };
  if (period === 'hour') {
    const start = Math.floor(seconds / 3600) * 3600;
    return { key: String(start), reset: start + 3600 };
  }
  if (period === 'day') {
    const start = Math.floor(seconds / 86400) * 86400;
    return { key: String(start), reset: start + 86400 };
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
  return { key: `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`, reset };
}

function scopeValue(scope: 'ip' | 'user' | 'tenant' | 'global', identity: RuntimeIdentity): string {
  if (scope === 'ip') return identity.ip;
  if (scope === 'user') return identity.userId ?? identity.ip;
  if (scope === 'tenant') return identity.tenantId;
  return 'global';
}

async function incrementCounter(pk: string, sk: string, limit: number, reset: number) {
  const table = process.env.USAGE_TABLE;
  if (!table || process.env.FLOWSTACKS_LOCAL === 'true') return limit - 1;
  try {
    const output = await documentClient.send(new UpdateCommand({
      TableName: table,
      Key: { pk, sk },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': limit, ':expiresAt': reset + 86_400 },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Math.max(0, limit - Number(output.Attributes?.count ?? 1));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return -1;
    throw error;
  }
}

async function enforceLimits(identity: RuntimeIdentity, limits: TierLimit) {
  const functionId = process.env.FLOWSTACKS_FUNCTION_ID ?? 'function';
  const now = new Date();
  const seconds = Math.floor(now.getTime() / 1000);
  let remaining = Number.MAX_SAFE_INTEGER;
  let reset = seconds + 60;
  for (const rule of limits.rate) {
    const start = Math.floor(seconds / rule.windowSeconds) * rule.windowSeconds;
    const ruleReset = start + rule.windowSeconds;
    for (const boundary of [`FUNCTION#${functionId}`, 'PROJECT']) {
      const value = await incrementCounter(
        `${boundary}#${rule.scope}#${scopeValue(rule.scope, identity)}`,
        `RATE#${rule.windowSeconds}#${start}`,
        rule.requests,
        ruleReset,
      );
      if (value < 0) throw new Response(null, { status: 429, headers: { 'retry-after': String(Math.max(1, ruleReset - seconds)) } });
      if (value < remaining) { remaining = value; reset = ruleReset; }
    }
  }
  if (limits.quota) {
    const bucket = periodBucket(limits.quota.period, now);
    for (const boundary of [`FUNCTION#${functionId}`, 'PROJECT']) {
      const value = await incrementCounter(
        `${boundary}#${limits.quota.scope}#${scopeValue(limits.quota.scope, identity)}`,
        `QUOTA#${limits.quota.period}#${bucket.key}`,
        limits.quota.requests,
        bucket.reset,
      );
      if (value < 0) throw new Response(null, { status: 429, headers: { 'retry-after': String(Math.max(1, bucket.reset - seconds)) } });
      if (value < remaining) { remaining = value; reset = bucket.reset; }
    }
  }
  return { remaining, reset };
}

export function createRouteHandler(route: RouteModule, options: AdapterOptions) {
  return async function handler(event: HttpApiEvent) {
    try {
      const routePolicy = options.routePolicy ?? environmentJson<RoutePolicy>('FLOWSTACKS_ROUTE_POLICY');
      const ratePolicy = options.ratePolicy ?? environmentJson<RateLimitPolicy>('FLOWSTACKS_RATE_POLICY');
      const identity = await resolveIdentity(event, routePolicy);
      const limits = identity.tier === 'anonymous'
        ? ratePolicy.anonymous
        : ratePolicy.tiers[identity.tier] ?? ratePolicy.tiers.free;
      if (!limits) return lambdaResponse(json(403, { error: 'This route is unavailable for the current account tier' }));
      const usage = await enforceLimits(identity, limits);
      const headers = new Headers();
      for (const [name, value] of Object.entries(event.headers ?? {})) {
        if (value !== undefined && !name.toLowerCase().startsWith('x-flowstacks-')) headers.set(name, value);
      }
      if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
      if (identity.userId) headers.set('x-flowstacks-user-id', identity.userId);
      headers.set('x-flowstacks-tenant-id', identity.tenantId);
      headers.set('x-flowstacks-account-tier', identity.tier);
      headers.set('x-flowstacks-roles', identity.roles.join(','));
      const request = new Request(requestUrl(event), {
        method: options.method,
        headers,
        ...(!['GET', 'HEAD'].includes(options.method) ? { body: requestBody(event) } : {}),
      });
      const selected = route[options.method];
      if (!selected) throw new Error(`Route does not export ${options.method}`);
      const response = await selected(request, { params: Promise.resolve(routeParams(event, options)) });
      if (!(response instanceof Response)) throw new Error('Route Handler must return a Response');
      response.headers.set('ratelimit-remaining', String(usage.remaining));
      response.headers.set('ratelimit-reset', String(usage.reset));
      return lambdaResponse(response, options.method === 'HEAD');
    } catch (error) {
      if (error instanceof Response) {
        const status = error.status || 500;
        const body = status === 429 ? { error: 'Rate limit exceeded' } : status === 401 ? { error: 'Unauthorized' } : { error: 'Forbidden' };
        return lambdaResponse(json(status, body, error.headers));
      }
      console.error(error);
      return lambdaResponse(json(500, { error: 'Internal server error' }));
    }
  };
}
