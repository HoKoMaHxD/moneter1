"""Safe, offline runtime diagnosis shared by startup and the profile worker."""
import importlib
import re
import sys
from importlib.metadata import PackageNotFoundError, version

REQUIRED = '2.1.0'

def inspect_runtime():
    report = {'python': sys.version.split()[0], 'executable': sys.executable, 'required': REQUIRED}
    if sys.version_info < (3, 10):
        return dict(report, code='READER_PYTHON_VERSION'), None
    try:
        installed = version('discord.py-self')
    except PackageNotFoundError:
        return dict(report, code='READER_PACKAGE_MISSING'), None
    report['installed'] = installed
    if installed != REQUIRED:
        return dict(report, code='READER_PACKAGE_VERSION'), None
    try:
        discord = importlib.import_module('discord')
    except Exception as error:
        report['errorType'] = type(error).__name__
        missing = getattr(error, 'name', '')
        if isinstance(missing, str) and re.fullmatch(r'[A-Za-z0-9_.]{1,100}', missing):
            report['missingModule'] = missing
        return dict(report, code='READER_IMPORT_FAILED'), None
    if getattr(discord, '__version__', None) != REQUIRED or not hasattr(getattr(discord, 'Client', None), 'fetch_user_profile'):
        return dict(report, code='READER_PACKAGE_CONFLICT'), None
    return dict(report, code='OK'), discord
