"""Pinned native Unicode card validation; uses the same golden fixture as app/CP."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

# pytest's importlib mode does not put this directory on sys.path.
fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = fixture
    spec.loader.exec_module(fixture)
cx = sys.modules['village_bridge._contextsling']
VECTORS = json.loads(Path(__file__).with_name('contextsling-vectors.json').read_text())

class UnicodeCardTest(unittest.TestCase):
    def payload(self, value, field):
        p = copy.deepcopy(VECTORS['vectors'][4 if field in ('title', 'bundleId') else 0]['payload'])
        if field in ('title', 'bundleId'):
            p['preview']['target'][field] = value
        elif field == 'name':
            p['preview']['file']['name'] = value
        else:
            f = p['preview']['file']
            f.update(lines=[value], finalNewline=False, bytes=len(value.encode()), sha256=hashlib.sha256(value.encode()).hexdigest())
        return p

    def test_shared_cases_in_all_display_fields(self):
        for v in VECTORS['unicode']['cases']:
            for field in ('title', 'bundleId', 'name', 'line'):
                with self.subTest(case=v['id'], field=field):
                    p = self.payload(v['value'], field)
                    if v['accepted'] or (field == 'line' and v['id'] in ('marks-only', 'plain-space', 'unassigned')):
                        cx.approval_summary(p)
                    else:
                        with self.assertRaisesRegex(ValueError, 'approval_card_invalid'):
                            cx.approval_summary(p)

    def test_runtime_data_and_every_range_edge(self):
        self.assertEqual(cx.UNICODE_RULE, VECTORS['unicode']['rule'])
        for parts in cx.DEFAULT_IGNORABLE_RANGES:
            for cp in set((parts[0], parts[-1])):
                with self.assertRaisesRegex(ValueError, 'approval_card_invalid'):
                    cx.approval_summary(self.payload('x' + chr(cp), 'line'))
        for lo, hi in cx.UNICODE_RULE['extendedPictographicRanges']:
            for cp in set((lo-1, lo, hi, hi+1)):
                p = self.payload('x' + chr(cp) + '\ufe0f', 'line')
                if cx.in_ranges(cp, cx.UNICODE_RULE['extendedPictographicRanges']):
                    cx.approval_summary(p)
                else:
                    with self.assertRaisesRegex(ValueError, 'approval_card_invalid'):
                        cx.approval_summary(p)

    def test_category_edges_without_visible_ascii_prefix(self):
        self.assertEqual(cx.UNICODE_RULE['categorySourceSha256'], '2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c')
        points = {cp for lo, hi in cx.UNICODE_RULE['visibleRanges'] + cx.UNICODE_RULE['forbiddenRanges'] for cp in (lo-1, lo, hi, hi+1) if 0 <= cp <= 0x10ffff}
        for cp in points:
            allowed = cx.in_ranges(cp, cx.UNICODE_RULE['visibleRanges']) and not cx.in_ranges(cp, cx.UNICODE_RULE['forbiddenRanges']) and not cx.in_ranges(cp, cx.DEFAULT_IGNORABLE_RANGES)
            p = self.payload(chr(cp), 'title')
            if allowed:
                cx.approval_summary(p)
            else:
                with self.assertRaisesRegex(ValueError, 'approval_card_invalid'):
                    cx.approval_summary(p)

if __name__ == '__main__':
    unittest.main()
