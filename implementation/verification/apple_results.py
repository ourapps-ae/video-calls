"""Guarded schema-0.5.0 single-run target coverage; fixtures are not execution evidence."""
from collections.abc import Mapping
import json
import math
import os
from pathlib import Path
import selectors
import subprocess
import time

MAX_OUTPUT = 8 * 1024 * 1024
MAX_NODES = 100000
MAX_DEPTH = 64
BUNDLE_TYPES = {'Unit test bundle', 'UI test bundle'}
NODE_TYPES = BUNDLE_TYPES | {'Test Plan', 'Test Suite', 'Test Case', 'Device', 'Test Plan Configuration',
                            'Arguments', 'Repetition', 'Test Case Run', 'Failure Message', 'Source Code Reference',
                            'Attachment', 'Expression', 'Test Value', 'Runtime Warning', 'Skip Message', 'Expected Failure'}
UNSUPPORTED = {'Arguments', 'Repetition', 'Test Case Run'}
DIAGNOSTICS = {'Failure Message', 'Source Code Reference', 'Attachment', 'Expression', 'Test Value',
               'Runtime Warning', 'Skip Message', 'Expected Failure'}
STATUSES = {'Passed': 'passed', 'Failed': 'failed', 'Skipped': 'skipped', 'Expected Failure': 'expectedFailures'}
SUMMARY_FIELDS = {'discovered': 'totalTestCount', 'passed': 'passedTests', 'failed': 'failedTests',
                  'skipped': 'skippedTests', 'expectedFailures': 'expectedFailures'}


def validate_expected_targets(value):
    if not isinstance(value, Mapping) or not 1 <= len(value) <= 32:
        raise ValueError('context-invalid')
    result = {}
    for name, kind in value.items():
        if not isinstance(name, str) or not 1 <= len(name) <= 128 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name):
            raise ValueError('context-invalid')
        if name in result or not isinstance(kind, str) or kind not in BUNDLE_TYPES:
            raise ValueError('context-invalid')
        result[name] = kind
    return dict(sorted(result.items()))


def parse_apple_results(summary, tests, expected_targets):
    expected = validate_expected_targets(expected_targets)
    if not isinstance(summary, dict) or not isinstance(tests, dict):
        raise ValueError('result-invalid')
    totals = {}
    for field in SUMMARY_FIELDS.values():
        value = summary.get(field)
        if type(value) is not int or not 0 <= value <= 2147483647:
            raise ValueError('result-invalid')
        totals[field] = value
    if summary.get('result') != 'Passed':
        raise ValueError('assertion-failed')
    if any(not isinstance(tests.get(field), list) for field in ['testPlanConfigurations', 'devices', 'testNodes']):
        raise ValueError('result-invalid')
    if len(tests['testPlanConfigurations']) > 1 or len(tests['devices']) > 1:
        raise ValueError('result-invalid')
    targets = {}
    identities = {}
    stack = [(node, None, False, 1) for node in reversed(tests['testNodes'])]
    visited = 0
    while stack:
        node, target, in_case, depth = stack.pop()
        visited += 1
        if visited > MAX_NODES or depth > MAX_DEPTH or not isinstance(node, dict):
            raise ValueError('result-invalid')
        kind, name = node.get('nodeType'), node.get('name')
        if not isinstance(kind, str) or kind not in NODE_TYPES or not isinstance(name, str):
            raise ValueError('result-invalid')
        children = node.get('children', [])
        if not isinstance(children, list):
            raise ValueError('result-invalid')
        if 'result' in node and (not isinstance(node['result'], str) or node['result'] not in {*STATUSES, 'unknown'}):
            raise ValueError('result-invalid')
        if kind in UNSUPPORTED or in_case and kind not in DIAGNOSTICS:
            raise ValueError('result-invalid')
        if kind in BUNDLE_TYPES:
            if target is not None or in_case or name not in expected or expected[name] != kind or name in targets:
                raise ValueError('assertion-failed')
            target = name
            targets[name] = dict(name=name, bundleType=kind, passed=0, failed=0, skipped=0, expectedFailures=0)
            identities[name] = set()
        elif kind == 'Test Case':
            if target is None or in_case:
                raise ValueError('result-invalid')
            for field in ['nodeIdentifierURL', 'nodeIdentifier']:
                if field in node and not isinstance(node[field], str):
                    raise ValueError('result-invalid')
            identity = node.get('nodeIdentifierURL') or node.get('nodeIdentifier')
            status = node.get('result')
            if not isinstance(identity, str) or not identity or status not in STATUSES:
                raise ValueError('result-invalid')
            if identity in identities[target]:
                raise ValueError('assertion-failed')
            identities[target].add(identity)
            targets[target][STATUSES[status]] += 1
            in_case = True
        stack.extend((child, target, in_case, depth + 1) for child in reversed(children))
    if set(targets) != set(expected):
        raise ValueError('assertion-failed')
    for target in targets.values():
        target['discovered'] = sum(target[key] for key in ['passed', 'failed', 'skipped', 'expectedFailures'])
        target['executed'] = target['passed'] + target['failed'] + target['expectedFailures']
    actual = {field: sum(target[key] for target in targets.values()) for key, field in SUMMARY_FIELDS.items()}
    if actual != totals:
        raise ValueError('assertion-failed')
    if any(target['discovered'] <= 0 or target['executed'] <= 0 or target['failed'] or target['expectedFailures'] for target in targets.values()):
        raise ValueError('assertion-failed')
    return {'schemaVersion': '0.5.0', 'targets': [targets[name] for name in sorted(targets)],
            'discovered': totals['totalTestCount'], 'executed': sum(target['executed'] for target in targets.values()),
            'failed': totals['failedTests']}


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('result-invalid')
        result[key] = value
    return result


