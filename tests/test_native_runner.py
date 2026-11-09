import importlib.util
import json
import os
import runpy
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('native', Path(__file__).resolve().parents[1] / 'implementation/verification/native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeRunnerFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='native-runner-fixture-')
        self.root = Path(self.temporary.name)
        self.journal = self.root / 'ownership'
        self.journal.mkdir()
        self.env = patch.dict(os.environ, {'AEPM_CONTEXT_FILE':str(self.root / 'context.json'), 'AEPM_OWNERSHIP_DIRECTORY':str(self.journal)})
        self.env.start()
        self.context = dict(format=1,runId='a'*64,package='b'*64,id='native-fixture',mode='local',simulationKind=None,
                            settings=dict(applePlatform='ios-simulator',appleRuntime='fixture.runtime',appleDeviceType='fixture.device'),
                            resources=[],secrets={},operations=['native-build','native-test','create-temporary-simulator'],origins=[],
                            assertions=['build-produced','tests-discovered','tests-executed','tests-passed'])

    def tearDown(self):
        self.env.stop()
        self.temporary.cleanup()

    def test_real_xml_counts_are_required_not_exit_zero_alone(self):
        project = self.root / 'android'
        self.context['resources'] = [{'id':'androidJavaHome','path':str(self.root / 'java'),'digest':'c'*64}]
        (project / 'app').mkdir(parents=True)
        (project / 'app/gradle.lockfile').write_text('fixture lock')
        (project / 'gradle').mkdir()
        (project / 'gradle/verification-metadata.xml').write_text('<fixture/>')
        results = project / 'app/build/test-results/testDebugUnitTest'
        results.mkdir(parents=True)
        (results / 'TEST-fixture.xml').write_text('<testsuite tests="6" skipped="1" failures="0" errors="0"/>')
        binary = project / 'app/debug.apk'
        binary.write_bytes(b'fixture artifact')
        with patch.object(native, 'run'), patch.object(Path, 'cwd', return_value=self.root):
            report = native.run_android(self.context, project=project, tasks=['testDebugUnitTest','assembleDebug'], artifact_paths=[binary])
            observed = {item['id']:item['actual'] for item in report['assertions']}
            self.assertEqual(observed, {'build-produced':True,'tests-discovered':6,'tests-executed':5,'tests-passed':0})
            (results / 'TEST-fixture.xml').unlink()
            report = native.run_android(self.context, project=project, tasks=['testDebugUnitTest','assembleDebug'], artifact_paths=[binary])
            self.assertFalse(all(item['passed'] for item in report['assertions']))

    def test_missing_checksum_metadata_fails_before_preparation(self):
        with patch.object(native, 'run') as run:
            with self.assertRaises(ValueError):
                native.prepare_android(self.context, project=self.root, tasks=['assembleDebug'])
            run.assert_not_called()

    def test_gradle_uses_only_the_validated_java_installation(self):
        home=self.root/'validated-java'
        self.context['resources']=[{'id':'androidJavaHome','path':str(home),'digest':'c'*64}]
        command=native.gradle_command(self.context,self.root/'project')
        self.assertEqual(command[0],str(home/'bin'/('java.exe' if os.name=='nt' else 'java')))
        self.assertIn('-Porg.gradle.java.installations.paths='+str(home),command)
        self.assertIn('-Porg.gradle.java.installations.auto-detect=false',command)
        self.assertIn('-Porg.gradle.java.installations.auto-download=false',command)

    def test_working_resources_never_point_tools_at_validated_seeds(self):
        seeds = self.root / 'seeds'
        seeds.mkdir()
        (self.root / 'android-sdk-working').mkdir()
        (self.root / 'gradle-working').mkdir()
        self.context['resources'] = [{'id':'androidSdk','path':str(seeds),'digest':'c'*64}, {'id':'androidCache','path':str(seeds),'digest':'d'*64}]
        environment = native.environment(self.context)
        self.assertEqual(environment['ANDROID_HOME'],str(self.root / 'android-sdk-working'))
        self.assertEqual(environment['GRADLE_USER_HOME'],str(self.root / 'gradle-working'))
        self.assertNotEqual(environment['GRADLE_USER_HOME'],str(seeds))
        (self.root / 'android-sdk-working').rmdir()
        with self.assertRaises(ValueError): native.environment(self.context)

    def android_creation_fixture(self, extra_device=False, failure=None):
        (self.root / 'android-sdk-working').mkdir()
        self.context['resources'] = [{'id':'androidSdk','path':str(self.root / 'seed'),'digest':'c'*64}]
        self.context['operations'].append('create-temporary-emulator')
        self.context['settings'].update(androidSystemImage='system-images;android-36;fixture;arm64-v8a',androidDeviceProfile='fixture')
        env, port, server_port = native.android_device_environment(self.context)
        commands=[]
        server, emulator = Mock(), Mock()
        for process in [server, emulator]:
            process.poll.return_value=None
            process.wait.return_value=0
        if failure == 'server-exit':
            server.poll.return_value=1
        launched=[]
        def launch(argv, **kwargs):
            commands.append((argv,kwargs.get('env')))
            self.assertNotIn('start_new_session',kwargs)
            self.assertNotIn('creationflags',kwargs)
            if launched and failure == 'emulator-spawn':
                raise OSError('fixture spawn failure')
            process = server if not launched else emulator
            launched.append(process)
            return process
        def execute(argv, **kwargs):
            commands.append((argv,kwargs.get('env')))
            if argv[-1]=='help':
                return SimpleNamespace(returncode=0,stdout='--one-device ADB_MDNS_AUTO_CONNECT ADB_LOCAL_TRANSPORT_MAX_PORT')
            if argv[-1]=='sys.boot_completed':
                return SimpleNamespace(returncode=0,stdout='1\n')
            if argv[-1]=='ro.boot.qemu.avd_name':
                return SimpleNamespace(returncode=0,stdout='device-'+self.context['runId']+'-0\n')
            if argv[-1]=='devices':
                return SimpleNamespace(returncode=0,stdout='List of devices attached\n'+env['ANDROID_SERIAL']+'\tdevice\n'+('physical-device\tdevice\n' if extra_device else ''))
            return SimpleNamespace(returncode=0,stdout='')
        with patch.object(native.subprocess,'run',side_effect=execute), patch.object(native.subprocess,'Popen',side_effect=launch), patch.object(native.socket,'socket'), patch.object(native,'wait_android_server',side_effect=ValueError('timeout') if failure == 'server-timeout' else None), patch.object(native.time,'monotonic',side_effect=[0,121] if failure == 'boot-timeout' else None, return_value=0):
            if extra_device or failure:
                with self.assertRaises((ValueError,OSError)):
                    native.create_android_device(self.context)
                for process in launched:
                    if process is server and failure == 'server-exit':
                        process.terminate.assert_not_called()
                    else:
                        process.terminate.assert_called_once()
                    process.wait.assert_called_once()
            else:
                processes,_=native.create_android_device(self.context)
                self.assertEqual(processes,[server,emulator])
        return commands, env

    def test_simulated_android_server_disables_all_automatic_device_connections(self):
        commands, env=self.android_creation_fixture()
        start=next(argv for argv,_ in commands if argv[-1]=='nodaemon')
        self.assertEqual(start[-2:],['server','nodaemon'])
        self.assertFalse(any('start-server' in argv for argv,_ in commands))
        self.assertIn('--one-device',start)
        self.assertEqual(start[start.index('--one-device')+1],'aepm-no-usb-'+self.context['runId'])
        self.assertEqual(env['ADB_MDNS_AUTO_CONNECT'],'0')
        self.assertEqual(env['ADB_LOCAL_TRANSPORT_MAX_PORT'],'0')
        self.assertEqual(env['ADB_SERVER_SOCKET'],'tcp:127.0.0.1:'+env['ANDROID_ADB_SERVER_PORT'])
        self.assertEqual(env['ANDROID_ADB_SERVER_ADDRESS'],'127.0.0.1')
        for key in ['ADB_USB','ADB_EMU','ADB_MDNS']:
            self.assertEqual(env[key],'0')
        for argv,_ in commands:
            if '-s' in argv:self.assertEqual(argv[argv.index('-s')+1],env['ANDROID_SERIAL'])
            if '-P' in argv:self.assertEqual(argv[argv.index('-H')+1],'127.0.0.1')
        self.assertFalse(any('install' in argv for argv,_ in commands))

    def test_unexpected_device_blocks_before_any_installation(self):
        self.android_creation_fixture(extra_device=True)

    def test_server_timeout_stops_and_waits_foreground_server(self):
        self.android_creation_fixture(failure='server-timeout')

    def test_foreground_readiness_failure_never_invokes_a_client_or_daemon(self):
        process=Mock()
        process.poll.return_value=1
        with patch.object(native.subprocess,'run') as run, patch.object(native.socket,'create_connection') as connect:
            with self.assertRaisesRegex(ValueError,'process-failed'):
                native.wait_android_server(process,25000)
            run.assert_not_called()
            connect.assert_not_called()

    def test_foreground_readiness_deadline_is_bounded(self):
        process=Mock()
        process.poll.return_value=None
        with patch.object(native.time,'monotonic',side_effect=[0,1,16]), patch.object(native.time,'sleep'), patch.object(native.socket,'create_connection',side_effect=OSError('fixture refused')) as connect:
            with self.assertRaisesRegex(ValueError,'timeout'):
                native.wait_android_server(process,25000)
            connect.assert_called_once_with(('127.0.0.1',25000),timeout=0.2)

    def test_emulator_spawn_failure_stops_and_waits_foreground_server(self):
        self.android_creation_fixture(failure='emulator-spawn')

    def test_boot_timeout_stops_and_waits_both_owned_processes(self):
        self.android_creation_fixture(failure='boot-timeout')

    def test_lost_foreground_server_cannot_be_replaced_as_owned_execution(self):
        self.android_creation_fixture(failure='server-exit')

    def test_test_process_stops_when_foreground_server_is_lost(self):
        server,emulator,test_process=Mock(),Mock(),Mock()
        server.poll.return_value=1
        emulator.poll.return_value=None
        test_process.poll.return_value=None
        with patch.object(native.subprocess,'Popen',return_value=test_process):
            with self.assertRaisesRegex(ValueError,'process-failed'):
                native.run_android_tests(['fixture'],self.root,{},[server,emulator],60)
        test_process.terminate.assert_called_once()
        test_process.wait.assert_called_once()

    def test_test_timeout_stops_the_test_process(self):
        server,emulator,test_process=Mock(),Mock(),Mock()
        for process in [server,emulator,test_process]:process.poll.return_value=None
        with patch.object(native.subprocess,'Popen',return_value=test_process), patch.object(native.time,'monotonic',side_effect=[0,61]):
            with self.assertRaisesRegex(ValueError,'timeout'):
                native.run_android_tests(['fixture'],self.root,{},[server,emulator],60)
        test_process.terminate.assert_called_once()
        test_process.wait.assert_called_once()

    def test_termination_timeout_kills_and_waits_both_processes(self):
        processes=[Mock(),Mock()]
        for process in processes:
            process.poll.return_value=None
            process.wait.side_effect=[native.subprocess.TimeoutExpired('fixture',20),0]
        native.stop_android_processes(processes)
        for process in processes:
            process.terminate.assert_called_once()
            process.kill.assert_called_once()
            self.assertEqual(process.wait.call_count,2)

    def test_stop_failure_still_attempts_the_other_owned_process(self):
        server,emulator=Mock(),Mock()
        for process in [server,emulator]:process.poll.return_value=None
        emulator.wait.side_effect=native.subprocess.TimeoutExpired('fixture',20)
        with self.assertRaisesRegex(ValueError,'cleanup-failed'):
            native.stop_android_processes([server,emulator])
        server.terminate.assert_called_once()
        server.wait.assert_called_once()

    def test_android_cleanup_only_deletes_owned_files_without_starting_processes(self):
        self.android_creation_fixture()
        with patch.object(native.subprocess,'run') as run, patch.object(native.subprocess,'Popen') as spawn:
            result=native.cleanup_native(self.context)
            self.assertTrue(result['cleanup']['completed'])
            self.assertFalse(native.android_profile(self.context).exists())
            self.assertTrue(native.cleanup_native(self.context)['cleanup']['completed'])
            run.assert_not_called()
            spawn.assert_not_called()

    def test_simulated_creation_journals_before_create_and_cleans_only_private_set(self):
        identifier = '12345678-1234-1234-1234-123456789ABC'
        (self.root / 'Host.xcodeproj').mkdir()
        (self.root / 'derived/Build/Products').mkdir(parents=True)
        arguments = []
        def create(context, argv, **kwargs):
            arguments.append(argv)
            if 'create' in argv:
                self.assertTrue((self.journal / 'intent-0.json').is_file())
                return SimpleNamespace(stdout=identifier + '\n')
            return SimpleNamespace(stdout='')
        with patch.object(native, 'run', side_effect=create), patch.object(native.subprocess, 'run', return_value=SimpleNamespace(stdout=identifier)):
            native.prepare_apple(self.context, project=self.root / 'Host.xcodeproj', scheme='Host', derived_data=self.root / 'derived', package_cache=self.root / 'packages')
        created = json.loads((self.journal / 'created-0.json').read_text())
        self.assertEqual(created['resourceId'],identifier)
        name = created['requestedId']
        listings = iter([{'devices':{'fixture':[{'udid':identifier,'name':name,'state':'Shutdown'}]}},{'devices':{}}])
        def cleanup(context, argv, **kwargs):
            self.assertEqual(argv[2],'--set')
            self.assertEqual(argv[3],native.apple_set(self.context))
            return SimpleNamespace(stdout=json.dumps(next(listings)) if 'list' in argv else '')
        with patch.object(native, 'run', side_effect=cleanup):
            result=native.cleanup_native(self.context)
        self.assertTrue(result['cleanup']['completed'])
        self.assertFalse(native.apple_set(self.context).exists())

    def test_cleanup_rejects_a_device_with_unmatched_ownership_name(self):
        identifier='12345678-1234-1234-1234-123456789ABC'
        private_set=native.apple_set(self.context)
        private_set.mkdir(parents=True)
        intent=dict(format=1,runId=self.context['runId'],package=self.context['package'],id=self.context['id'],counter=0,
                    kind='apple-device',requestedId='device-'+self.context['runId']+'-0',namespace=self.context['runId'])
        native.write_document(self.journal/'intent-0.json',intent,True)
        native.write_document(self.journal/'created-0.json',{**intent,'resourceId':identifier},True)
        with patch.object(native,'run',return_value=SimpleNamespace(stdout=json.dumps({'devices':{'fixture':[{'udid':identifier,'name':'unrelated-device','state':'Booted'}]}}))) as command:
            result=native.cleanup_native(self.context)
        self.assertFalse(result['cleanup']['completed'])
        self.assertEqual(result['cleanup']['reason'],'cleanup-failed')
        self.assertEqual(command.call_count,1)
        self.assertTrue(private_set.exists())

    def test_apple_test_settings_accept_only_literal_loopback_server_origins(self):
        self.assertEqual(native.apple_test_arguments(None),[])
        self.assertEqual(native.apple_test_arguments({'B_TEST_SERVER_ADDRESS':'http://localhost:1235/', 'A_TEST_SERVER_ADDRESS':'http://[::1]:1234'}),
                         ['A_TEST_SERVER_ADDRESS=http://[::1]:1234','B_TEST_SERVER_ADDRESS=http://localhost:1235/'])
        for name in ['CODE_SIGNING_ALLOWED','-destination','app_TEST_SERVER_ADDRESS','A'*65+'_TEST_SERVER_ADDRESS','A_TEST_SERVER_ADDRESS\n']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError,'context-invalid'):
                native.apple_test_arguments({name:'http://127.0.0.1:1234'})
        for value in ['https://127.0.0.1:1234','http://example.test:1234','http://localhost','http://localhost:0','http://localhost:65536',
                      'http://user@localhost:1234','http://localhost:1234/path','http://localhost:1234?token=x','http://localhost:1234#fragment',
                      'http://localhost:1234\n','http://localhost:1234/\x85']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError,'context-invalid'):
                native.apple_test_arguments({'APP_TEST_SERVER_ADDRESS':value})

    def test_apple_test_setting_handoff_precedes_fixed_signing_and_action_arguments(self):
        identifier='12345678-1234-1234-1234-123456789ABC'
        intent=dict(format=1,runId=self.context['runId'],package=self.context['package'],id=self.context['id'],counter=0,
                    kind='apple-device',requestedId='device-'+self.context['runId']+'-0',namespace=self.context['runId'])
        native.write_document(self.journal/'intent-0.json',intent,True)
        native.write_document(self.journal/'created-0.json',{**intent,'resourceId':identifier},True)
        address='http://127.0.0.1:23456'
        fixture=json.loads((Path(__file__).parent/'fixtures/apple-single-run.json').read_text())
        def query(argv, **kwargs):
            data=json.dumps(fixture['summary'] if argv[4]=='summary' else fixture['tests']).encode()
            return data,len(data)
        with patch.object(native.subprocess,'run') as execute, patch.object(native.apple_results,'capture_query',side_effect=query) as extraction, patch.object(Path,'cwd',return_value=self.root):
            result=native.run_apple(self.context,project=self.root/'Host.xcodeproj',scheme='Host',derived_data=self.root/'derived',
                                    package_cache=self.root/'packages',expected_targets=fixture['expectedTargets'],test_settings={'APP_TEST_SERVER_ADDRESS':address})
        arguments=execute.call_args.args[0]
        self.assertEqual(arguments[-3:],['APP_TEST_SERVER_ADDRESS='+address,'CODE_SIGNING_ALLOWED=NO','test-without-building'])
        self.assertEqual(arguments[arguments.index('-destination')+1],'platform=iOS Simulator,id='+identifier)
        self.assertTrue(all(assertion['passed'] for assertion in result['assertions']))
        self.assertEqual(extraction.call_count,2)
        coverage=json.loads((self.root/result['artifacts'][0]['path']).read_text())
        self.assertEqual(coverage['targets'][0]['name'],'MediaTests')
        self.assertEqual(coverage['targets'][0]['executed'],1)

    def test_invalid_expected_targets_reject_before_native_invocation(self):
        with patch.object(native.subprocess,'run') as execute:
            with self.assertRaisesRegex(ValueError,'context-invalid'):
                native.run_apple(self.context,project=self.root/'Host.xcodeproj',scheme='Host',derived_data=self.root/'derived',
                                 package_cache=self.root/'packages',expected_targets={})
            execute.assert_not_called()

    def test_component_scheme_selects_exactly_one_test_target(self):
        script=Path(__file__).resolve().parents[1]/'scripts/platform-check.py'
        for platform,target in [('ios-simulator','MediaTests'),('tvos-simulator','MediaTelevisionTests')]:
            with self.subTest(platform=platform):
                self.context['settings']['applePlatform']=platform
                fake=SimpleNamespace(read_context=lambda:self.context,run_apple=Mock(return_value={}),write_result=Mock())
                module_spec=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module:None))
                with patch.object(sys,'argv',[str(script),'apple']), patch('importlib.util.spec_from_file_location',return_value=module_spec), patch('importlib.util.module_from_spec',return_value=fake):
                    runpy.run_path(str(script),run_name='__main__')
                self.assertEqual(fake.run_apple.call_args.kwargs['expected_targets'],{target:'Unit test bundle'})


if __name__ == '__main__':
    unittest.main()
