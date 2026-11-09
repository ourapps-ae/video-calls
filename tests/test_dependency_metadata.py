"""Check the reviewed metadata delta without downloading or building dependencies."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PROVENANCE = json.loads((ROOT / 'tests/fixtures/dependency-metadata-provenance.json').read_text())
METADATA = ROOT / 'tests/native/android/gradle/verification-metadata.xml'


def reviewed_delta(tree):
    tree = deepcopy(tree)
    components = tree.find('{*}components')
    for expected in PROVENANCE['additions']:
        matching = [component for component in components if component.attrib == {key: expected[key] for key in ['group','name','version']}]
        if len(matching) != 1:
            return False
        component = matching[0]
        artifacts = [artifact for artifact in component if artifact.attrib.get('name') == expected['artifact']]
        if len(artifacts) != 1 or artifacts[0].attrib != {'name': expected['artifact']}:
            return False
        hashes = list(artifacts[0])
        if len(hashes) != 1 or hashes[0].tag.rsplit('}',1)[-1] != 'sha256' or hashes[0].attrib != {'value':expected['sha256'],'origin':'Verified Maven Central and retained cache'}:
            return False
        component.remove(artifacts[0])
        if not expected['componentWasPresent']:
            if list(component):
                return False
            components.remove(component)
    canonical = ET.canonicalize(ET.tostring(tree,encoding='unicode'),strip_text=True,rewrite_prefixes=True)
    return hashlib.sha256(canonical.encode()).hexdigest() == PROVENANCE['canonicalBaselineSha256']


class DependencyMetadataTests(unittest.TestCase):
    def setUp(self):
        self.tree = ET.parse(METADATA).getroot()

    def test_exact_three_reviewed_hash_additions_preserve_every_existing_setting(self):
        self.assertTrue(reviewed_delta(self.tree))

    def test_existing_hash_change_is_rejected(self):
        self.tree.find('.//{*}sha256').set('value','0'*64)
        self.assertFalse(reviewed_delta(self.tree))

    def test_missing_or_wrong_approved_hash_is_rejected(self):
        expected=PROVENANCE['additions'][0]
        component=next(item for item in self.tree.findall('.//{*}component') if item.attrib.get('name')==expected['name'] and item.attrib.get('version')==expected['version'])
        component.find('{*}artifact/{*}sha256').set('value','0'*64)
        self.assertFalse(reviewed_delta(self.tree))
        component.remove(component.find('{*}artifact'))
        self.assertFalse(reviewed_delta(self.tree))

    def test_disabling_metadata_verification_is_rejected(self):
        self.tree.find('{*}configuration/{*}verify-metadata').text='false'
        self.assertFalse(reviewed_delta(self.tree))

    def test_unreviewed_trust_or_artifact_addition_is_rejected(self):
        namespace=self.tree.tag.split('}')[0]+'}'
        ET.SubElement(self.tree.find('{*}configuration'),namespace+'trusted-artifacts')
        self.assertFalse(reviewed_delta(self.tree))


if __name__ == '__main__':
    unittest.main()
