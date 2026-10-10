import concurrent.futures
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import server


class ScannerResilienceTests(unittest.TestCase):
    def test_identical_glyph_is_read_once_but_changed_pixels_are_read_again(self):
        server.GLYPH_CACHE.clear()
        image = server.np.zeros((3, 3), dtype=server.np.uint8)
        with patch.object(server.pytesseract, 'image_to_string', return_value='7') as read:
            self.assertEqual(server.bounded_ocr(image, 'digit'), '7')
            self.assertEqual(server.bounded_ocr(image.copy(), 'digit'), '7')
            self.assertEqual(read.call_count, 1)
            image[0, 0] = 255
            server.bounded_ocr(image, 'digit')
            self.assertEqual(read.call_count, 2)

    def test_six_readers_finish_with_only_one_ocr_process(self):
        active = 0
        peak = 0
        guard = threading.Lock()

        def read(image, **kwargs):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            time.sleep(.02)
            with guard:
                active -= 1
            return str(image)

        with patch.object(server.pytesseract, 'image_to_string', side_effect=read):
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda i: server.bounded_ocr(i, ''), range(6)))
        self.assertEqual(results, list(map(str, range(6))))
        self.assertEqual(peak, 1)
        self.assertFalse(server.OCR_QUEUE)

    def test_timeout_is_retryable_and_queue_is_released(self):
        with patch.object(server.pytesseract, 'image_to_string', side_effect=RuntimeError('Tesseract process timeout')):
            with self.assertRaises(server.ScannerBusy):
                server.bounded_ocr(None, '')
        self.assertFalse(server.OCR_QUEUE)

    def test_exact_image_cache_separates_targets(self):
        with server.app.test_request_context('/detect', method='POST', json={'image': 'same', 'target_num': 1}):
            server.prepare_request()
            server.remember_result(server.jsonify(color='red'))
        with server.app.test_request_context('/detect', method='POST', json={'image': 'same', 'target_num': 1}):
            self.assertEqual(server.prepare_request().get_json()['color'], 'red')
        with server.app.test_request_context('/detect', method='POST', json={'image': 'same', 'target_num': 2}):
            self.assertIsNone(server.prepare_request())

    def test_concurrent_reports_preserve_all_slots_and_count_observed_points(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(server, 'STATS_FILE', directory + '/stats.json'), patch.object(server, 'EARNINGS_FILE', directory + '/earnings.json'):
                def report(i):
                    with server.app.test_client() as client:
                        for points in (10, 11, 11):
                            response = client.post('/report', json={'slot': str(i), 'pointsDone': points, 'taskCount': 50, 'countMode': 'observed-points'})
                            self.assertEqual(response.status_code, 200)
                with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
                    list(pool.map(report, range(7)))
                with open(directory + '/stats.json') as handle:
                    slots = server.json.load(handle)['slots']
                self.assertEqual(len(slots), 7)
                for slot in slots.values():
                    self.assertEqual(slot['correctCount'], 1)
                    self.assertEqual(slot['taskCount'], 50)
                    self.assertIsNone(slot['wrongCount'])


if __name__ == '__main__':
    unittest.main()
