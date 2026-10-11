import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const checker = join(root, 'scripts/check-requirements.mjs');

function fixture(operation: (directory: string, bin: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'helsinki-requirements-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  try { operation(directory, bin); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function tool(bin: string, name: string, output: string, status = 0) {
  writeFileSync(join(bin, name), `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(output)}); process.exit(${status});\n`, { mode: 0o755 });
}

function check(bin: string, command = 'data:prepare', args: string[] = [], environment: NodeJS.ProcessEnv = {}, nodeVersion = '24.0.0') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} }); process.argv = [process.execPath, 'fixture.ts', ...${JSON.stringify(args)}]; await import(${JSON.stringify(checker)});`], {
    encoding: 'utf8', env: { ...process.env, PATH: bin, JAVA_HOME: '', NODE_OPTIONS: '',
      npm_config_user_agent: 'npm/11.17.0 node/v24.0.0', npm_lifecycle_event: command, ...environment }, timeout: 10_000
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('npm geometry commands fail before downloads or cache writes when Java is missing', () => {
  fixture((directory, bin) => {
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync('/bin/sh', join(bin, 'sh'));
    symlinkSync(join(root, 'scripts'), join(directory, 'scripts'));
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: pkg.scripts }));
    const blocker = join(directory, 'block-network.mjs');
    writeFileSync(blocker, "globalThis.fetch = () => { throw new Error('Unexpected download before prerequisite validation'); };\n");
    const npm = process.env.npm_execpath ?? spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(npm, 'npm must be installed to exercise the npm commands');
    for (const args of [['data:prepare'], ['data:probe'], ['data:probe', '--', '--source', 'geometry'], ['data:probe', '--', '--source', 'energy']]) {
      const result = spawnSync(process.execPath, [npm, 'run', ...args], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: bin, JAVA_HOME: '', NODE_OPTIONS: `--import=${blocker}`, npm_config_cache: join(directory, 'npm-cache') }, timeout: 10_000
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Java 17\+/);
      assert.match(result.stderr, /JAVA_HOME/);
      assert.equal(existsSync(join(directory, '.cache')), false);
    }
  });
});

test('Java 17+ on PATH or in JAVA_HOME and unzip satisfy geometry requirements', () => {
  fixture((directory, bin) => {
    tool(bin, 'java', 'openjdk version "17.0.12"');
    tool(bin, 'unzip', 'UnZip 6.00');
    assert.equal(check(bin).status, 0);
    const home = join(directory, 'jdk with spaces');
    mkdirSync(join(home, 'bin'), { recursive: true });
    tool(join(home, 'bin'), 'java', 'java version "26.0.2.1"');
    tool(bin, 'java', 'java version "1.8.0_412"');
    assert.equal(check(bin, 'data:prepare', [], { JAVA_HOME: home }).status, 0);
    assert.match(check(bin).output, /Java 17\+/);
    assert.match(check(bin, 'data:prepare', [], { JAVA_HOME: join(directory, 'missing') }).output, /JAVA_HOME/);
  });
});

test('missing unzip and unusable Java are rejected with actionable diagnostics', () => {
  fixture((_directory, bin) => {
    tool(bin, 'java', 'openjdk version "21.0.1"');
    const missingUnzip = check(bin);
    assert.equal(missingUnzip.status, 1);
    assert.match(missingUnzip.output, /unzip/);
    tool(bin, 'unzip', 'UnZip 6.00');
    tool(bin, 'java', 'cannot start JVM', 1);
    assert.equal(check(bin).status, 1);
    tool(bin, 'java', 'unrecognised Java version');
    assert.equal(check(bin).status, 1);
  });
});

test('geometry prerequisites follow probe source selection and are absent from other commands', () => {
  fixture((_directory, bin) => {
    for (const source of ['all', 'geometry', 'energy']) {
      assert.equal(check(bin, 'data:probe', ['--source', source]).status, 1, source);
    }
    assert.equal(check(bin, 'data:probe').status, 1);
    for (const source of ['transit', 'observations']) {
      assert.equal(check(bin, 'data:probe', ['--source', source]).status, 0, source);
    }
    for (const command of ['start', 'build', 'test', 'city:prepare', 'energy:prepare']) {
      assert.equal(check(bin, command).status, 0, command);
    }
  });
});

test('npm commands reject unsupported Node and npm versions before starting', () => {
  fixture((_directory, bin) => {
    for (const nodeVersion of ['22.20.0', '26.0.0']) {
      const result = check(bin, 'start', [], {}, nodeVersion);
      assert.equal(result.status, 1);
      assert.match(result.output, /Node 24/);
    }
    const result = check(bin, 'start', [], { npm_config_user_agent: 'npm/10.9.0 node/v24.0.0' });
    assert.equal(result.status, 1);
    assert.match(result.output, /npm 11/);
  });
});
