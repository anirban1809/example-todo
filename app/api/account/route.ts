export function GET(request: Request) {
  return Response.json({
    userId: request.headers.get('x-flowstacks-user-id'),
    tenantId: request.headers.get('x-flowstacks-tenant-id'),
    tier: request.headers.get('x-flowstacks-account-tier'),
  });
}
