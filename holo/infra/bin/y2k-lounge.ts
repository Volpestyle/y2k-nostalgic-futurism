#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Y2kLoungeStack } from "../lib/y2k-lounge-stack";

const app = new cdk.App();

new Y2kLoungeStack(app, "Y2kLoungeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
});
