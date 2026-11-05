"""Offline dependency check. Never reads credentials or connects to Discord."""
import asyncio
import json
import logging
import sys
from dependencies import inspect_runtime

logging.disable(logging.CRITICAL)

async def check():
    report, discord = inspect_runtime()
    if discord is not None:
        try:
            client = discord.Client(chunk_guilds_at_startup=False,
                                    member_cache_flags=discord.MemberCacheFlags.none(),
                                    guild_subscriptions=False, max_ratelimit_timeout=30.0)
            await client.close()
        except Exception as error:
            report.update(code='READER_IMPORT_FAILED', errorType=type(error).__name__, stage='initialization')
    report['offline_check'] = 'ok' if report['code'] == 'OK' else 'failed'
    print(json.dumps(report), flush=True)
    return 0 if report['code'] == 'OK' else 1

if __name__ == '__main__':
    try:
        sys.exit(asyncio.run(check()))
    except Exception:
        print('READER_DEPENDENCY: Python >=3.10 and discord.py-self==2.1.0 required.', file=sys.stderr)
        sys.exit(1)
