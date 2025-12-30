#!/usr/bin/env bash
set -euo pipefail

# Deploy CloudFormation stack for img2mesh3d resources.
# Usage:
#   bash scripts/bootstrap_aws_cfn.sh my-stack-name us-east-1

STACK_NAME="${1:-img2mesh3d}"
REGION="${2:-us-east-1}"

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file infra/cloudformation.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION"

echo "Stack deployed. Fetch outputs with:"
echo "aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs'"
