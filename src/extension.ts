import * as vscode from 'vscode';
import { analyze, redact } from './client';
import { Config, expandFolder, loadInputs, SafeError, Selection, validateConfig } from './inputs';
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
      requestTimeoutSeconds: settings.get<number>('requestTimeoutSeconds', 120),
      caCertPath: settings.get<string>('caCertPath', '') || undefined
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
    }))
  );
  const selectInputs = async (): Promise<boolean> => {
      if (running) { throw new SafeError('Wait for the current analysis to finish.'); }
      const config = configuration();
      const next: Selection[] = [];
      const requirements = await vscode.window.showOpenDialog({
        title: 'Step 1 of 2: Select requirements files',
        canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
        filters: { 'Supported inputs': config.allowedExtensions.map(ext => ext.slice(1)) }
      });
      if (!requirements) { return false; }
      const mode = await vscode.window.showQuickPick(
        ['Select code files', 'Select a project folder', 'Skip (requirements only)'],
        { title: 'Step 2 of 2: What should be checked against the requirements?', ignoreFocusOut: true }
      );
      if (!mode) { return false; }
      let code: vscode.Uri[] | undefined = [];
      if (mode === 'Select code files') {
        code = await vscode.window.showOpenDialog({
          title: 'Step 2 of 2: Select code files',
          canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
          filters: { 'Supported inputs': config.allowedExtensions.map(ext => ext.slice(1)) }
        });
        if (!code) { return false; }
      } else if (mode === 'Select a project folder') {
        code = await vscode.window.showOpenDialog({
          title: 'Step 2 of 2: Select the project folder',
          canSelectMany: false, canSelectFiles: false, canSelectFolders: true
        });
        if (!code) { return false; }
      }
      if ([...requirements, ...code].some(file => file.scheme !== 'file')) { throw new SafeError('Only local files are supported.'); }
      next.push(...requirements.map(file => ({ path: file.fsPath, role: 'requirements' as const })));
      if (mode === 'Select a project folder') { next.push(...await expandFolder(code[0].fsPath, config)); }
      else { next.push(...code.map(file => ({ path: file.fsPath, role: 'artifact' as const }))); }
      // Validate and extract without retaining document content between commands.
      await loadInputs(next, config);
      selected = next;
      void vscode.window.showInformationMessage(`${selected.length} inputs selected. Nothing has been transmitted.`);
      return true;
  };
  const runAnalysis = async (): Promise<void> => {
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
          `Send ${inputs.length} file${inputs.length === 1 ? '' : 's'} for analysis?`,
          {
            modal: true,
            detail: redact(`Endpoint: ${config.baseUrl}\nModel: ${config.model}\n\n` +
              inputs.slice(0, 20).map(input => `\u2022 ${input.name} (${input.role})`).join('\n') +
              (inputs.length > 20 ? `\n...and ${inputs.length - 20} more` : '') +
              '\n\nExtracted text will be sent to this service. Only continue if you are authorized to share it.', key)
          }, 'Send'
        );
        if (consent !== 'Send') { return; }
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
            'Save the report?',
            {
              modal: true,
              detail: redact(`A new folder with one report.md will be created:\n${directory}\n\nThe report contains model-generated findings and file names, which may reveal sensitive details from your inputs. Nothing existing is overwritten.`, key)
            }, 'Save report'
          ) === 'Save report'
        );
        if (output) {
          void vscode.window.showInformationMessage('Read-only analysis report created.');
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(output)), { preview: true });
        }
      } finally { running = false; }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('projectChecker.selectInputs', guard(async () => { await selectInputs(); })),
    vscode.commands.registerCommand('projectChecker.runAnalysis', guard(runAnalysis)),
    vscode.commands.registerCommand('projectChecker.analyze', guard(async () => {
      if (await selectInputs()) { await runAnalysis(); }
    }))
  );
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBar.text = '$(checklist) Project Checker';
  statusBar.tooltip = 'Select inputs and run a read-only analysis';
  statusBar.command = 'projectChecker.analyze';
  statusBar.show();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('projectChecker.panel', {
    getTreeItem: item => item,
    getChildren: () => []
  }));
}

export function deactivate(): void {}
