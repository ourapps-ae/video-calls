"""Shared package-owned native checks and run-owned simulator cleanup."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import xml.etree.ElementTree as ET
from collections.abc import Mapping
from urllib.parse import urlsplit

_results_spec = importlib.util.spec_from_file_location('media_apple_results', Path(__file__).with_name('apple_results.py'))
if _results_spec is None or _results_spec.loader is None:
    raise RuntimeError('result-invalid')
apple_results = importlib.util.module_from_spec(_results_spec)
_results_spec.loader.exec_module(apple_results)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def read_context():
    context = json.loads(Path(os.environ['AEPM_CONTEXT_FILE']).read_text())
    if context.get('format') != 1 or not re.fullmatch('[a-f0-9]{64}', context.get('runId', '')):
        raise ValueError('context-invalid')
    return context


def write_document(path, value, exclusive=False):
    path = Path(path)
    temporary = path if exclusive else path.with_name(path.name + '.pending')
    with temporary.open('xb') as stream:
        os.chmod(temporary, 0o600)
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        temporary.replace(path)


def write_result(result):
    write_document(os.environ['AEPM_RESULT_FILE'], result)


def write_cleanup_result(result):
    write_document(os.environ['AEPM_CLEANUP_RESULT_FILE'], result)


def require(context, operations):
    if context['mode'] != 'local' or not set(operations).issubset(context['operations']):
        raise ValueError('authorization-denied')


def resources(context):
    return {item['id']: Path(item['path']) for item in context['resources']}


def android_sdk(context):
    if 'androidSdk' not in resources(context):
        raise ValueError('resource-missing')
    working = Path(os.environ['AEPM_CONTEXT_FILE']).parent / 'android-sdk-working'
    if not working.is_dir():
        raise ValueError('resource-missing')
    return working


def environment(context):
    env = dict(os.environ)
    inputs = resources(context)
    if 'appleDeveloperDirectory' in inputs:
        env['DEVELOPER_DIR'] = str(inputs['appleDeveloperDirectory'])
        env['USER'] = 'builder'
    if 'androidSdk' in inputs:
        env['ANDROID_HOME'] = str(android_sdk(context))
        env['ANDROID_SDK_ROOT'] = str(android_sdk(context))
    if 'androidJavaHome' in inputs:
        env['JAVA_HOME'] = str(inputs['androidJavaHome'])
        env['PATH'] = str(inputs['androidJavaHome'] / 'bin') + os.pathsep + env['PATH']
    env['GRADLE_USER_HOME'] = str(Path(os.environ['AEPM_CONTEXT_FILE']).parent / 'gradle-working')
    return env


def run(context, argv, cwd=None, timeout=120, capture=False):
    return subprocess.run([str(item) for item in argv], cwd=cwd, env=environment(context),
                          check=True, timeout=min(timeout, context['settings'].get('maximumSeconds', 900)),
                          capture_output=capture, text=capture)


def apple_set(context):
    return Path(os.environ['AEPM_CONTEXT_FILE']).parent / 'profiles/apple' / context['runId']


def apple_environment(context):
    env = environment(context)
    env['SIMULATOR_DEVICE_SET_PATH'] = str(apple_set(context))
    env['CORE_SIMULATOR_DEVICE_SET_PATH'] = str(apple_set(context))
    return env


def ownership(context):
    directory = Path(os.environ['AEPM_OWNERSHIP_DIRECTORY'])
    result = []
    for path in sorted(directory.glob('intent-*.json')):
        intent = json.loads(path.read_text())
        if any(intent[key] != context[key] for key in ['runId', 'package', 'id']) or intent['namespace'] != context['runId']:
            raise ValueError('result-invalid')
        created_path = directory / f"created-{intent['counter']}.json"
        created = json.loads(created_path.read_text()) if created_path.exists() else None
        if created and any(created[key] != value for key, value in intent.items()):
            raise ValueError('result-invalid')
        result.append((intent, created))
    return result


def prepare_apple(context, *, project, scheme, derived_data, package_cache):
    require(context, ['create-temporary-simulator', 'native-test'])
    if context['settings']['applePlatform'] not in ['ios-simulator', 'tvos-simulator']:
        raise ValueError('context-invalid')
    if not Path(project).is_dir() or not (Path(derived_data) / 'Build/Products').is_dir():
        raise ValueError('assertion-failed')
    private_set = apple_set(context)
    private_set.parent.mkdir(parents=True, exist_ok=True)
    private_set.mkdir()
    requested = 'device-' + context['runId'] + '-0'
    intent = dict(format=1, runId=context['runId'], package=context['package'], id=context['id'], counter=0,
                  kind='apple-device', requestedId=requested, namespace=context['runId'])
    directory = Path(os.environ['AEPM_OWNERSHIP_DIRECTORY'])
    write_document(directory / 'intent-0.json', intent, True)
    result = run(context, ['xcrun', 'simctl', '--set', private_set, 'create', requested,
                          context['settings']['appleDeviceType'], context['settings']['appleRuntime']], timeout=60, capture=True)
    identifier = result.stdout.strip()
    if not re.fullmatch('[A-Fa-f0-9-]{36}', identifier):
        raise ValueError('result-invalid')
    write_document(directory / 'created-0.json', {**intent, 'resourceId': identifier}, True)
    run(context, ['xcrun', 'simctl', '--set', private_set, 'boot', identifier], timeout=60)
    run(context, ['xcrun', 'simctl', '--set', private_set, 'bootstatus', identifier, '-b'], timeout=120)
    # The installer validates this prepared project's private destination before the main check.


def make_result(context, observations, artifacts=None, owned=None):
    assertions = []
    for identifier in sorted(context['assertions']):
        actual = None if identifier == 'process-tree-terminated' else observations.get(identifier)
        passed = actual if isinstance(actual, bool) else (actual == 0 if identifier == 'tests-passed' else actual >= 1) if actual is not None else False
        assertions.append(dict(id=identifier, passed=passed, actual=actual))
    return dict(format=1, runId=context['runId'], package=context['package'], id=context['id'], assertions=assertions,
                artifacts=artifacts or [], resources=owned or [],
                cleanup=dict(required=bool(owned), attempted=bool(owned), completed=not bool(owned), reason=''))


def artifact(file):
    file = Path(file).resolve()
    return dict(path=str(file.relative_to(Path.cwd().resolve())), digest=hashlib.sha256(file.read_bytes()).hexdigest(), architecture=None)


def android_profile(context):
    return Path(os.environ['AEPM_CONTEXT_FILE']).parent / 'profiles/android' / context['runId']


def android_device_environment(context):
    env = environment(context)
    profile = android_profile(context)
    port = 5554 + 2 * (int(context['runId'][-4:], 16) % 64)
    server_port = 20000 + int(context['runId'][-8:], 16) % 20000
    env.update(ANDROID_AVD_HOME=str(profile / 'avd'), ANDROID_USER_HOME=str(profile / 'android'),
               ANDROID_EMULATOR_HOME=str(profile / 'emulator'), ADB_SERVER_SOCKET=f'tcp:127.0.0.1:{server_port}',
               ANDROID_ADB_SERVER_ADDRESS='127.0.0.1', ANDROID_ADB_SERVER_PORT=str(server_port),
               ANDROID_SERIAL=f'127.0.0.1:{port + 1}', ADB_MDNS_AUTO_CONNECT='0', ADB_LOCAL_TRANSPORT_MAX_PORT='0',
               ADB_USB='0', ADB_EMU='0', ADB_MDNS='0')
    return env, port, server_port


def check_android_inputs(project):
    if not (Path(project) / 'app/gradle.lockfile').is_file() or not (Path(project) / 'gradle/verification-metadata.xml').is_file():
        raise ValueError('assertion-failed')


def gradle_command(context, project):
    java_home = resources(context).get('androidJavaHome')
    if java_home is None:
        raise ValueError('resource-missing')
    java = java_home / 'bin' / ('java.exe' if os.name == 'nt' else 'java')
    return [str(java), '-Xmx64m', '-Xms64m', '-classpath', str(Path(project) / 'gradle/wrapper/gradle-wrapper.jar'),
            'org.gradle.wrapper.GradleWrapperMain', '--no-daemon', '--console=plain', '--dependency-verification=strict',
            '-Porg.gradle.java.installations.paths=' + str(java_home),
            '-Porg.gradle.java.installations.auto-detect=false', '-Porg.gradle.java.installations.auto-download=false']


def prepare_android(context, *, project, tasks):
    require(context, ['native-build'])
    check_android_inputs(project)
    command = [*gradle_command(context, project), *tasks]
    if 'dependency-download' not in context['operations']:
        command.append('--offline')
    run(context, command, cwd=project, timeout=600)


def stop_emulator(process):
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def stop_android_processes(processes):
    failed = False
    for process in reversed(processes):
        try:
            stop_emulator(process)
        except Exception:
            failed = True
    if failed:
        raise ValueError('cleanup-failed')


def wait_android_server(process, port):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ValueError('process-failed')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise ValueError('timeout')


def create_android_device(context):
    require(context, ['create-temporary-emulator'])
    sdk = android_sdk(context)
    env, port, server_port = android_device_environment(context)
    adb = sdk / 'platform-tools/adb'
    help_output = subprocess.run([str(adb), 'help'], env=env, capture_output=True, text=True, check=True, timeout=10)
    if not all(flag in help_output.stdout for flag in ['--one-device', 'ADB_MDNS_AUTO_CONNECT', 'ADB_LOCAL_TRANSPORT_MAX_PORT']):
        raise ValueError('private-destination-unsupported')
    for candidate in [port, port + 1, server_port]:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', candidate))
    profile = android_profile(context)
    profile.mkdir(parents=True, exist_ok=False)
    for relative in ['avd', 'android', 'emulator']:
        (profile / relative).mkdir()
    name = 'device-' + context['runId'] + '-0'
    intent = dict(format=1, runId=context['runId'], package=context['package'], id=context['id'], counter=0,
                  kind='android-device', requestedId=name, namespace=context['runId'])
    directory = Path(os.environ['AEPM_OWNERSHIP_DIRECTORY'])
    write_document(directory / 'intent-0.json', intent, True)
    manager = sdk / 'cmdline-tools/latest/bin/avdmanager'
    subprocess.run([str(manager), 'create', 'avd', '--name', name, '--package', context['settings']['androidSystemImage'],
                    '--device', context['settings']['androidDeviceProfile'], '--path', str(profile / 'avd' / (name + '.avd'))],
                   input='no\n', text=True, env=env, check=True, timeout=60)
    write_document(directory / 'created-0.json', {**intent, 'resourceId': name}, True)
    processes = []
    ready = False
    try:
        server = subprocess.Popen([str(adb), '-L', f'tcp:localhost:{server_port}', '--one-device',
                                   'aepm-no-usb-' + context['runId'], 'server', 'nodaemon'], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(server)
        wait_android_server(server, server_port)
        process = subprocess.Popen([str(sdk / 'emulator/emulator'), '-avd', name, '-port', str(port), '-no-window',
                                    '-no-audio', '-no-snapshot', '-no-boot-anim'], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(process)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if any(child.poll() is not None for child in processes):
                raise ValueError('process-failed')
            subprocess.run([str(adb), '-H', '127.0.0.1', '-P', str(server_port), 'connect', f'127.0.0.1:{port + 1}'], env=env, capture_output=True, timeout=5)
            output = subprocess.run([str(adb), '-H', '127.0.0.1', '-P', str(server_port), '-s', env['ANDROID_SERIAL'], 'shell', 'getprop', 'sys.boot_completed'],
                                    env=env, capture_output=True, text=True, timeout=5)
            if output.returncode == 0 and output.stdout.strip() == '1':
                identity = subprocess.run([str(adb), '-H', '127.0.0.1', '-P', str(server_port), '-s', env['ANDROID_SERIAL'], 'shell', 'getprop', 'ro.boot.qemu.avd_name'],
                                          env=env, capture_output=True, text=True, check=True, timeout=5)
                devices = subprocess.run([str(adb), '-H', '127.0.0.1', '-P', str(server_port), 'devices'], env=env, capture_output=True, text=True, check=True, timeout=5)
                entries = [line.split()[0] for line in devices.stdout.splitlines()[1:] if line.strip()]
                if identity.stdout.strip() != name or entries != [env['ANDROID_SERIAL']]:
                    raise ValueError('private-destination-unsupported')
                if any(child.poll() is not None for child in processes):
                    raise ValueError('process-failed')
                ready = True
                return processes, env
            time.sleep(1)
        raise ValueError('timeout')
    finally:
        if not ready:
            stop_android_processes(processes)


def run_android_tests(command, project, env, processes, timeout):
    test_process = subprocess.Popen(command, cwd=project, env=env)
    try:
        deadline = time.monotonic() + timeout
        while True:
            if any(process.poll() is not None for process in processes):
                raise ValueError('process-failed')
            code = test_process.poll()
            if code is not None:
                if code != 0:
                    raise ValueError('process-failed')
                return
            if time.monotonic() >= deadline:
                raise ValueError('timeout')
            time.sleep(0.1)
    finally:
        stop_emulator(test_process)


def run_android(context, *, project, tasks, artifact_paths):
    require(context, ['native-build', 'native-test'])
    project = Path(project)
    check_android_inputs(project)
    command = [*gradle_command(context, project), '--offline', *tasks]
    owned = []
    cleanup = None
    if any('connected' in task and 'AndroidTest' in task for task in tasks):
        processes = []
        try:
            processes, env = create_android_device(context)
            run_android_tests(command, project, env, processes, min(context['settings'].get('maximumSeconds', 600), 600))
        finally:
            stop_android_processes(processes)
            cleanup = cleanup_native(context)
            owned = cleanup['resources']
    else:
        run(context, command, cwd=project, timeout=600)
    if any('connected' in task and 'AndroidTest' in task for task in tasks):
        documents = list(project.glob('**/build/outputs/androidTest-results/connected/**/TEST-*.xml'))
    else:
        documents = list(project.glob('**/build/test-results/test*UnitTest/TEST-*.xml'))
    discovered = executed = failures = 0
    for file in documents:
        suite = ET.parse(file).getroot()
        tests = int(suite.attrib['tests'])
        discovered += tests
        executed += tests - int(suite.attrib.get('skipped', 0))
        failures += int(suite.attrib.get('failures', 0)) + int(suite.attrib.get('errors', 0))
    produced = bool(artifact_paths) and all(Path(file).is_file() for file in artifact_paths)
    result = make_result(context, {'build-produced': produced, 'tests-discovered': discovered, 'tests-executed': executed,
                                   'tests-passed': failures}, [artifact(file) for file in artifact_paths if Path(file).is_file()], owned)
    if cleanup:
        result['cleanup'] = {**cleanup['cleanup'], 'completed': False}
    return result


def apple_test_arguments(test_settings):
    if test_settings is None:
        return []
    if not isinstance(test_settings, Mapping) or len(test_settings) > 32:
        raise ValueError('context-invalid')
    arguments = []
    for name, value in test_settings.items():
        if not isinstance(name, str) or not re.fullmatch('[A-Z][A-Z0-9_]{0,63}', name) or not name.endswith('_TEST_SERVER_ADDRESS'):
            raise ValueError('context-invalid')
        if not isinstance(value, str) or len(value) > 256 or any(ord(character) < 33 or ord(character) == 127 for character in value):
            raise ValueError('context-invalid')
        try:
            address = urlsplit(value)
            if address.scheme != 'http' or address.hostname not in ['127.0.0.1', 'localhost', '::1'] or address.username is not None or address.password is not None or address.query or address.fragment or address.path not in ['', '/'] or not address.port or not 1 <= address.port <= 65535:
                raise ValueError('context-invalid')
            if not re.fullmatch(r'(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}', address.netloc, re.IGNORECASE):
                raise ValueError('context-invalid')
        except ValueError:
            raise ValueError('context-invalid') from None
        arguments.append(name + '=' + value)
    return sorted(arguments)


def run_apple(context, *, project, scheme, derived_data, package_cache, expected_targets, test_settings=None):
    require(context, ['native-test'])
    expected = apple_results.validate_expected_targets(expected_targets)
    test_arguments = apple_test_arguments(test_settings)
    deadline = time.monotonic() + min(context['settings'].get('maximumSeconds', 300), 300)
    records = [(intent, created) for intent, created in ownership(context) if intent['kind'] == 'apple-device']
    if len(records) != 1 or not records[0][1]:
        raise ValueError('resource-missing')
    intent, created = records[0]
    identifier = created['resourceId']
    platform = {'ios-simulator': 'iOS Simulator', 'tvos-simulator': 'tvOS Simulator'}[context['settings']['applePlatform']]
    result_path = Path(derived_data).parent / ('result-' + context['runId'] + '.xcresult')
    subprocess.run(['xcodebuild', '-quiet', '-project', str(project), '-scheme', scheme,
                    '-derivedDataPath', str(derived_data), '-clonedSourcePackagesDirPath', str(package_cache),
                    '-packageCachePath', str(Path(package_cache).parent / '.package-cache'), '-disablePackageRepositoryCache',
                    '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile',
                    '-destination', f'platform={platform},id={identifier}', '-destination-timeout', '30',
                    '-resultBundlePath', str(result_path), *test_arguments, 'CODE_SIGNING_ALLOWED=NO', 'test-without-building'],
                   env=apple_environment(context), check=True, timeout=max(0.001, deadline - time.monotonic()))
    coverage = apple_results.extract_apple_results(result_path, expected, env=apple_environment(context), deadline=deadline)
    coverage_path = Path(derived_data).parent / ('target-coverage-' + context['runId'] + '.json')
    write_document(coverage_path, {'format': 1, 'runId': context['runId'], 'package': context['package'], 'id': context['id'], **coverage})
    owned = [dict(kind='apple-device', id=identifier, namespace=context['runId'], createdByRunId=context['runId'], created=True, cleaned=False)]
    return make_result(context, {'build-produced': True, 'tests-discovered': coverage['discovered'], 'tests-executed': coverage['executed'],
                                 'tests-passed': coverage['failed']}, artifacts=[artifact(coverage_path)], owned=owned)


def cleanup_native(context):
    cleaned_resources = []
    complete = True
    records = ownership(context)
    for intent, created in records:
        if intent['kind'] == 'android-device':
            name = intent['requestedId']
            cleaned = False
            try:
                if not android_profile(context).exists():
                    cleaned_resources.append(dict(kind='android-device', id=created['resourceId'] if created else name,
                                                  namespace=context['runId'], createdByRunId=context['runId'], created=bool(created), cleaned=True))
                    continue
                shutil.rmtree(android_profile(context))
                cleaned = not android_profile(context).exists()
            except Exception:
                cleaned = False
            complete = complete and cleaned
            cleaned_resources.append(dict(kind='android-device', id=created['resourceId'] if created else name,
                                          namespace=context['runId'], createdByRunId=context['runId'], created=bool(created), cleaned=cleaned))
            continue
        if intent['kind'] != 'apple-device':
            raise ValueError('result-invalid')
        private_set = apple_set(context)
        identifier = created['resourceId'] if created else intent['requestedId']
        cleaned = False
        try:
            listed = json.loads(run(context, ['xcrun', 'simctl', '--set', private_set, 'list', 'devices', '--json'], timeout=15, capture=True).stdout)
            devices = [device for group in listed['devices'].values() for device in group]
            matches = [device for device in devices if device.get('udid') == identifier or not created and device.get('name') == intent['requestedId']]
            for device in matches:
                if device.get('name') != intent['requestedId']:
                    raise ValueError('result-invalid')
                if device.get('state') != 'Shutdown':
                    run(context, ['xcrun', 'simctl', '--set', private_set, 'shutdown', device['udid']], timeout=15)
                run(context, ['xcrun', 'simctl', '--set', private_set, 'delete', device['udid']], timeout=15)
            remaining = json.loads(run(context, ['xcrun', 'simctl', '--set', private_set, 'list', 'devices', '--json'], timeout=15, capture=True).stdout)
            cleaned = not any(device.get('udid') == identifier or device.get('name') == intent['requestedId'] for group in remaining['devices'].values() for device in group)
        except Exception:
            cleaned = False
        complete = complete and cleaned
        cleaned_resources.append(dict(kind='apple-device', id=identifier, namespace=context['runId'], createdByRunId=context['runId'], created=bool(created), cleaned=cleaned))
    if records and complete and any(intent['kind'] == 'apple-device' for intent, _ in records):
        try:
            shutil.rmtree(apple_set(context), ignore_errors=False)
        except OSError:
            complete = False
    return dict(format=1, runId=context['runId'], package=context['package'], id=context['id'], resources=cleaned_resources,
                cleanup=dict(required=bool(records), attempted=bool(records), completed=complete, reason='' if complete else 'cleanup-failed'))
