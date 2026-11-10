// Exercise the actual extension commands with only the VS Code UI/storage boundary mocked.
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function main() {
  const [baseUrl, root, ...artifacts] = process.argv.slice(2);
  const samples = path.resolve(__dirname, '../samples');
  const key = randomUUID();
  const secrets = new Map();
  const commands = new Map();
  const errors = [];
  const confirmations = [];
  const toUri = file => ({ scheme: 'file', fsPath: file });
  const samplePaths = [path.join(samples, 'requirements.md'), path.join(samples, 'asta-checklist.json')];
  const originals = await Promise.all(samplePaths.map(file => fs.readFile(file)));
  const existing = path.join(root, 'existing.txt');
  await fs.writeFile(existing, 'unchanged');
  let picker = 0;
  let opened;
  const vscode = {
    env: {},
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: toUri(root) }],
      getConfiguration: () => ({ get: (name, fallback) => ({ baseUrl, model: 'mock-model' })[name] ?? fallback }),
      openTextDocument: async uri => { opened = uri.fsPath; return uri; }
    },
    Uri: { file: toUri },
    ProgressLocation: { Notification: 15 },
    window: {
      showInputBox: async options => { assert.equal(options.password, true); return key; },
      showOpenDialog: async () => {
        if (picker < 2) { return [toUri(samplePaths[picker++])]; }
        return artifacts.length ? artifacts.map(toUri) : undefined;
      },
      showErrorMessage: message => errors.push(message),
      showInformationMessage() {},
      showWarningMessage: async (message, options, choice) => {
        assert.equal(options.modal, true);
        assert.ok(!options.detail.includes(key));
        confirmations.push({ message, detail: options.detail });
        if (confirmations.length === 2) {
          assert.deepEqual(await fs.readdir(root), ['existing.txt']);
        }
        return choice;
      },
      withProgress: async (_options, callback) => callback({}, {
        onCancellationRequested: () => ({ dispose() {} })
      }),
      showTextDocument: async () => {}
    }
  };
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args);
  };
  try {
    require('../dist/extension').activate({
      subscriptions: [],
      secrets: {
        store: async (name, value) => secrets.set(name, value),
        get: async name => secrets.get(name),
        delete: async name => secrets.delete(name)
      }
    });
  } finally { Module._load = originalLoad; }
  await commands.get('projectChecker.configureApiKey')();
  assert.equal(secrets.size, 1);
  await commands.get('projectChecker.selectInputs')();
  await commands.get('projectChecker.runAnalysis')();
  assert.deepEqual(errors, []);
  assert.equal(confirmations.length, 2);
  const created = (await fs.readdir(root)).filter(name => name !== 'existing.txt');
  assert.equal(created.length, 1);
  const outputDir = path.join(root, created[0]);
  assert.ok(confirmations[1].detail.includes(outputDir));
  assert.deepEqual(await fs.readdir(outputDir), ['report.md']);
  assert.equal(opened, path.join(outputDir, 'report.md'));
  const report = await fs.readFile(opened, 'utf8');
  assert.ok(report.includes('F\\-001'));
  assert.ok(!report.includes(key));
  assert.ok(report.includes('No existing workspace files were modified'));
  assert.equal(await fs.readFile(existing, 'utf8'), 'unchanged');
  for (let i = 0; i < samplePaths.length; i++) {
    assert.deepEqual(await fs.readFile(samplePaths[i]), originals[i]);
  }
  vscode.env.remoteName = 'ssh-remote';
  for (const command of commands.values()) { await command(); }
  assert.equal(errors.length, 3);
  assert.ok(errors.every(error => error.includes('Remote extension environments')));
  assert.equal(confirmations.length, 2);
  assert.equal(secrets.size, 1);
  assert.deepEqual(await fs.readdir(outputDir), ['report.md']);
  console.log('Extension command flow verified: secure key, selected inputs, API request, consent, single report, unchanged originals.');
}
main().catch(() => {
  console.error('Mock verification failed (sensitive diagnostics suppressed).');
  process.exitCode = 1;
});
