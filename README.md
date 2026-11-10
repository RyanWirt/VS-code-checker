# Read-only Project Checker

A TypeScript Visual Studio Code extension for analyzing explicitly selected requirements, ASTA checklist JSON, and project artifacts with a LiteLLM-compatible service. The model has **no tools, terminal, code execution, or file-editing capability**. No workspace crawling occurs.

## Prerequisites and build

- VS Code **1.110+**, with a trusted, local filesystem workspace.
- Node.js **22.13+** and npm; Python **3.10+** for the optional mock verification.
- A LiteLLM-compatible `/chat/completions` endpoint supporting `response_format: {"type":"json_object"}`.

From the checkout:

```sh
npm ci
npm run compile
npm test
npm run verify:mock
```

Tests use Node's built-in test runner. No test framework or Python packages are needed. There is no separate linter. `verify:mock` runs a loopback Python server and invokes the **actual extension commands** with a mocked VS Code UI/SecretStorage boundary. It validates authorization and structured request format, extracts real tiny PDF/DOCX fixtures, approves the output path, and verifies a single report and unchanged original files. All verification outputs and fixtures are temporary and outside the checkout. This does not substitute for testing the real VS Code host and operating-system credential store.

## Launch the Extension Development Host

1. Open this checkout in VS Code and run `npm run compile`.
2. Press **F5**, selecting **Run Project Checker**. No build task runs automatically; recompile after source changes.
3. In the new Extension Development Host window, open a trusted local project.
4. Open the Command Palette and run the commands below.

Remote/virtual workspaces, symlink-based workspace paths, and untrusted workspaces are unsupported. No browser extension entry point is supplied.

## Configure the service and key

In **User Settings**, configure:

| Setting | Default | Description |
| --- | --- | --- |
| `projectChecker.baseUrl` | `https://localhost:4000/v1` | Base URL; `/chat/completions` is appended. Use the provider's actual base path. |
| `projectChecker.model` | `gpt-4o-mini` | LiteLLM model/deployment name. |
| `projectChecker.maxFileSizeMB` | `5` | Per-file limit, up to 20 MiB. |
| `projectChecker.allowedExtensions` | `.md`, `.txt`, `.json`, `.pdf`, `.docx` | Additional extensions are parsed only as UTF-8 text. |
| `projectChecker.requestTimeoutSeconds` | `120` | Network timeout including response reading, from 1 to 600 seconds. |

Settings are application-scoped so checked-in workspace settings cannot silently redirect the endpoint. HTTPS is required; **numeric loopback** HTTP (`127.0.0.1` or `[::1]`) is allowed for local development. Plain HTTP `localhost`, URL credentials, query strings, and fragments are rejected. Do not put credentials in any setting or URL; use a normally trusted TLS certificate and never disable TLS verification.

Run **Project Checker: Configure API Key**. The password input is stored only through VS Code's `SecretStorage`, not settings, files, environment variables, or logs. Submit an empty value to remove it. In a remote extension host, storage and transmission would occur remotely; this starter intentionally supports local workspaces only.

### Try the local mock

```sh
python3 scripts/mock_litellm.py
```

Set the base URL to `http://127.0.0.1:4000/v1`, the model to `mock-model`, and enter any **dummy** key via the secure key command. Do not reuse a production key. Keep the mock bound to loopback; it has no production authentication or TLS. It emits deterministic human-review findings and is not an actual analysis service.

## Run an analysis

1. Run **Project Checker: Select Analysis Inputs**.
2. Select at least one requirements document; select optional checklist JSON, then optional artifacts. Cancel at an optional picker to skip it. The first picker's cancellation leaves the previous selection unchanged.
3. Files are locally validated and extracted. Only paths are held between commands; inputs are reread and revalidated for each analysis. No persistent input cache is created.
4. Run **Project Checker: Run Read-only Analysis**. For multi-root workspaces, choose the output workspace.
5. Inspect the endpoint, model, input names and roles in the transmission confirmation. Approve only if you are authorized to send these contents to that provider.
6. After analysis, inspect and approve the **exact proposed report directory**. Approval explicitly authorizes saving model-generated findings and selected filenames, which may contain sensitive input information. Declining creates no report.
7. The extension creates one new directory, `.analysis-report-<UTC timestamp>-<random UUID>/`, directly inside the approved workspace, with exactly one file, **`report.md`**. This direct-child layout avoids creating any additional parent directory. Existing folders are never reused; files are never overwritten.

`samples/requirements.md` and `samples/asta-checklist.json` are minimal examples. There is no mandatory ASTA schema: checklist inputs must be valid JSON objects/arrays and are sent as parsed structured data. Supply your organization's authoritative checklist and requirements.

The report contains summary/scope, selected input names and roles, non-secret model/configuration metadata, severity counts, detailed findings, assumptions/limitations/questions, and the workspace safety statement. Findings include ID, severity, model-confirmed versus human-review status, requirement reference, input ID and optional original text line, rationale, descriptive remediation, and confidence. PDF/DOCX line numbers are omitted. An opaque input ID maps to the filename in the report; absolute input paths are not transmitted.

