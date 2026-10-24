import { build } from 'electron-builder';
import * as packageFiles from 'node:fs/promises';
import { nativeHelperBeforeSigning } from './package-helper.mjs';
import { distributionPlan, writePackagedUpdatePolicy, collectDistribution } from './distribution.mjs';
const manifestURL = new URL('../package.json', import.meta.url);
const contents = await packageFiles.readFile(manifestURL, 'utf8');
const metadata = JSON.parse(contents);
const plan = distributionPlan(process.env, metadata.version);
for (const f of ['../.build/release/rushcore-engine', '../.build/release/rushes']) await packageFiles.access(f);
const prepareHelper = nativeHelperBeforeSigning(plan.config);
plan.config.afterPack = async context => {
  await prepareHelper(context);
  await writePackagedUpdatePolicy(context, plan);
};
const artifacts = await build({ mac: plan.targets, publish: 'never', config: plan.config });
console.log(JSON.stringify(await collectDistribution(artifacts, plan)));
