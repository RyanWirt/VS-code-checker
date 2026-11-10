import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Analysis, redact, SEVERITIES } from './client';
import { assertNoSymlinks, Config, Input, SafeError, validatePath } from './inputs';

function markdown(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~:\-]/gu, '\\$&');
}

export function renderReport(analysis: Analysis, inputs: Input[], config: Config, apiKey: string): string {
  const m = (value: string) => markdown(redact(value, apiKey));
  const lines = [
    '# Read-only analysis report', '',
    '## 1. Analysis summary and scope', '',
    m(analysis.summary), '',
    'Only explicitly selected inputs were analyzed. No workspace discovery or code execution occurred.',
    'Model assessments (including “confirmed”) are not independently verified; human review is required.', '',
    '## 2. Input files analyzed', '',
    ...inputs.map(input => `- ${m(input.id)} — ${m(input.name)} (${input.role})`), '',
    '## 3. Model and configuration', '',
    `- Model: ${m(config.model)}`,
    '- Endpoint: user-configured LiteLLM-compatible service (URL omitted for privacy)',
    `- Maximum file size: ${config.maxFileSizeMB} MiB`,
    `- Timeout: ${config.requestTimeoutSeconds} seconds`,
    `- Allowed extensions: ${config.allowedExtensions.map(m).join(', ')}`,
    '- Credentials: VS Code SecretStorage; excluded from report',
    '- Telemetry: not implemented', '',
    '## 4. Findings summary by severity', '',
    '| Severity | Count |', '| --- | --- |',
    ...SEVERITIES.map(severity => `| ${severity} | ${analysis.findings.filter(f => f.severity === severity).length} |`),
    '', '## 5. Detailed findings', ''
  ];
  if (!analysis.findings.length) { lines.push('No findings reported. This does not establish compliance.', ''); }
  for (const finding of analysis.findings) {
    lines.push(
      `### ${m(finding.id)} — ${finding.severity}`, '',
      `- Status: ${finding.status === 'confirmed' ? 'Model-confirmed (not independently verified)' : 'Requires human review'}`,
      `- Requirement/checklist reference: ${m(finding.reference)}`,
      `- Input reference: ${finding.inputId ? m(finding.inputId) : 'Not available'}${finding.line ? `, line ${finding.line}` : ''}`,
      `- Confidence: ${finding.confidence}`,
      `- Description: ${m(finding.description)}`,
      `- Evidence/rationale: ${m(finding.evidence)}`,
      `- Descriptive remediation: ${m(finding.remediation)}`, ''
    );
  }
  lines.push('## 6. Assumptions, limitations, and unresolved questions', '');
  for (const [heading, values] of [
    ['Assumptions', analysis.assumptions], ['Model limitations', analysis.limitations],
    ['Unresolved questions', analysis.questions]
  ] as const) {
    lines.push(`### ${heading}`, '', ...(values.length ? values.map(value => `- ${m(value)}`) : ['- None reported.']), '');
  }
  lines.push(
    '### Extraction and analysis limitations', '',
    '- PDF extraction is text-only (no OCR); DOCX extraction includes main document text only.',
    '- Images, attachments, macros, links, headers, footers, and unselected files are not followed or analyzed.',
    '- Prompt injection is mitigated by instructions and lack of tools, not eliminated.',
    '- The user explicitly approved storing model-derived text, which may contain sensitive input information.',
    '', '## 7. Workspace safety statement', '',
    'No existing workspace files were modified by this extension. Only this newly created report directory and report.md were written.',
    ''
  );
  // Escape after redaction as well, so keys containing Markdown punctuation cannot evade removal.
  const report = redact(lines.join('\n'), apiKey);
  return apiKey ? report.split(markdown(apiKey)).join('[REDACTED]') : report;
}

export interface ReportTarget { root: string; directory: string; rootDevice: number; rootInode: number }

export async function proposeReport(root: string): Promise<ReportTarget> {
  await assertNoSymlinks(root);
  const canonical = await fs.realpath(root);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) { throw new SafeError('Output workspace must be a local directory.'); }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return {
    root: canonical,
    directory: path.join(canonical, `.analysis-report-${stamp}-${randomUUID()}`),
    rootDevice: stat.dev, rootInode: stat.ino
  };
}

export async function createReport(
  target: ReportTarget, content: string, confirm: (directory: string) => Promise<boolean>
): Promise<string | undefined> {
  validatePath(target.directory);
  if (path.dirname(target.directory) !== target.root ||
      !/^\.analysis-report-\d{4}-\d\d-\d\dT[\d-]+Z-[a-f0-9-]{36}$/u.test(path.basename(target.directory))) {
    throw new SafeError('Invalid report output path.');
  }
  if (!await confirm(target.directory)) { return undefined; }
  await assertNoSymlinks(target.root);
  const root = await fs.lstat(target.root);
  if (!root.isDirectory() || root.dev !== target.rootDevice || root.ino !== target.rootInode) {
    throw new SafeError('Output workspace changed. Run analysis again.');
  }
  // Never reuse a directory or overwrite a file, even after an interrupted run.
  await fs.mkdir(target.directory, { mode: 0o700 });
  const directory = await fs.lstat(target.directory);
  await assertNoSymlinks(target.directory);
  const reportPath = path.join(target.directory, 'report.md');
  const handle = await fs.open(reportPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const current = await fs.lstat(target.directory);
    if (!current.isDirectory() || current.ino !== directory.ino || current.dev !== directory.dev) {
      throw new SafeError('Output directory changed. Report writing was stopped.');
    }
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  return reportPath;
}
