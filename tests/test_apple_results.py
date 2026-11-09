"""Synthetic schema/parser fixtures only; no task-owned native execution is claimed."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('apple_results', root / 'implementation/verification/apple_results.py')
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)
fixture = json.loads((root / 'tests/fixtures/apple-single-run.json').read_text())


class AppleResultSimulationTests(unittest.TestCase):
    def setUp(self):
        self.summary = deepcopy(fixture['summary'])
        self.tests = deepcopy(fixture['tests'])
        self.expected = dict(fixture['expectedTargets'])

    @property
    def bundle(self):
        return self.tests['testNodes'][0]['children'][0]

    @property
    def cases(self):
        return self.bundle['children'][0]['children']

    def parse(self):
        return results.parse_apple_results(self.summary, self.tests, self.expected)

    def counts(self, passed, failed=0, skipped=0, expected=0):
        values = dict(passedTests=passed,failedTests=failed,skippedTests=skipped,expectedFailures=expected)
        self.summary.update(values,totalTestCount=sum(values.values()))
        self.summary['devicesAndConfigurations'].update(values)

    def test_fixture_is_explicitly_simulated_and_matches_installed_enum_snapshot(self):
        self.assertIn('simulation',fixture['fixtureKind'])
        schema=json.loads((root/'tests/fixtures/xcresult-tests-0.5.0.schema.json').read_text())['schemas']
        self.assertEqual(set(schema['TestNodeType']['enum']),results.NODE_TYPES)
        self.assertEqual(set(schema['TestResult']['enum']),set(results.STATUSES)|{'unknown'})
        summary_schema=json.loads((root/'tests/fixtures/xcresult-summary-0.5.0.schema.json').read_text())['schemas']['Summary']
        for field in results.SUMMARY_FIELDS.values():
            self.assertIn(field,summary_schema['required'])
            self.assertEqual(summary_schema['properties'][field]['type'],'integer')

    def test_mixed_pass_and_skip_counts_actual_non_skipped_execution(self):
        coverage=self.parse()
        self.assertEqual((coverage['discovered'],coverage['executed'],coverage['failed']),(2,1,0))
        self.assertEqual(coverage['targets'],[dict(name='MediaTests',bundleType='Unit test bundle',passed=1,failed=0,skipped=1,expectedFailures=0,discovered=2,executed=1)])

    def test_diagnostic_children_do_not_hide_a_terminal_case(self):
        self.cases[0]['children']=[dict(nodeType='Runtime Warning',name='Synthetic diagnostic')]
        self.assertEqual(self.parse()['executed'],1)

    def test_same_case_identity_in_distinct_required_targets_is_allowed(self):
        second=deepcopy(self.bundle)
        second.update(name='InterfaceTests',nodeType='UI test bundle')
        self.tests['testNodes'][0]['children'].append(second)
        self.expected['InterfaceTests']='UI test bundle'
        self.counts(2,skipped=2)
        self.assertEqual(self.parse()['executed'],2)

    def test_all_three_targets_need_their_own_non_skipped_execution(self):
        original=deepcopy(self.bundle)
        self.expected={'MainTests':'Unit test bundle','InterfaceTests':'UI test bundle','MediaTests':'Unit test bundle'}
        bundles=[]
        for name,kind in self.expected.items():
            item=deepcopy(original)
            item.update(name=name,nodeType=kind)
            bundles.append(item)
        self.tests['testNodes'][0]['children']=bundles
        self.counts(3,skipped=3)
        self.assertEqual(self.parse()['executed'],3)
        bundles[1]['children'][0]['children'][0]['result']='Skipped'
        self.counts(2,skipped=4)
        with self.assertRaises(ValueError):self.parse()

    def test_each_promised_target_must_exist(self):
        self.expected['MissingTests']='Unit test bundle'
        with self.assertRaises(ValueError):self.parse()

    def test_unexpected_target_is_rejected(self):
        self.bundle['name']='WrongTests'
        with self.assertRaises(ValueError):self.parse()

    def test_wrong_bundle_type_is_rejected(self):
        self.bundle['nodeType']='UI test bundle'
        with self.assertRaises(ValueError):self.parse()

    def test_duplicate_bundle_is_not_silently_deduplicated(self):
        self.tests['testNodes'][0]['children'].append(deepcopy(self.bundle))
        self.counts(2,skipped=2)
        with self.assertRaises(ValueError):self.parse()

    def test_nested_bundle_is_rejected(self):
        self.bundle['children'].append(dict(nodeType='Unit test bundle',name='NestedTests'))
        self.expected['NestedTests']='Unit test bundle'
        with self.assertRaises(ValueError):self.parse()

    def test_empty_target_cannot_pass_from_parent_result(self):
        self.bundle['children']=[]
        self.counts(0)
        with self.assertRaises(ValueError):self.parse()

    def test_skipped_only_target_does_not_establish_execution(self):
        self.cases[0]['result']='Skipped'
        self.counts(0,skipped=2)
        with self.assertRaises(ValueError):self.parse()

    def test_failed_case_is_not_masked_by_passed_parent(self):
        self.cases[0]['result']='Failed'
        self.counts(0,failed=1,skipped=1)
        with self.assertRaises(ValueError):self.parse()

    def test_expected_failure_is_explicitly_rejected_by_initial_policy(self):
        self.cases[0]['result']='Expected Failure'
        self.counts(0,skipped=1,expected=1)
        with self.assertRaises(ValueError):self.parse()

    def test_identity_is_required_without_structural_fallback(self):
        self.cases[0].pop('nodeIdentifier')
        with self.assertRaises(ValueError):self.parse()

    def test_identifier_address_is_preferred_when_present(self):
        for index,case in enumerate(self.cases):
            case['nodeIdentifierURL']='test://fixture/'+str(index)
            case['nodeIdentifier']='same-short-name'
        self.assertEqual(self.parse()['executed'],1)

    def test_duplicate_case_identity_is_rejected(self):
        self.cases[1]['nodeIdentifier']=self.cases[0]['nodeIdentifier']
        with self.assertRaises(ValueError):self.parse()

    def test_duplicate_identifier_address_is_rejected(self):
        for case in self.cases:case['nodeIdentifierURL']='test://fixture/same'
        with self.assertRaises(ValueError):self.parse()

    def test_missing_unknown_and_malformed_outcomes_fail(self):
        for value in [None,'unknown','Success',[]]:
            with self.subTest(value=value):
                self.cases[0]['result']=value
                with self.assertRaises(ValueError):self.parse()
        self.cases[0].pop('result')
        with self.assertRaises(ValueError):self.parse()

    def test_repeated_or_argument_shapes_cannot_mask_skipped_or_failed_runs(self):
        for kind in ['Arguments','Repetition','Test Case Run','Device','Test Plan Configuration','Test Suite']:
            for outcome in ['Passed','Skipped','Failed']:
                with self.subTest(kind=kind,outcome=outcome):
                    self.cases[0]['children']=[dict(nodeType=kind,name='Synthetic nested run',result=outcome)]
                    with self.assertRaises(ValueError):self.parse()

    def test_cases_outside_bundles_or_nested_inside_cases_fail(self):
        case=deepcopy(self.cases[0])
        self.tests['testNodes'].append(case)
        with self.assertRaises(ValueError):self.parse()
        self.tests['testNodes'].pop()
        self.cases[0]['children']=[case]
        with self.assertRaises(ValueError):self.parse()

    def test_all_five_summary_counts_are_reconciled(self):
        for field in results.SUMMARY_FIELDS.values():
            with self.subTest(field=field):
                original=self.summary[field]
                self.summary[field]=original+1
                with self.assertRaises(ValueError):self.parse()
                self.summary[field]=original

    def test_summary_result_must_pass(self):
        self.summary['result']='Failed'
        with self.assertRaises(ValueError):self.parse()

    def test_counts_reject_booleans_fractions_negative_and_missing_values(self):
        for value in [True,1.0,-1,None]:
            with self.subTest(value=value):
                self.summary['passedTests']=value
                with self.assertRaises(ValueError):self.parse()

    def test_mapping_rejects_empty_unknown_type_and_sequence_conversion(self):
        for expected in [{},{'MediaTests':'Test Suite'},{'MediaTests':[]},[('MediaTests','Unit test bundle')],{'A'*129:'Unit test bundle'}]:
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                results.validate_expected_targets(expected)

    def test_malformed_children_unknown_nodes_and_multiple_configurations_fail(self):
        self.cases[0]['children']='not-an-array'
        with self.assertRaises(ValueError):self.parse()
        self.cases[0].pop('children')
        self.cases[0]['nodeType']='Unrecognized'
        with self.assertRaises(ValueError):self.parse()
        self.cases[0]['nodeType']='Test Case'
        self.tests['testPlanConfigurations']*=2
        with self.assertRaises(ValueError):self.parse()

    def test_depth_and_node_limits_fail_closed(self):
        with patch.object(results,'MAX_DEPTH',3), self.assertRaises(ValueError):self.parse()
        with patch.object(results,'MAX_NODES',3), self.assertRaises(ValueError):self.parse()

    def test_json_rejects_duplicates_nonfinite_and_invalid_encoding(self):
        for data in [b'{"a":1,"a":2}',b'{"a":NaN}',b'{"a":1e9999}',b'\xff',b'not-json']:
            with self.subTest(data=data), self.assertRaises(ValueError):results.strict_document(data)

    def test_queries_share_bundle_schema_deadline_and_output_budget(self):
        calls=[]
        times=iter([0,1,2,3,4,5])
        def query(argv,**kwargs):
            calls.append((argv,kwargs))
            data=json.dumps(self.summary if argv[4]=='summary' else self.tests).encode()
            return data,len(data)+5
        coverage=results.extract_apple_results('fixture.xcresult',self.expected,env={},deadline=10,query=query,clock=lambda:next(times))
        self.assertEqual(coverage['executed'],1)
        self.assertEqual([call[1]['timeout'] for call in calls],[9,7])
        self.assertLess(calls[1][1]['max_bytes'],calls[0][1]['max_bytes'])
        for argv,_ in calls:
            self.assertEqual(argv[argv.index('--schema-version')+1],'0.5.0')
            self.assertEqual(argv[argv.index('--path')+1],'fixture.xcresult')

    def test_query_budget_expiry_prevents_next_probe(self):
        calls=[]
        times=iter([0,0,29,31])
        def query(argv,**kwargs):
            calls.append(argv)
            data=json.dumps(self.summary).encode()
            return data,len(data)
        with self.assertRaisesRegex(ValueError,'timeout'):
            results.extract_apple_results('fixture',self.expected,env={},deadline=100,query=query,clock=lambda:next(times))
        self.assertEqual(len(calls),1)

    def test_a_query_returning_after_the_deadline_is_not_accepted(self):
        times=iter([0,0,31])
        data=json.dumps(self.summary).encode()
        with self.assertRaisesRegex(ValueError,'timeout'):
            results.extract_apple_results('fixture',self.expected,env={},deadline=100,
                                          query=lambda *args,**kwargs:(data,len(data)),clock=lambda:next(times))

    def test_aggregate_output_limit_prevents_next_probe(self):
        calls=[]
        def query(argv,**kwargs):
            calls.append(argv)
            data=json.dumps(self.summary).encode()
            return data,results.MAX_OUTPUT
        with self.assertRaisesRegex(ValueError,'output-limit'):
            results.extract_apple_results('fixture',self.expected,env={},deadline=100,query=query,clock=lambda:0)
        self.assertEqual(len(calls),1)

    def test_nonzero_tool_exit_fails_extraction(self):
        with self.assertRaisesRegex(ValueError,'process-failed'):
            results.capture_query([sys.executable,'-c','raise SystemExit(3)'],env=dict(os.environ),timeout=5,max_bytes=1024)

    def test_output_reader_enforces_actual_combined_byte_limit(self):
        with self.assertRaisesRegex(ValueError,'output-limit'):
            results.capture_query([sys.executable,'-c','import sys;sys.stderr.write("x"*2048)'],env=dict(os.environ),timeout=5,max_bytes=1024)

    def test_output_reader_timeout_stops_its_owned_plain_child(self):
        with self.assertRaisesRegex(ValueError,'timeout'):
            results.capture_query([sys.executable,'-c','import time;time.sleep(5)'],env=dict(os.environ),timeout=0.03,max_bytes=1024)


if __name__ == '__main__':
    unittest.main()
