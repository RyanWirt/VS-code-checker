#!/usr/bin/env python3
"""Loopback-only LiteLLM mock and command-flow verification; standard library only."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import zipfile


class Handler(BaseHTTPRequestHandler):
    verified_requests = 0
    verify_artifacts = False

    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            assert self.path == "/v1/chat/completions"
            authorization = self.headers.get("Authorization", "")
            scheme, credential = authorization.split(" ", 1)
            assert scheme == "Bearer" and credential
            length = int(self.headers.get("Content-Length", "0"))
            assert 0 < length <= 3 * 1024 * 1024
            raw = self.rfile.read(length).decode("utf-8")
            assert credential not in raw
            body = json.loads(raw)
            assert body["model"] == "mock-model"
            assert body["stream"] is False
            assert body["response_format"] == {"type": "json_object"}
            assert "tools" not in body and "functions" not in body
            assert body["messages"][0]["role"] == "system"
            assert body["messages"][1]["role"] == "user"
            inputs = json.loads(body["messages"][1]["content"])["inputs"]
            assert any(item["role"] == "requirements" for item in inputs)
            assert all(set(item) == {"id", "role", "content"} for item in inputs)
            checklist = next((item for item in inputs if item["role"] == "checklist"), None)
            if checklist:
                assert isinstance(checklist["content"], (dict, list))
            if Handler.verify_artifacts:
                artifacts = [item["content"] for item in inputs if item["role"] == "artifact"]
                assert any("Sample PDF requirement" in text for text in artifacts)
                assert any("Sample DOCX requirement" in text for text in artifacts)
                assert any("Strict DOCX requirement" in text for text in artifacts)
            finding = {
                "id": "F-001", "severity": "Informational", "status": "human-review",
                "reference": "REQ-001", "inputId": inputs[0]["id"], "line": None,
                "description": "Verify credential handling in the implementation.",
                "evidence": "Selected requirements alone do not establish implementation compliance.",
                "remediation": "Ensure credentials are securely stored and excluded from logs.",
                "confidence": "High",
            }
            result = {
                "summary": "Mock analysis of explicitly selected inputs.",
                "findings": [finding], "assumptions": [],
                "limitations": ["This is a deterministic mock, not a real compliance assessment."],
                "questions": ["Has the implementation been independently reviewed?"],
            }
            payload = json.dumps({
                "choices": [{"finish_reason": "stop", "message": {
                    "role": "assistant", "content": json.dumps(result)
                }}]
            }).encode()
            Handler.verified_requests += 1
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Request validation failed.")


def create_document_fixtures(directory):
    """Create tiny text-only documents for extraction verification, outside the checkout."""
    root = Path(directory)
    docx = root / "artifact.docx"
    with zipfile.ZipFile(docx, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>Sample DOCX requirement</w:t></w:r></w:p></w:body></w:document>",
        )
    strict_docx = root / "strict-artifact.docx"
    with zipfile.ZipFile(strict_docx, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main">'
            "<w:body><w:p><w:r><w:t>Strict DOCX requirement</w:t></w:r></w:p></w:body></w:document>",
        )
    stream = b"BT /F1 12 Tf 72 720 Td (Sample PDF requirement) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, content in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode() + content + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    pdf_path = root / "artifact.pdf"
    pdf_path.write_bytes(pdf)
    return [str(pdf_path), str(docx), str(strict_docx)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Run the real extension commands with a mocked VS Code boundary.")
    parser.add_argument("--port", type=int, default=4000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0 if args.verify else args.port), Handler)
    server.daemon_threads = True
    if not args.verify:
        print(f"Mock listening on http://127.0.0.1:{server.server_port}/v1; use model mock-model and a dummy key.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    Handler.verify_artifacts = True
    root = Path(__file__).resolve().parents[1]
    try:
        with (tempfile.TemporaryDirectory(prefix="checker-mock-") as directory,
              tempfile.TemporaryDirectory(prefix="checker-inputs-") as fixtures):
            artifacts = create_document_fixtures(fixtures)
            subprocess.run(
                ["node", str(root / "test" / "mock-flow.cjs"),
                 f"http://127.0.0.1:{server.server_port}/v1", str(Path(directory).resolve()),
                 *artifacts],
                cwd=root, check=True, timeout=30,
            )
        assert Handler.verified_requests == 1
        print("LiteLLM-compatible request format and end-to-end report generation verified.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
