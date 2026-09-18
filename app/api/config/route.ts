export function GET() {
  return Response.json({
    userPoolId: process.env.USER_POOL_ID ?? '',
    userPoolClientId: process.env.USER_POOL_CLIENT_ID ?? '',
    local: process.env.FLOWSTACKS_LOCAL === 'true',
  });
}