def strict_document(data):
    def invalid(_value):
        raise ValueError('result-invalid')
    try:
        result = json.loads(data.decode('utf-8'), object_pairs_hook=_object, parse_constant=invalid)
        stack = [result]
        while stack:
            value = stack.pop()
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError('result-invalid')
            if isinstance(value, dict):
                stack.extend(value.values())
            elif isinstance(value, list):
                stack.extend(value)
        return result
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ValueError('result-invalid') from None


def capture_query(argv, *, env, timeout, max_bytes):
    deadline = time.monotonic() + timeout
    try:
        child = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        raise ValueError('process-failed') from None
    output = bytearray()
    used = 0
    try:
        with selectors.DefaultSelector() as selector:
            for stream in [child.stdout, child.stderr]:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError('timeout')
                for key, _ in selector.select(min(remaining, 0.1)):
                    data = os.read(key.fileobj.fileno(), min(65536, max_bytes - used + 1))
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    used += len(data)
                    if used > max_bytes:
                        raise ValueError('output-limit')
                    if key.fileobj is child.stdout:
                        output.extend(data)
            if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                raise ValueError('process-failed')
        return bytes(output), used
    except subprocess.TimeoutExpired:
        raise ValueError('timeout') from None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()


def extract_apple_results(bundle, expected_targets, *, env, deadline, query=None, clock=None):
    expected = validate_expected_targets(expected_targets)
    query = query or capture_query
    clock = clock or time.monotonic
    extraction_deadline = min(deadline, clock() + 30)
    remaining_bytes = MAX_OUTPUT
    documents = {}
    for kind in ['summary', 'tests']:
        remaining = extraction_deadline - clock()
        if remaining <= 0:
            raise ValueError('timeout')
        if remaining_bytes <= 0:
            raise ValueError('output-limit')
        data, used = query(['xcrun', 'xcresulttool', 'get', 'test-results', kind, '--schema-version', '0.5.0',
                            '--path', str(Path(bundle)), '--compact'], env=env, timeout=remaining, max_bytes=remaining_bytes)
        if clock() >= extraction_deadline:
            raise ValueError('timeout')
        if not isinstance(data, bytes) or type(used) is not int or used < len(data) or used > remaining_bytes:
            raise ValueError('output-limit')
        remaining_bytes -= used
        documents[kind] = strict_document(data)
    result = parse_apple_results(documents['summary'], documents['tests'], expected)
    if clock() >= extraction_deadline:
        raise ValueError('timeout')
    return result
