#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { environmentSchema, featureEnvironmentSchema, projectConfigSchema } from '@flowstacks/core';
import { ProjectStack } from './project-stack.js';

const root = resolve(import.meta.dirname, '../..');
const config = projectConfigSchema.parse(JSON.parse(readFileSync(join(root, 'flowstacks.json'), 'utf8')));
const environment = environmentSchema.parse(process.env.ENVIRONMENT ?? 'staging');
const feature = featureEnvironmentSchema.safeParse(environment).success;
if (feature ? !config.featureEnvironments : !config.environments.includes(environment)) throw new Error(`${environment} is not enabled in flowstacks.json`);
const app = new App();
new ProjectStack(app, `${config.tenantId}-${config.projectId}-${environment}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION },
  config,
  environmentName: environment,
  rootDirectory: root,
});
