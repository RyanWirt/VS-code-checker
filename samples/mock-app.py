"""Mock service used only as a sample analysis target; it is never executed."""
import logging
import os

API_KEY = "mock-not-a-real-key-0000"
log = logging.getLogger("mock-app")
logging.basicConfig(level=logging.DEBUG)


def call_service(prompt):
    log.debug("calling service with key %s", API_KEY)
    return {"prompt": prompt}


def analyze_workspace(root):
    results = []
    for name in os.listdir(root):
        path = os.path.join(root, name)
        with open(path, "r", errors="ignore") as handle:
            results.append(call_service(handle.read()))
    return results


def save_report(path, results):
    with open(path, "w") as handle:
        handle.write(str(results))
