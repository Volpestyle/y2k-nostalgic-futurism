import * as path from "path";
import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Size,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class Y2kLoungeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const appName = "y2k";
    const uiBucketName = process.env.UI_BUCKET_NAME;
    const dataBucketName = process.env.IMG2MESH3D_S3_BUCKET;
    const tableName = process.env.IMG2MESH3D_DDB_TABLE;
    const queueName = process.env.IMG2MESH3D_QUEUE_NAME || `${appName}-jobs`;
    const apiFunctionName = process.env.API_LAMBDA_NAME;
    const workerFunctionName = process.env.WORKER_LAMBDA_NAME;
    const appDomainName = process.env.APP_DOMAIN_NAME;
    const appCertArn = process.env.APP_CERT_ARN;
    const hostedZoneName = process.env.HOSTED_ZONE_NAME;
    const hostedZoneId = process.env.HOSTED_ZONE_ID;
    if (appDomainName && !appCertArn) {
      throw new Error("APP_DOMAIN_NAME requires APP_CERT_ARN.");
    }

    const appOrigin = appDomainName
      ? `https://${appDomainName}`
      : "https://y2k.jcvolpe.me";
    const corsAllowOrigins =
      process.env.IMG2MESH3D_CORS_ORIGINS ||
      `${appOrigin},http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173`;
    const authRequired = process.env.AUTH_JWT_REQUIRED || "true";
    const authIssuer = process.env.AUTH_JWT_ISSUER || "https://jcvolpe.me";
    const authAudience =
      process.env.AUTH_JWT_AUDIENCE ||
      appDomainName ||
      "y2k.jcvolpe.me";
    const authJwksUrl =
      process.env.AUTH_JWT_JWKS_URL || "https://jcvolpe.me/api/auth/jwks";
    const authApp = process.env.AUTH_JWT_APP || appName;
    const authLeeway = process.env.AUTH_JWT_LEEWAY_SECONDS || "30";
    const s3Prefix = process.env.IMG2MESH3D_S3_PREFIX || appName;
    const envSecretId = process.env.SECRETS_MANAGER_ENV_SECRET_ID;
    const repoSecretId = process.env.SECRETS_MANAGER_REPO_SECRET_ID;
    const adminTableName = process.env.ADMIN_TABLE_NAME;
    const costTableName = process.env.COST_TABLE_NAME;
    const costAppId = process.env.COST_APP_ID || appName;
    const rateLimitAppId = process.env.RATE_LIMIT_APP_ID || appName;
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    const jobTtlDays = Number.parseInt(
      process.env.IMG2MESH3D_JOB_TTL_DAYS || "7",
      10
    );

    const apiMemorySize = Number.parseInt(
      process.env.API_LAMBDA_MEMORY || "2048",
      10
    );
    const apiTimeoutSeconds = Number.parseInt(
      process.env.API_LAMBDA_TIMEOUT_SECONDS || "30",
      10
    );
    const workerMemorySize = Number.parseInt(
      process.env.WORKER_LAMBDA_MEMORY || "4096",
      10
    );
    const workerTimeoutSeconds = Number.parseInt(
      process.env.WORKER_LAMBDA_TIMEOUT_SECONDS || "900",
      10
    );

    const secretsEnv: Record<string, string> = {};
    if (envSecretId) {
      secretsEnv.SECRETS_MANAGER_ENV_SECRET_ID = envSecretId;
    }
    if (repoSecretId) {
      secretsEnv.SECRETS_MANAGER_REPO_SECRET_ID = repoSecretId;
    }

    const optionalEnv: Record<string, string> = {
      COST_APP_ID: costAppId,
      RATE_LIMIT_APP_ID: rateLimitAppId,
    };
    if (adminTableName) {
      optionalEnv.ADMIN_TABLE_NAME = adminTableName;
    }
    if (costTableName) {
      optionalEnv.COST_TABLE_NAME = costTableName;
    }
    if (upstashUrl) {
      optionalEnv.UPSTASH_REDIS_REST_URL = upstashUrl;
    }
    if (upstashToken) {
      optionalEnv.UPSTASH_REDIS_REST_TOKEN = upstashToken;
    }

    const repoRoot = path.join(__dirname, "../..");
    const dockerAssetExcludes = [
      ".git",
      ".git/**",
      "node_modules",
      "node_modules/**",
    ];
    const uiBucket = new s3.Bucket(this, "UiBucket", {
      bucketName: uiBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const uiOrigin = new origins.S3Origin(uiBucket);
    const uiOac = new cloudfront.CfnOriginAccessControl(this, "UiOac", {
      originAccessControlConfig: {
        name: `${appName}-ui`,
        description: "OAC for UI bucket",
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });

    const spaRewriteFunction = new cloudfront.Function(
      this,
      "UiSpaRewriteFunction",
      {
        code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri || '/';
  if (uri.startsWith('/api')) {
    return request;
  }
  if (uri === '/') {
    request.uri = '/index.html';
    return request;
  }
  if (uri.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`),
      }
    );

    const uiDistributionProps: cloudfront.DistributionProps = {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: uiOrigin,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewriteFunction,
          },
        ],
      },
    };

    if (appDomainName && appCertArn) {
      uiDistributionProps.domainNames = [appDomainName];
      uiDistributionProps.certificate = acm.Certificate.fromCertificateArn(
        this,
        "AppCertificate",
        appCertArn
      );
    }

    const uiDistribution = new cloudfront.Distribution(
      this,
      "UiDistribution",
      uiDistributionProps
    );

    const cfnDistribution = uiDistribution
      .node.defaultChild as cloudfront.CfnDistribution;
    // Keep the origin list lazy; resolving early drops later origins added via addBehavior.
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId",
      uiOac.getAtt("Id")
    );
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity",
      ""
    );

    uiBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [uiBucket.arnForObjects("*")],
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        conditions: {
          StringEquals: {
            "AWS:SourceArn": `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${uiDistribution.distributionId}`,
          },
        },
      })
    );

    const dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: dataBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const jobsTable = new dynamodb.Table(this, "JobsTable", {
      tableName,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "job_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sort", type: dynamodb.AttributeType.NUMBER },
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const jobsDlq = new sqs.Queue(this, "JobsDlq", {
      queueName: `${queueName}-dlq`,
      retentionPeriod: Duration.days(14),
    });

    const jobsQueue = new sqs.Queue(this, "JobsQueue", {
      queueName,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(
        Math.max(workerTimeoutSeconds + 60, 120)
      ),
      deadLetterQueue: {
        queue: jobsDlq,
        maxReceiveCount: 3,
      },
    });

    const apiFunction = new lambda.DockerImageFunction(this, "ApiFunction", {
      functionName: apiFunctionName,
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(repoRoot, "packages/img2mesh3d"),
        {
          file: "docker/api.Dockerfile",
          exclude: dockerAssetExcludes,
        }
      ),
      memorySize: apiMemorySize,
      timeout: Duration.seconds(apiTimeoutSeconds),
      ephemeralStorageSize: Size.gibibytes(2),
      environment: {
        IMG2MESH3D_QUEUE_URL: jobsQueue.queueUrl,
        IMG2MESH3D_DDB_TABLE: jobsTable.tableName,
        IMG2MESH3D_S3_BUCKET: dataBucket.bucketName,
        IMG2MESH3D_S3_PREFIX: s3Prefix,
        IMG2MESH3D_JOB_TTL_DAYS: jobTtlDays.toString(),
        IMG2MESH3D_CORS_ORIGINS: corsAllowOrigins,
        AUTH_JWT_REQUIRED: authRequired,
        AUTH_JWT_ISSUER: authIssuer,
        AUTH_JWT_AUDIENCE: authAudience,
        AUTH_JWT_JWKS_URL: authJwksUrl,
        AUTH_JWT_APP: authApp,
        AUTH_JWT_LEEWAY_SECONDS: authLeeway,
        ...optionalEnv,
        ...secretsEnv,
      },
    });

    const apiUrl = apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const apiUrlDomain = Fn.select(2, Fn.split("/", apiUrl.url));
    const apiOrigin = new origins.HttpOrigin(apiUrlDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(30),
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };

    uiDistribution.addBehavior("/api", apiOrigin, apiBehavior);
    uiDistribution.addBehavior("/api/*", apiOrigin, apiBehavior);

    if (hostedZoneId && !hostedZoneName) {
      throw new Error("HOSTED_ZONE_ID requires HOSTED_ZONE_NAME.");
    }

    if (appDomainName && (hostedZoneId || hostedZoneName)) {
      const hostedZone = hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
            hostedZoneId,
            zoneName: hostedZoneName || appDomainName,
          })
        : route53.HostedZone.fromLookup(this, "HostedZone", {
            domainName: hostedZoneName || appDomainName,
          });

      const recordName =
        hostedZoneName && appDomainName.endsWith(`.${hostedZoneName}`)
          ? appDomainName.slice(0, -(hostedZoneName.length + 1))
          : appDomainName;
      const recordNameValue =
        recordName && recordName.length > 0 ? recordName : undefined;
      const recordTarget = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(uiDistribution)
      );

      new route53.ARecord(this, "AppAliasRecordA", {
        zone: hostedZone,
        ...(recordNameValue ? { recordName: recordNameValue } : {}),
        target: recordTarget,
      });

      new route53.AaaaRecord(this, "AppAliasRecordAaaa", {
        zone: hostedZone,
        ...(recordNameValue ? { recordName: recordNameValue } : {}),
        target: recordTarget,
      });
    }

    const workerFunction = new lambda.DockerImageFunction(
      this,
      "WorkerFunction",
      {
        functionName: workerFunctionName,
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(repoRoot, "packages/img2mesh3d"),
          {
            file: "docker/worker.Dockerfile",
            exclude: dockerAssetExcludes,
          }
        ),
        memorySize: workerMemorySize,
        timeout: Duration.seconds(workerTimeoutSeconds),
        ephemeralStorageSize: Size.gibibytes(4),
        environment: {
          IMG2MESH3D_QUEUE_URL: jobsQueue.queueUrl,
          IMG2MESH3D_DDB_TABLE: jobsTable.tableName,
          IMG2MESH3D_S3_BUCKET: dataBucket.bucketName,
          IMG2MESH3D_S3_PREFIX: s3Prefix,
          IMG2MESH3D_JOB_TTL_DAYS: jobTtlDays.toString(),
          ...optionalEnv,
          ...secretsEnv,
        },
      }
    );

    workerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(jobsQueue, {
        batchSize: 1,
      })
    );

    dataBucket.grantReadWrite(apiFunction);
    dataBucket.grantReadWrite(workerFunction);
    jobsTable.grantReadWriteData(apiFunction);
    jobsTable.grantReadWriteData(workerFunction);
    jobsQueue.grantSendMessages(apiFunction);
    jobsQueue.grantConsumeMessages(workerFunction);

    if (adminTableName) {
      const adminTable = dynamodb.Table.fromTableName(
        this,
        "AdminSettingsTable",
        adminTableName
      );
      adminTable.grantReadData(apiFunction);
    }

    if (costTableName) {
      const costTable = dynamodb.Table.fromTableName(
        this,
        "AppCostTable",
        costTableName
      );
      costTable.grantReadWriteData(apiFunction);
    }

    const secretIds = [envSecretId, repoSecretId].filter(
      (value): value is string => Boolean(value && value.trim())
    );
    for (const [index, secretId] of Array.from(new Set(secretIds)).entries()) {
      const secret = secretsmanager.Secret.fromSecretNameV2(
        this,
        `AppSecrets${index}`,
        secretId
      );
      secret.grantRead(apiFunction);
      secret.grantRead(workerFunction);
    }

    new CfnOutput(this, "UiBucketName", { value: uiBucket.bucketName });
    new CfnOutput(this, "UiCloudFrontDomain", {
      value: uiDistribution.distributionDomainName,
    });
    new CfnOutput(this, "UiCloudFrontDistributionId", {
      value: uiDistribution.distributionId,
    });
    new CfnOutput(this, "ApiFunctionName", {
      value: apiFunction.functionName,
    });
    new CfnOutput(this, "WorkerFunctionName", {
      value: workerFunction.functionName,
    });
    new CfnOutput(this, "ApiFunctionUrl", { value: apiUrl.url });
    new CfnOutput(this, "ApiFunctionUrlDomain", {
      value: apiUrlDomain,
    });
    new CfnOutput(this, "ApiSqsQueueUrl", { value: jobsQueue.queueUrl });
    new CfnOutput(this, "ApiSqsDlqUrl", { value: jobsDlq.queueUrl });
    new CfnOutput(this, "ApiDynamoTable", { value: jobsTable.tableName });
    new CfnOutput(this, "ApiS3Bucket", { value: dataBucket.bucketName });
  }
}
