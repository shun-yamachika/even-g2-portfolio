#!/usr/bin/env python3
"""Check the source snapshot without printing matched secret values."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', 'node_modules', 'dist', 'dist-text', 'var', '__pycache__'}
PATTERNS = {
    'API key or access token': r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|tskey-[A-Za-z0-9_-]{15,})',
    'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'personal home directory': r'/(?:home|Users)/[A-Za-z0-9_.-]+/',
    'Tailscale host outside the example domain': r'https?://(?![A-Za-z0-9.-]*\.example\.ts\.net\b)[A-Za-z0-9.-]+\.ts\.net\b',
    'Tailscale IP': r'\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(?:\.\d{1,3}){2}\b',
    'URL with credentials': r'https?://[^\s/"\']+:[^\s/@"\']+@',
    'nonempty literal credential': r'''(?im)^\s*(?:(?:export|const|let)\s+)?["']?(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD))["']?\s*[:=]\s*["']?[A-Za-z0-9_+/.=-]{12,}''',
}

issues = []
files = 0
for path in sorted(ROOT.rglob('*')):
    rel = path.relative_to(ROOT)
    if any(part in SKIP for part in rel.parts):
        continue
    if path.is_symlink():
        issues.append(f'{rel}: symbolic link')
        continue
    if not path.is_file():
        continue
    name = path.name
    env_example = name == '.env.example' or (name.startswith('.env.') and name.endswith('.example'))
    if (any(part in {'.aws', '.ssh', '.codex', '.agents', 'logs'} for part in rel.parts)
        or (name.startswith('.env') and not env_example)
        or name.endswith(('~', '.bak', '.swp', '.swo', '.ehpk', '.log', '.pem', '.key', '.zip'))
        or name in {'.npmrc', 'credentials', 'credentials.json'}):
        issues.append(f'{rel}: private or generated file')
        continue
    try:
        body = path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        issues.append(f'{rel}: binary file needs manual review')
        continue
    files += 1
    for label, pattern in PATTERNS.items():
        for match in re.finditer(pattern, body):
            line = body.count('\n', 0, match.start()) + 1
            issues.append(f'{rel}:{line}: {label}')

if issues:
    print('\n'.join(issues))
    sys.exit(1)
print(f'PASS: {files} source/config/documentation files checked. No matches in configured checks.')
