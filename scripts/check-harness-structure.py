#!/usr/bin/env python3
"""scripts/check-harness-structure.py — repo-owned structural self-check for the harness.

The weekly CI job runs this instead of anything on a maintainer workstation:
a harness that can only be validated from outside the repo is phantom enforcement.

Checks (each fails the run, exit 1; missing inputs are exit 2):
  1. No unresolved {{UPPER_SNAKE}} placeholders in harness artifacts.
  2. Every path named in the AGENTS.md Enforcement Index exists.
  3. AGENTS.md / CONTEXT.md word counts stay under the doc_budgets ceilings
     declared in constraints.yaml.
  4. Verification Matrix commands resolve to package.json scripts.
  5. constraints.yaml baseline counts mirror .baseline/findings.json counts.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ["AGENTS.md", "CONTEXT.md", "constraints.yaml", ".github/workflows/ci.yml",
             ".github/workflows/harness-maintenance.yml", "knip.json", "jscpd.json",
             ".oxlintrc.gate.json"]
PLACEHOLDER = re.compile(r"\{\{[A-Z0-9_]+\}\}")
errors: list[str] = []


def check_placeholders() -> None:
    for name in ARTIFACTS:
        p = ROOT / name
        if not p.exists():
            errors.append(f"missing harness artifact: {name}")
            continue
        for m in PLACEHOLDER.finditer(p.read_text(encoding="utf-8", errors="replace")):
            errors.append(f"unresolved placeholder {m.group(0)} in {name}")


def agents_text() -> str:
    return (ROOT / "AGENTS.md").read_text(encoding="utf-8")


def check_index_paths() -> None:
    section = re.search(r"(?ms)^## Enforcement Index\s*$\n(.*?)(?=^##\s|\Z)", agents_text())
    if not section:
        errors.append("AGENTS.md missing ## Enforcement Index")
        return
    for row in section.group(1).splitlines():
        if not row.strip().startswith("|") or "---" in row:
            continue
        cells = [c.strip() for c in row.strip("|").split("|")]
        if len(cells) < 4:
            continue
        level = cells[3].lower()
        if "block" not in level and "gate" not in level:
            continue
        for token in re.findall(r"`([^`]+)`", " ".join(cells[1:3])):
            token = token.strip()
            # path-like tokens only: contains a slash or is a known root file name
            looks_path = "/" in token or re.fullmatch(r"[\w.-]+\.(json|yaml|yml|md|ts|mjs|sh|lock)", token)
            if not looks_path or " " in token or token.startswith(("http", "*")) or ".github/workflows/ci.yml" == token:
                continue
            if any(ch in token for ch in "$<"):
                continue
            candidate = ROOT / token
            if not candidate.exists() and not (ROOT / token.split("/")[0]).exists():
                errors.append(f"Enforcement Index path does not exist: {token}")


def check_budgets() -> None:
    text = (ROOT / "constraints.yaml").read_text(encoding="utf-8")
    block = re.search(r"(?ms)^doc_budgets:\n(.*?)(?=^[A-Za-z0-9_-]+:|\Z)", text)
    if not block:
        errors.append("constraints.yaml missing doc_budgets")
        return
    current = None
    ceilings: dict[str, int] = {}
    for line in block.group(1).splitlines():
        m = re.match(r"^  ([\w./-]+):\s*$", line)
        if m:
            current = m.group(1)
            continue
        m = re.match(r"^    ceiling:\s*(\d+)", line)
        if m and current:
            ceilings[current] = int(m.group(1))
    for name, ceiling in ceilings.items():
        p = ROOT / name
        if p.exists():
            words = len(p.read_text(encoding="utf-8").split())
            if words > ceiling:
                errors.append(f"{name}: {words} words exceeds ceiling {ceiling}")


def check_matrix_commands() -> None:
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = set(pkg.get("scripts", {}))
    matrix = re.search(r"(?ms)^## Verification Matrix\s*$\n(.*?)(?=^##\s|\Z)", agents_text())
    if not matrix:
        errors.append("AGENTS.md missing ## Verification Matrix")
        return
    for cmd in re.findall(r"`(npm run ([\w:.-]+)(?: [^`]*)?)`", matrix.group(1)):
        if cmd[1] not in scripts:
            errors.append(f"Verification Matrix command not in package.json scripts: npm run {cmd[1]}")
    for line in matrix.group(1).splitlines():
        for cmd in re.findall(r"`(bun run ([\w:.-]+))(?: [^`]*)?`", line):
            if cmd[1] not in scripts:
                errors.append(f"AGENTS.md references missing script: bun run {cmd[1]}")


def check_baseline_mirror() -> None:
    constraints = (ROOT / "constraints.yaml").read_text(encoding="utf-8")
    findings_p = ROOT / ".baseline" / "findings.json"
    if not findings_p.exists():
        errors.append(".baseline/findings.json missing — run `bun run baseline:record` (record is local, CI never records)")
        return
    findings = json.loads(findings_p.read_text(encoding="utf-8"))
    counts_block = re.search(r"(?m)^  counts:[^\n]*\n((?: {4}\S.*\n)*)", constraints)
    if not counts_block:
        errors.append("constraints.yaml baseline.counts missing")
        return
    yaml_counts = dict(re.findall(r"^    (\w+): (\d+)", counts_block.group(1), re.M))
    for lane, val in (findings.get("counts") or {}).items():
        if lane not in yaml_counts:
            errors.append(f"baseline lane {lane} not mirrored in constraints.yaml")
        elif int(yaml_counts[lane]) != val:
            errors.append(f"baseline drift: {lane} constraints.yaml={yaml_counts[lane]} findings.json={val}")


def main() -> int:
    for fn in (check_placeholders, check_index_paths, check_budgets, check_matrix_commands, check_baseline_mirror):
        try:
            fn()
        except FileNotFoundError as e:  # missing harness input is a usage error
            print(f"usage error: {e}", file=sys.stderr)
            return 2
    if errors:
        print("check-harness-structure: FAIL")
        for e in errors:
            print(f"  {e}")
        return 1
    print(f"check-harness-structure: PASS — {len(ARTIFACTS)} artifacts, placeholders/paths/budgets/matrix/baseline-mirror conform")
    return 0


if __name__ == "__main__":
    sys.exit(main())
