const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { loadInputs, validatePath, validateConfig, MAX_TEXT_BYTES } = require('../dist/inputs');
const { analyze, parseAnalysis, redact } = require('../dist/client');
const { proposeReport, createReport, renderReport } = require('../dist/report');

const config = {
  baseUrl: 'http://127.0.0.1:4000/v1', model: 'mock-model', maxFileSizeMB: 5,
  allowedExtensions: ['.md', '.txt', '.json', '.pdf', '.docx'], requestTimeoutSeconds: 2
};
const input = { id: 'input-1', name: 'requirements.md', role: 'requirements', content: 'Use secure storage.\nDo not edit files.' };
const analysis = {
  summary: 'Selected inputs reviewed.',
  findings: [{
    id: 'F-001', severity: 'Low', status: 'human-review', reference: 'REQ-1',
    inputId: 'input-1', line: 1, description: 'Verify storage.',
    evidence: 'Implementation is not included.', remediation: 'Ensure secure storage is in place.',
    confidence: 'Low'
  }],
  assumptions: [], limitations: ['Only selected inputs reviewed.'], questions: []
};

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checker-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    instance.closeAllConnections();
    instance.close(resolve);
  }));
  return `http://127.0.0.1:${instance.address().port}/v1`;
}

function respond(response, value = analysis, extra = {}) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value), ...extra } }]
  }));
}

test('configuration rejects unsafe endpoints and unbounded settings', () => {
  for (const baseUrl of [
    'file:///tmp/x', 'http://example.com/v1', 'http://localhost:4000/v1',
    new URL('/v1', 'https://example.com').href.replace('https://', 'https://' + ['user', 'pass'].join(':') + '@'),
    'https://example.com?token=private', 'https://example.com/#fragment'
  ]) {
    assert.throws(() => validateConfig({ ...config, baseUrl }));
  }
  for (const value of [
    { maxFileSizeMB: Infinity }, { requestTimeoutSeconds: 0 },
    { allowedExtensions: ['../txt'] }, { model: '\n' }
  ]) { assert.throws(() => validateConfig({ ...config, ...value })); }
  assert.equal(validateConfig(config).baseUrl, config.baseUrl);
});

test('path traversal, relative paths and NUL bytes are rejected', () => {
  for (const value of ['/tmp/../secret', '/tmp/..\\secret', 'relative.md', '/tmp/a\0.md']) {
    assert.throws(() => validatePath(value));
  }
});

test('only selected supported regular UTF-8 files are read; invalid inputs fail closed', async t => {
  const root = await temporary(t);
  const requirements = path.join(root, 'requirements.md');
  await fs.writeFile(requirements, input.content);
  const selection = [{ path: requirements, role: 'requirements' }];
  assert.equal((await loadInputs(selection, config))[0].content, input.content);
  await assert.rejects(loadInputs([...selection, ...selection], config), /Duplicate/);
  const unsupported = path.join(root, 'script.exe');
  await fs.writeFile(unsupported, 'not executed');
  await assert.rejects(loadInputs([{ path: unsupported, role: 'requirements' }], config), /Unsupported/);
  const binary = path.join(root, 'binary.txt');
  await fs.writeFile(binary, Buffer.from([255, 0]));
  await assert.rejects(loadInputs([{ path: binary, role: 'requirements' }], config), /UTF-8/);
  const json = path.join(root, 'checklist.json');
  await fs.writeFile(json, '{"items":');
  await assert.rejects(loadInputs([...selection, { path: json, role: 'checklist' }], config), /JSON/);
  await fs.writeFile(json, '{"items":[]}');
  assert.deepEqual((await loadInputs([...selection, { path: json, role: 'checklist' }], config))[1].content, { items: [] });
  const custom = path.join(root, 'artifact.custom');
  await fs.writeFile(custom, 'custom text');
  const customSelection = [...selection, { path: custom, role: 'artifact' }];
  await assert.rejects(loadInputs(customSelection, config), /Unsupported/);
  assert.equal((await loadInputs(customSelection, {
    ...config, allowedExtensions: [...config.allowedExtensions, '.custom']
  }))[1].content, 'custom text');
  await assert.rejects(loadInputs([{ path: requirements, role: 'checklist' }], config));
  await fs.writeFile(requirements, 'x'.repeat(12_000));
  await assert.rejects(loadInputs(selection, { ...config, maxFileSizeMB: 0.01 }), /size limit/);
  await fs.writeFile(requirements, 'x'.repeat(MAX_TEXT_BYTES + 1));
  await assert.rejects(loadInputs(selection, config), /extracted/);
  await fs.writeFile(requirements, ' \n');
  await assert.rejects(loadInputs(selection, config), /extractable text/);
});

