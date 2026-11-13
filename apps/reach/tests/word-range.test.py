"""Ray Zhang: the real backend iterator must terminate on lying UIA providers."""
import unittest

# Run with the candidate interpreter and import the candidate's actual module.
from windows_mcp.uia.controls import Control, WordRangeTraversalError
from windows_mcp.tree.views import _node_meta_str, TreeState, BoundingBox
from windows_mcp.desktop.service import Desktop
from windows_mcp.desktop.views import DesktopState
from windows_mcp.tools._snapshot_helpers import build_snapshot_response


class Range:
    def __init__(self, position=0, end=3, mode='forward', calls=None):
        self.position, self.end, self.mode = position, end, mode
        self.calls = calls if calls is not None else []

    def Clone(self):
        return Range(self.position, self.end, self.mode, self.calls)

    def ExpandToEnclosingUnit(self, unit, waitTime):
        assert waitTime == 0

    def CompareEndpoints(self, mine, other, theirs):
        left = self.position if int(mine) == 0 else self.end
        right = other.position if int(theirs) == 0 else other.end
        return (left > right) - (left < right)

    def GetText(self, length):
        return '' if self.mode == 'empty-cycle' else f'word-{self.position}'

    def Move(self, unit, count, waitTime):
        assert count == 1 and waitTime == 0
        self.calls.append(self.position)
        if self.mode == 'stopped':
            return 0
        if self.mode == 'stationary':
            return 1
        if self.mode == 'negative':
            return -1
        self.position += 1
        if self.mode in ('cycle', 'empty-cycle') and self.position == 2:
            self.position = 0
        return 1


class Pattern:
    def __init__(self, ranges):
        self.ranges = ranges

    def GetVisibleRanges(self):
        return self.ranges


class Tests(unittest.TestCase):
    def iterate(self, ranges):
        return Control._iter_word_ranges(object(), Pattern(ranges))

    def test_normal_and_disjoint_ranges_remain_complete(self):
        values = [text for text, _ in self.iterate([Range(), Range(5, 7)])]
        self.assertEqual(values, ['word-0', 'word-1', 'word-2', 'word-5', 'word-6'])

    def test_legitimate_zero_move_ends_without_error(self):
        self.assertEqual([text for text, _ in self.iterate([Range(mode='stopped')])], ['word-0'])

    def test_backward_wrap_is_rejected_before_a_duplicate_is_yielded(self):
        item = Range(mode='cycle');iterator = self.iterate([item])
        self.assertEqual(next(iterator)[0], 'word-0')
        self.assertEqual(next(iterator)[0], 'word-1')
        with self.assertRaises(WordRangeTraversalError):
            next(iterator)
        self.assertEqual(item.calls, [0, 1])

    def test_stationary_and_negative_reports_terminate(self):
        for mode in ('stationary', 'negative'):
            with self.subTest(mode=mode):
                item = Range(mode=mode)
                with self.assertRaises(WordRangeTraversalError):
                    list(self.iterate([item]))
                self.assertEqual(item.calls, [0])

    def test_empty_text_cannot_hide_a_cycle(self):
        item = Range(mode='empty-cycle')
        with self.assertRaises(WordRangeTraversalError):
            list(self.iterate([item]))
        self.assertEqual(item.calls, [0, 1])

    def test_partial_geometry_is_visible_without_hiding_control_value(self):
        rendered = _node_meta_str({'value': 'retained full text', 'word_geometry_incomplete': True})
        self.assertIn('retained full text', rendered)
        self.assertIn('word coordinates incomplete: provider range did not advance', rendered)

    def test_region_filter_and_response_preserve_distinct_geometry_warning(self):
        tree = TreeState(word_geometry_incomplete=True)
        region = BoundingBox(left=0, top=0, right=100, bottom=100, width=100, height=100)
        filtered = Desktop.__new__(Desktop)._filter_tree_state_to_region(tree, region)
        self.assertTrue(filtered.word_geometry_incomplete)
        self.assertFalse(filtered.truncated, 'word geometry must not pretend the element budget ran out')
        desktop = DesktopState(active_desktop={}, all_desktops=[], active_window=None, windows=[], tree_state=filtered)
        captured = dict(desktop_state=desktop, interactive_elements='', scrollable_elements='', semantic_tree='',
                        windows='', active_window='', active_desktop='', all_desktops='', screenshot_bytes=None,
                        use_ui_tree=True)
        response = build_snapshot_response(captured, include_ui_details=True)[0]
        self.assertIn('Word coordinates incomplete:', response)
        self.assertIn('Reach UI Labels: []', response)
        self.assertNotIn('500 elements', response)
        filtered.word_geometry_incomplete = False
        self.assertNotIn('Word coordinates incomplete:', build_snapshot_response(captured, include_ui_details=True)[0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
