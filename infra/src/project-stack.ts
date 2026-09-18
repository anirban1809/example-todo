import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
  aws_apigatewayv2 as apigateway,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNode,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as deployment,
} from 'aws-cdk-lib';
import {
  bucketName,
  ownershipTags,
  resourcePrefix,
  type EnvironmentName,
  type HttpMethod,
  type ProjectConfig,
  type RateLimitPolicy,
} from '@flowstacks/core';
import type { Construct } from 'constructs';
import { createRouteEntry, discoverRouteFunctions } from './routes.js';

interface ProjectStackProps extends StackProps {
  config: ProjectConfig;
  environmentName: EnvironmentName;
  rootDirectory: string;
}

const gatewayMethods: Record<HttpMethod, apigateway.HttpMethod> = {
  GET: apigateway.HttpMethod.GET,
  POST: apigateway.HttpMethod.POST,
  PUT: apigateway.HttpMethod.PUT,
  PATCH: apigateway.HttpMethod.PATCH,
  DELETE: apigateway.HttpMethod.DELETE,
  HEAD: apigateway.HttpMethod.HEAD,
  OPTIONS: apigateway.HttpMethod.OPTIONS,
};

function physicalName(prefix: string, suffix: string): string {
  const requested = `${prefix}-${suffix}`;
  if (requested.length <= 64) return requested;
  const hash = createHash('sha256').update(requested).digest('hex').slice(0, 10);
  return `${requested.slice(0, 53).replace(/-$/, '')}-${hash}`;
}

function concurrency(policy: RateLimitPolicy): number {
  return Math.max(
    policy.anonymous?.concurrency ?? 0,
    ...Object.values(policy.tiers).map((tier) => tier.concurrency),
  );
}