test('symlink, symlink ancestor, hardlink, and directory inputs are rejected', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'file.md');
  await fs.writeFile(file, 'original');
  const sym = path.join(root, 'link.md');
  await fs.symlink(file, sym);
  await assert.rejects(loadInputs([{ path: sym, role: 'requirements' }], config), /Symbolic/);
  const dirLink = path.join(root, 'linked');
  await fs.symlink(root, dirLink);
  await assert.rejects(loadInputs([{ path: path.join(dirLink, 'file.md'), role: 'requirements' }], config), /Symbolic/);
  const hard = path.join(root, 'hard.md');
  await fs.link(file, hard);
  await assert.rejects(loadInputs([{ path: hard, role: 'requirements' }], config), /regular files/);
  const directory = path.join(root, 'folder.md');
  await fs.mkdir(directory);
  await assert.rejects(loadInputs([{ path: directory, role: 'requirements' }], config), /regular files/);
});

test('PDF and DOCX reject malformed documents without exposing parser diagnostics', async t => {
  const root = await temporary(t);
  for (const ext of ['pdf', 'docx']) {
    const file = path.join(root, `bad.${ext}`);
    await fs.writeFile(file, 'not a valid document');
    await assert.rejects(loadInputs([{ path: file, role: 'requirements' }], config), /extraction/);
  }
});

test('strict finding schema rejects extra fields, invalid enums, references and line numbers', () => {
  assert.deepEqual(parseAnalysis(analysis, [input]), analysis);
  for (const change of [
    { severity: 'unknown' }, { confidence: 'certain' }, { status: 'verified' },
    { inputId: '../private' }, { line: 0 }, { line: 100 }, { line: 1, inputId: null },
    { patch: 'execute' }, { id: '<script>' }
  ]) {
    assert.throws(() => parseAnalysis({ ...analysis, findings: [{ ...analysis.findings[0], ...change }] }, [input]));
  }
  assert.throws(() => parseAnalysis({ ...analysis, execute: true }, [input]));
  assert.throws(() => parseAnalysis({ ...analysis, findings: [analysis.findings[0], analysis.findings[0]] }, [input]));
});

test('report confirmation precedes writes; exactly one new folder and report are created', async t => {
  const root = await temporary(t);
  const existing = path.join(root, 'existing.txt');
  await fs.writeFile(existing, 'preserve exactly');
  const before = await fs.stat(existing);
  const declined = await proposeReport(root);
  assert.equal(await createReport(declined, 'ignored', async proposed => {
    assert.equal(proposed, declined.directory);
    await assert.rejects(fs.stat(proposed), { code: 'ENOENT' });
    return false;
  }), undefined);
  assert.deepEqual(await fs.readdir(root), ['existing.txt']);
  const target = await proposeReport(root);
  const output = await createReport(target, 'report content', async () => true);
  assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(target.directory), 'existing.txt'].sort());
  assert.deepEqual(await fs.readdir(target.directory), ['report.md']);
  assert.equal(await fs.readFile(output, 'utf8'), 'report content');
  assert.equal(await fs.readFile(existing, 'utf8'), 'preserve exactly');
  const after = await fs.stat(existing);
  assert.equal(after.mtimeMs, before.mtimeMs);
  await assert.rejects(createReport(target, 'overwrite', async () => true), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output, 'utf8'), 'report content');
  await assert.rejects(createReport({ ...target, directory: path.join(root, '../escape') }, 'x', async () => true));
});

test('report output refuses symlinks, existing directories, and replaced workspace roots', async t => {
  const root = await temporary(t);
  const target = await proposeReport(root);
  await fs.symlink(root, target.directory);
  await assert.rejects(createReport(target, 'x', async () => true), { code: 'EEXIST' });
  await assert.rejects(proposeReport(target.directory), /Symbolic/);
  const changed = await proposeReport(root);
  await assert.rejects(createReport({ ...changed, rootInode: -1 }, 'x', async () => true), /changed/);
});

