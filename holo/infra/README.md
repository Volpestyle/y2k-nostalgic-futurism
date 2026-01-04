# Y2K Lounge infra notes

The CDK stack in `infra/` provisions the UI bucket/CloudFront distribution and
API/worker Lambdas. When `APP_DOMAIN_NAME` + `APP_CERT_ARN` are set, the
CloudFront distribution serves `https://y2k.jcvolpe.me` and forwards `/api`
and `/api/*` to the API Function URL origin.

## Certificate + DNS expectations

- ACM cert must be in `us-east-1` for CloudFront.
- The cert must live in the same AWS account as the CloudFront distribution.
- A wildcard `*.jcvolpe.me` certificate is valid for `y2k.jcvolpe.me`.
- Route53 hosted zone should contain an A/AAAA alias for
  `y2k.jcvolpe.me` pointing at the CloudFront distribution.

## CDK behavior

The stack configures:

- CloudFront custom domain + certificate when `APP_DOMAIN_NAME` and
  `APP_CERT_ARN` are provided.
- `/api` and `/api/*` behaviors that forward to the Lambda Function URL origin.
- CloudFront OAC for the UI bucket (private S3 origin).
- Route53 alias records (`A` + `AAAA`) when `HOSTED_ZONE_NAME` or
  `HOSTED_ZONE_ID` is provided.
- An SQS dead-letter queue for failed reconstruction jobs.

## Suggested inputs

Use env vars (or CDK context) so deploy workflows can supply domain settings:

- `APP_DOMAIN_NAME=y2k.jcvolpe.me`
- `APP_CERT_ARN=<acm-arn-in-us-east-1>`
- `HOSTED_ZONE_NAME=jcvolpe.me` (or `HOSTED_ZONE_ID=<zone-id>`)

## Shared admin/cost/rate limit config

To keep admin settings, cost tracking, and rate limiting unified across
`jcvolpe.me` and its subdomains, deploy with the same shared resources used by
the portfolio stack:

- `ADMIN_TABLE_NAME=<portfolio-admin-table>` (AdminData table)
- `COST_TABLE_NAME=<portfolio-cost-table>` (ChatRuntimeCost table)
- `UPSTASH_REDIS_REST_URL=<shared-redis-url>`
- `UPSTASH_REDIS_REST_TOKEN=<shared-redis-token>`
- `COST_APP_ID=y2k`
- `RATE_LIMIT_APP_ID=y2k`

Optional (if you want non-default behavior):

- `RATE_LIMIT_PREFIX=chat:ratelimit` (shared prefix)
- `APP_ENV=prod` (controls cost tracking partition key)