export class ProjectStack extends Stack {
  constructor(scope: Construct, id: string, props: ProjectStackProps) {
    super(scope, id, props);
    const { config, environmentName, rootDirectory } = props;
    const prefix = resourcePrefix(environmentName, config.tenantId, config.projectId);
    for (const [key, value] of Object.entries(ownershipTags(config.tenantId, config.projectId, environmentName))) {
      Tags.of(this).add(key, value);
    }
    if (environmentName.startsWith('feature-')) Tags.of(this).add('flowstacks:ephemeral', 'true');

    const retain = environmentName === 'production' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const identityTable = new dynamodb.Table(this, 'IdentityTable', {
      tableName: `${prefix}-identity`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: environmentName === 'production' },
      removalPolicy: retain,
    });
    identityTable.addGlobalSecondaryIndex({
      indexName: 'member-index',
      partitionKey: { name: 'memberPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'memberSk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const usageTable = new dynamodb.Table(this, 'UsageTable', {
      tableName: `${prefix}-usage`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: retain,
    });

    const userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: retain,
    });
    const client = userPool.addClient('WebClient', {
      userPoolClientName: `${prefix}-web`,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
    });
    const jwt = new authorizers.HttpJwtAuthorizer(
      'ProjectJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [client.userPoolClientId] },
    );
    const api = new apigateway.HttpApi(this, 'Api', {
      apiName: `${prefix}-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowHeaders: ['authorization', 'content-type', 'x-flowstacks-tenant-id'],
        allowMethods: [apigateway.CorsHttpMethod.ANY],
      },
    });

    const functions = discoverRouteFunctions(rootDirectory, config.framework);
    if (!functions.length) throw new Error('No Route Handlers found for this project');
    const discoveredKeys = new Set(functions.map((fn) => `${fn.method} ${fn.routePath}`));
    for (const routeKey of Object.keys(config.routes)) {
      if (!discoveredKeys.has(routeKey)) throw new Error(`Configured route ${routeKey} was not discovered`);
    }
    const routeFunctions: lambdaNode.NodejsFunction[] = [];
    for (const route of functions) {
      const routeKey = `${route.method} ${route.routePath}`;
      const routePolicy = config.routes[routeKey] ?? config.defaultRoutePolicy;
      const ratePolicy = config.rateLimitPolicies[routePolicy.rateLimitPolicy];
      if (!ratePolicy) throw new Error(`Route ${routeKey} references missing policy ${routePolicy.rateLimitPolicy}`);
      if (routePolicy.auth === 'public' && !ratePolicy.anonymous) {
        throw new Error(`Public route ${routeKey} requires anonymous limits`);
      }
      const fn = new lambdaNode.NodejsFunction(this, `Route${route.id}`, {
        functionName: physicalName(prefix, `route-${route.id}`),
        entry: createRouteEntry(rootDirectory, route),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(20),
        tracing: lambda.Tracing.ACTIVE,
        ...(environmentName.startsWith('feature-') ? { logGroup: new logs.LogGroup(this, `Logs${route.id}`, {
          logGroupName: `/aws/lambda/${physicalName(prefix, `route-${route.id}`)}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: retain,
        }) } : {}),
        reservedConcurrentExecutions: concurrency(ratePolicy),
        projectRoot: rootDirectory,
        depsLockFilePath: join(rootDirectory, 'package-lock.json'),
        environment: {
          IDENTITY_TABLE: identityTable.tableName,
          USAGE_TABLE: usageTable.tableName,
          USER_POOL_ID: userPool.userPoolId,
          USER_POOL_CLIENT_ID: client.userPoolClientId,
          FLOWSTACKS_LOCAL: 'false',
          FLOWSTACKS_FUNCTION_ID: route.id,
          FLOWSTACKS_ROUTE_KEY: routeKey,
          FLOWSTACKS_ROUTE_POLICY: JSON.stringify(routePolicy),
          FLOWSTACKS_RATE_POLICY: JSON.stringify(ratePolicy),
        },
        bundling: {
          minify: true,
          sourceMap: true,
          tsconfig: join(rootDirectory, 'tsconfig.json'),
        },
      });
      Tags.of(fn).add('flowstacks:component', 'http-function');
      identityTable.grantReadWriteData(fn);
      usageTable.grantReadWriteData(fn);
      routeFunctions.push(fn);
      const integration = new integrations.HttpLambdaIntegration(`Integration${route.id}`, fn);
      for (const [index, path] of route.gatewayPaths.entries()) {
        api.addRoutes({
          path,
          methods: [gatewayMethods[route.method]],
          integration,
          ...(routePolicy.auth === 'cognito' ? { authorizer: jwt } : {}),
        });
        if (index > 0) fn.node.addMetadata('flowstacks:additional-route', path);
      }
      fn.node.addMetadata('flowstacks:route-key', routeKey);
      fn.node.addMetadata('flowstacks:auth', routePolicy.auth);
      fn.node.addMetadata('flowstacks:rate-limit-policy', routePolicy.rateLimitPolicy);
    }
    const stage = api.defaultStage?.node.defaultChild as apigateway.CfnStage | undefined;
    if (stage) stage.defaultRouteSettings = { throttlingBurstLimit: 1_000, throttlingRateLimit: 1_000 };

    const web = new s3.Bucket(this, 'WebBucket', {
      bucketName: bucketName(prefix, 'web', this.account, this.region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: environmentName === 'production',
      removalPolicy: retain,
      autoDeleteObjects: environmentName !== 'production',
    });
    const routePages = new cloudfront.Function(this, 'RoutePages', {
      code: cloudfront.FunctionCode.fromInline(
        config.framework === 'nextjs'
          ? `function handler(event) { var r=event.request,u=r.uri; if(u.charAt(u.length-1)==='/')r.uri=u+'index.html'; else if(u.split('/').pop().indexOf('.')===-1)r.uri=u+'/index.html'; return r; }`
          : `function handler(event) { var r=event.request,u=r.uri; if(u.split('/').pop().indexOf('.')===-1)r.uri='/index.html'; return r; }`,
      ),
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    };
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        functionAssociations: [{ function: routePages, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: { api: apiBehavior, 'api/*': apiBehavior },
      errorResponses: [{ httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.seconds(0) }],
    });
    new deployment.BucketDeployment(this, 'DeployWeb', {
      sources: [deployment.Source.asset(join(rootDirectory, 'dist'))],
      destinationBucket: web,
      distribution,
      distributionPaths: ['/*'],
    });
    for (const fn of routeFunctions) fn.addEnvironment('APP_ORIGIN', `https://${distribution.distributionDomainName}`);

    new CfnOutput(this, 'WebUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'IdentityTableName', { value: identityTable.tableName });
    new CfnOutput(this, 'UsageTableName', { value: usageTable.tableName });
  }
}