## Security and data handling

- **Read-only inputs:** only user-selected regular files are opened, in read-only mode. There is no globbing, recursive scanning, terminal invocation, subprocess command, patch application, or model tool dispatcher in extension code. Parser workers run trusted local extraction code, never document scripts or macros.
- **Restricted writes:** only a new report directory and exclusively created `report.md` are written. Creation uses restrictive permissions (`0700` directory, `0600` file where supported), no recursive mkdir, and no overwrite flags. No automatic cleanup deletes files. A disk/permission error or interruption can leave an empty directory or partial report; a later run always proposes a fresh directory.
- **Path checks:** absolute local paths only; traversal components, symbolic-link path components, hardlinked inputs, special files and duplicate inputs are rejected. Output paths are generated internally, constrained to one direct child, confirmed, and revalidated before writing. File descriptors and inode/device checks reduce substitution races. Windows ACLs and case/filesystem behavior still apply.
- **Resource limits:** 30 inputs, 20 MiB total raw input, 2 MiB total extracted UTF-8 text, 200 PDF pages, 1 MiB API response, and no automatic API retries. PDF/DOCX workers have a 15-second deadline and V8 heap limits. DOCX accepts at most 1,000 ZIP entries, with bounded declared expanded sizes and streamed XML bytes. These limits are safeguards, not a full native-memory sandbox.
- **Extraction limitations:** PDF is text-only, without OCR. DOCX includes `word/document.xml` text only, not headers/footers or attached files. Images, links, embedded objects, encrypted documents, macros, and external relationships are not followed. Malformed or oversized inputs fail closed. Custom formats must be plain UTF-8, not arbitrary binaries. Scanned/empty PDFs can yield little or no usable evidence.
- **Credentials:** the key is attached only to the API authorization header. Exact, JSON-escaped, URL-encoded and base64 forms are filtered from request content and report text as defense in depth. Never include credentials in selected inputs. Filtering cannot discover every secret or transformed fragment in a document.
- **Network trust:** the configured endpoint receives selected extracted content and must be trusted. Redirects are rejected. There are no provider-error-body dialogs, document logs, or telemetry. The extension cannot control provider logs, retention, subprocesses internal to a provider, proxy behavior, or downstream model policies. Review your provider's privacy/retention terms before use.
- **Untrusted model output:** strict bounded JSON is validated locally; unknown fields, tool calls, invalid references, and incomplete replies are rejected. Dynamic Markdown/HTML syntax is escaped. Prompt-injection instructions in documents are treated as data, and the model has no actions. This does not guarantee truthful findings, confidentiality of all paraphrases, or compliance with descriptive-remediation instructions. Independently review every finding. “Model-confirmed” is not a security certification.
- **Report privacy:** raw input bodies are not copied wholesale into reports, and endpoint URLs are omitted. Model-generated descriptions can still reveal sensitive information. A separate explicit report-content/path approval is required; don't approve if such disclosure is prohibited. Reports stay on disk until you remove them and are not automatically excluded from your project's version control: add `.analysis-report-*/` to your own ignore rules.
- **Threat boundary:** this is not an OS sandbox against a malicious local process concurrently renaming directories or altering selected files. Portable Node filesystem APIs cannot atomically lock the complete directory tree. Use a private, trusted workspace not writable by adversaries; avoid running against adversarial documents without an additional OS sandbox. The extension never intentionally modifies existing content and uses exclusive creation, but cannot promise protection against compromised VS Code, OS, dependencies, storage hardware, or concurrent hostile filesystem changes. Reads can update filesystem access timestamps.

Cancel during the API request to abort it. Cancelling or closing either consent dialog fails closed. Documents are extracted locally before transmission consent, not sent anywhere until approved. Selections are reset on extension reload. There is no persistent analysis history or telemetry toggle because no telemetry is implemented.

## Packaging and deployment

```sh
npm ci
npm test
npm run verify:mock
npm audit
npm run package
```

`npm run package` uses the pinned `@vscode/vsce` development dependency and runs the TypeScript prepublish build. The default script builds a **Linux x64** VSIX on Linux x64; it is not a universal package, because the PDF dependency includes a native canvas library. It creates a `.vsix`, excluded from git. Install through **Extensions → … → Install from VSIX…**, or:

```sh
code --install-extension read-only-project-checker-linux-x64-0.1.0.vsix
```

For other platforms, run `npm ci` and `npm exec -- vsce package --target <target>` on the matching OS/architecture (for example `win32-x64`, `darwin-arm64`, or `linux-arm64`). Verify PDF extraction there before deployment. Do not copy a Linux `node_modules` tree to another platform or publish a platform-native dependency as a universal VSIX.

Before Marketplace publishing, use your own registered publisher identity in `package.json`, review licensing and bundled dependencies, test on each target OS/VS Code version, verify the host's credential storage, and perform an independent security review. Keep publishing credentials outside the checkout. Development sources, tests, sample inputs, and the Python mock are excluded from the VSIX; runtime parsers and compiled JavaScript are included. No service credentials are bundled.