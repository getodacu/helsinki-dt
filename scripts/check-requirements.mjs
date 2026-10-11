import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  return result.error || result.status !== 0 ? null : (result.stdout + result.stderr).trim();
}

const errors = [];
if (Number(process.versions.node.split('.')[0]) !== 24) {
  errors.push(`Node 24 is required; found ${process.versions.node}. Run nvm install && nvm use, or install Node 24.`);
}
const npmVersion = process.env.npm_config_user_agent?.match(/\bnpm\/(\d+(?:\.\d+)*)/)?.[1] ?? output('npm', ['--version']);
if (!npmVersion || !(Number(npmVersion.split('.')[0]) >= 11)) {
  errors.push(`npm 11+ is required; found ${npmVersion ?? 'no usable npm on PATH'}. Install npm 11 with Node 24.`);
}

const command = process.env.npm_lifecycle_event;
const sourceIndex = process.argv.indexOf('--source');
const source = sourceIndex === -1 ? 'all' : process.argv[sourceIndex + 1];
if (!command || command === 'data:prepare'
  || command === 'data:probe' && ['all', 'geometry', 'energy'].includes(source)) {
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
  const version = output(java, ['-version']);
  const major = version?.match(/\b(?:openjdk|java)(?: version)?\s+"?(\d+)/)?.[1];
  if (!major || Number(major) < 17) {
    errors.push(`Java 17+ is required for CityGML conversion. Install a JDK 17 or newer and set JAVA_HOME to its installation directory, or put java on PATH.${process.env.JAVA_HOME ? ` JAVA_HOME is currently ${process.env.JAVA_HOME}.` : ''}`);
  }
  if (!output('unzip', ['-v'])) {
    errors.push('unzip is required to extract citygml-tools. Install unzip and make it available on PATH.');
  }
}

if (errors.length) {
  console.error('Requirements not met:\n- ' + errors.join('\n- ') + '\nSee README.md, First run.');
  process.exit(1);
}
