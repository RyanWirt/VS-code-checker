import * as vscode from 'vscode';
import { analyze, redact } from './client';
import { Config, loadInputs, SafeError, Selection, validateConfig } from './inputs';
import { createReport, proposeReport, renderReport } from './report';

const KEY = 'projectChecker.litellmApiKey';

export function activate(context: vscode.ExtensionContext): void {
  let selected: Selection[] = [];
  let running = false;
  const requireTrust = () => {
    if (vscode.env.remoteName !== undefined) { throw new SafeError('Remote extension environments are not supported. Use a local VS Code window.'); }
    if (!vscode.workspace.isTrusted) { throw new SafeError('A trusted local workspace is required.'); }
  };
  const guard = (action: () => Promise<void>) => async () => {
    try { requireTrust(); await action(); }
    catch (error) {
      // Never pass arbitrary exception messages, provider responses, paths, or contents to the UI.
      void vscode.window.showErrorMessage(error instanceof SafeError ? error.message : 'Project Checker failed safely. Check local permissions and configuration.');
    }
  };
  const configuration = (): Config => {
    const settings = vscode.workspace.getConfiguration('projectChecker');
    return validateConfig({
      baseUrl: settings.get<string>('baseUrl', 'https://localhost:4000/v1'),
      model: settings.get<string>('model', 'gpt-4o-mini'),
      maxFileSizeMB: settings.get<number>('maxFileSizeMB', 5),
      allowedExtensions: settings.get<string[]>('allowedExtensions', ['.md', '.txt', '.json', '.pdf', '.docx']),
      requestTimeoutSeconds: settings.get<number>('requestTimeoutSeconds', 120)
    });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('projectChecker.configureApiKey', guard(async () => {
      const key = await vscode.window.showInputBox({
        title: 'Store LiteLLM API key in VS Code SecretStorage',
        password: true, ignoreFocusOut: true,
        prompt: 'Stored only in SecretStorage. Leave blank to remove the existing key.',
        validateInput: value => value && (value.length > 4096 || /[\u0000-\u0020\u007f-\uffff]/u.test(value))
          ? 'Use a non-whitespace ASCII API key, at most 4096 characters.' : undefined
      });
      if (key === undefined) { return; }
      if (key) { await context.secrets.store(KEY, key); }
      else { await context.secrets.delete(KEY); }
      void vscode.window.showInformationMessage(key ? 'API key stored securely.' : 'Stored API key removed.');
    })),
    vscode.commands.registerCommand('projectChecker.selectInputs', guard(async () => {
      if (running) { throw new SafeError('Wait for the current analysis to finish.'); }
      const config = configuration();
      const next: Selection[] = [];
      for (const role of ['requirements', 'checklist', 'artifact'] as const) {
        const files = await vscode.window.showOpenDialog({
          title: `Select ${role} inputs${role === 'requirements' ? ' (required)' : ' (optional; Cancel to skip)'}`,
          canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
          filters: { 'Supported inputs': (role === 'checklist' ? ['.json'] : config.allowedExtensions).map(ext => ext.slice(1)) }
        });
        if (!files && role === 'requirements') { return; }
        if (files?.some(file => file.scheme !== 'file')) { throw new SafeError('Only local files are supported.'); }
        next.push(...(files ?? []).map(file => ({ path: file.fsPath, role })));
      }
      // Validate and extract without retaining document content between commands.
      await loadInputs(next, config);
      selected = next;
      void vscode.window.showInformationMessage(`${selected.length} inputs selected. Nothing has been transmitted.`);
    })),
    vscode.commands.registerCommand('projectChecker.runAnalysis', guard(async () => {
      if (running) { throw new SafeError('An analysis is already running.'); }
      if (!selected.length) { throw new SafeError('Use Select Analysis Inputs first.'); }
      running = true;
      try {
        const config = configuration();
        const key = await context.secrets.get(KEY);
        if (!key) { throw new SafeError('Use Configure API Key first.'); }
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        if (!folders.length) { throw new SafeError('Open a local workspace to choose a report location.'); }
        const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({
          placeHolder: 'Choose the workspace for the new report folder'
        });
        if (!folder || folder.uri.scheme !== 'file') { return; }
        const target = await proposeReport(folder.uri.fsPath);
        const inputs = await loadInputs(selected, config);
        const consent = await vscode.window.showWarningMessage(
          'Send these selected inputs to the configured analysis service?',
          {
            modal: true,
            detail: redact(`Endpoint: ${config.baseUrl}\nModel: ${config.model}\n` +
              inputs.map(input => `${input.id}: ${input.name} (${input.role})`).join('\n') +
              '\nExtracted contents will leave VS Code. Only proceed if authorized; provider retention policies apply.', key)
          }, 'Send selected inputs'
        );
        if (consent !== 'Send selected inputs') { return; }
        requireTrust();
        const analysis = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification, title: 'Analyzing selected inputs (read-only)', cancellable: true
        }, async (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() => controller.abort());
          try { return await analyze(inputs, config, key, controller.signal); }
          finally { subscription.dispose(); }
        });
        requireTrust();
        const report = renderReport(analysis, inputs, config, key);
        const output = await createReport(target, report, async directory =>
          await vscode.window.showWarningMessage(
            'Create this report folder and its single report.md?',
            {
              modal: true,
              detail: redact(`${directory}\n\nThe report includes model-generated descriptions, evidence, and selected filenames, which may disclose sensitive input information despite filtering. Approve only if you explicitly authorize including that information. Existing files will not be overwritten.`, key)
            }, 'Approve report content and path'
          ) === 'Approve report content and path'
        );
        if (output) {
          void vscode.window.showInformationMessage('Read-only analysis report created.');
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(output)), { preview: true });
        }
      } finally { running = false; }
    }))
  );
}

export function deactivate(): void {}
