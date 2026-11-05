import unittest
from types import SimpleNamespace
from unittest.mock import patch
import dependencies

class DependencyTests(unittest.TestCase):
    def test_reports_old_python_before_trying_import(self):
        with patch.object(dependencies.sys, 'version_info', (3, 9)), patch.object(dependencies, 'version') as version:
            report, module = dependencies.inspect_runtime()
        self.assertEqual(report['code'], 'READER_PYTHON_VERSION')
        self.assertIsNone(module)
        version.assert_not_called()

    def test_reports_absent_self_distribution(self):
        with patch.object(dependencies, 'version', side_effect=dependencies.PackageNotFoundError()):
            report, module = dependencies.inspect_runtime()
        self.assertEqual(report['code'], 'READER_PACKAGE_MISSING')
        self.assertIn('executable', report)
        self.assertIsNone(module)

    def test_reports_wrong_version_without_importing_discord(self):
        with patch.object(dependencies, 'version', return_value='2.0.0'), patch.object(dependencies.importlib, 'import_module') as importer:
            report, module = dependencies.inspect_runtime()
        self.assertEqual(report['code'], 'READER_PACKAGE_VERSION')
        self.assertEqual(report['installed'], '2.0.0')
        importer.assert_not_called()

    def test_reports_import_dependency_without_raw_exception_details(self):
        error = ModuleNotFoundError('sensitive details', name='curl_cffi')
        with patch.object(dependencies, 'version', return_value='2.1.0'), patch.object(dependencies.importlib, 'import_module', side_effect=error):
            report, module = dependencies.inspect_runtime()
        self.assertEqual(report['code'], 'READER_IMPORT_FAILED')
        self.assertEqual(report['missingModule'], 'curl_cffi')
        self.assertNotIn('sensitive', str(report))
        self.assertIsNone(module)

    def test_reports_namespace_conflicts(self):
        for discord in [SimpleNamespace(__version__='2.1.0', Client=object), SimpleNamespace(__version__='2.7.0', Client=SimpleNamespace(fetch_user_profile=lambda: None))]:
            with patch.object(dependencies, 'version', return_value='2.1.0'), patch.object(dependencies.importlib, 'import_module', return_value=discord):
                report, module = dependencies.inspect_runtime()
            self.assertEqual(report['code'], 'READER_PACKAGE_CONFLICT')
            self.assertIsNone(module)

    def test_accepts_required_distribution_and_client_method(self):
        discord = SimpleNamespace(__version__='2.1.0', Client=SimpleNamespace(fetch_user_profile=lambda: None))
        with patch.object(dependencies, 'version', return_value='2.1.0'), patch.object(dependencies.importlib, 'import_module', return_value=discord):
            report, module = dependencies.inspect_runtime()
        self.assertEqual(report['code'], 'OK')
        self.assertIs(module, discord)

if __name__ == '__main__':
    unittest.main()