test('report escapes active Markdown/HTML and excludes raw inputs, endpoint, and API key', () => {
  const key = randomUUID() + '"\\';
  const unsafe = { ...analysis, summary: `<script>alert(1)</script> [click](command:danger) ${key} ${encodeURIComponent(key)} ${Buffer.from(key).toString('base64')}` };
  const report = renderReport(unsafe, [input], { ...config, model: key }, key);
  assert.ok(report.includes('&lt;script&gt;'));
  assert.ok(!report.includes('[click](command:danger)'));
  assert.ok(!report.includes(input.content));
  assert.ok(!report.includes(config.baseUrl));
  for (const value of [key, encodeURIComponent(key), Buffer.from(key).toString('base64')]) {
    assert.ok(!report.includes(value));
  }
  for (let section = 1; section <= 7; section++) { assert.ok(report.includes(`## ${section}.`)); }
  assert.ok(report.includes('No existing workspace files were modified'));
  assert.equal(redact(JSON.stringify({ value: key }), key).includes(JSON.stringify(key).slice(1, -1)), false);
});

test('LiteLLM request is structured, carries the key only in authorization, and emits no logs', async t => {
  const key = randomUUID();
  const logs = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args));
  }
  let requests = 0;
  const baseUrl = await server(t, async (request, response) => {
    requests++;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, ['Bearer', key].join(' '));
    let raw = '';
    for await (const chunk of request) { raw += chunk; }
    assert.ok(!raw.includes(key));
    const body = JSON.parse(raw);
    assert.equal(body.model, config.model);
    assert.equal(body.messages[0].role, 'system');
    assert.ok(body.messages[0].content.includes('untrusted data'));
    assert.equal(body.messages[1].role, 'user');
    assert.ok(!body.tools);
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    const supplied = JSON.parse(body.messages[1].content).inputs[0];
    assert.deepEqual(Object.keys(supplied), ['id', 'role', 'content']);
    assert.ok(supplied.content.includes('[REDACTED]'));
    respond(response, { ...analysis, summary: key });
  });
  const result = await analyze([{ ...input, content: input.content + key }], { ...config, baseUrl }, key);
  assert.equal(result.summary, '[REDACTED]');
  assert.equal(requests, 1);
  assert.deepEqual(logs, []);
});

test('server errors, malformed replies, tool calls, redirects, oversized replies and timeouts are safe', async t => {
  const key = randomUUID();
  for (const mode of ['error', 'malformed', 'tools', 'redirect', 'oversized', 'timeout']) {
    await t.test(mode, async sub => {
      let requests = 0;
      const baseUrl = await server(sub, (request, response) => {
        requests++;
        if (mode === 'error') { response.writeHead(401); response.end(key); }
        else if (mode === 'malformed') { response.end(key); }
        else if (mode === 'tools') { respond(response, analysis, { tool_calls: [{}] }); }
        else if (mode === 'redirect') { response.writeHead(302, { Location: '/leak' }); response.end(); }
        else if (mode === 'oversized') { response.end('x'.repeat(1024 * 1024 + 1)); }
        // Timeout deliberately leaves the request unanswered.
      });
      await assert.rejects(analyze([input], { ...config, baseUrl, requestTimeoutSeconds: 1 }, key), error => {
        assert.ok(!error.message.includes(key));
        return true;
      });
      assert.equal(requests, 1);
    });
  }
});

test('user cancellation aborts the API request', async t => {
  const baseUrl = await server(t, () => {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(analyze([input], { ...config, baseUrl }, randomUUID(), controller.signal), /cancelled/);
});

test('redaction preserves structured JSON with backslash keys and schema-name keys', async t => {
  for (const key of ['\\dummy', 'summary']) {
    await t.test(key === 'summary' ? 'schema word' : 'escaped characters', async sub => {
      const baseUrl = await server(sub, async (request, response) => {
        let raw = '';
        for await (const chunk of request) { raw += chunk; }
        const body = JSON.parse(raw);
        const document = JSON.parse(body.messages[1].content).inputs[0];
        assert.deepEqual(Object.keys(document), ['id', 'role', 'content']);
        assert.deepEqual(document.content, { '[REDACTED]': '[REDACTED]' });
        respond(response, {
          ...analysis, summary: key,
          findings: [{ ...analysis.findings[0], line: null }]
        });
      });
      const result = await analyze([{ ...input, content: { [key]: key } }], { ...config, baseUrl }, key);
      assert.equal(result.summary, '[REDACTED]');
    });
  }
});
