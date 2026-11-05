"""One discord.py-self session for targeted Arena member reads and role events.

No bulk guild roster, message history, activity tracking, token rotation,
CAPTCHA solving, proxy management or application-managed re-login loop.
"""
import asyncio
import json
import logging
import math
import os
import queue
import re
import sys
import threading
import time
import warnings
from dependencies import inspect_runtime

PROTOCOL_OUT = sys.stdout
logging.disable(logging.CRITICAL)
warnings.filterwarnings('ignore')
OPS = {'role', 'role_counts', 'role_holders', 'members', 'member'}
OPTIONAL = {'role_counts', 'role_holders'}

def emit(value):
    PROTOCOL_OUT.write(json.dumps(value, separators=(',', ':')) + '\n')
    PROTOCOL_OUT.flush()

def snowflake(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9]{17,20}', value) is not None

def classify(error, op=None):
    status, code, name = getattr(error, 'status', None), getattr(error, 'code', None), type(error).__name__
    if code == 40002 or name == 'CaptchaRequired': return 'READER_VERIFICATION', True
    if status == 401 or name == 'LoginFailure' or (name == 'ConnectionClosed' and code in (4003, 4004)): return 'READER_AUTH', True
    if status == 403: return ('OPTIONAL_ACCESS', False) if op in OPTIONAL else ('READER_ACCESS', True)
    if status == 429 or name == 'RateLimited': return 'RATE_LIMIT', False
    if status == 404: return ('NOT_MEMBER' if code == 10007 and op == 'member' else 'NOT_FOUND'), False
    if isinstance(error, (asyncio.TimeoutError, ConnectionError, OSError)): return 'NETWORK', False
    return 'UNAVAILABLE', False

def member_record(member, at):
    avatar = getattr(member, 'display_avatar', None)
    return {'id': str(member.id), 'present': True,
            'roles': [str(role.id) for role in member.roles],
            'bot': bool(member.bot), 'avatar': str(avatar.url) if avatar else None, 'at': at}

def member_event(packet, guild_id):
    """Allowlist data before crossing IPC; ignore all message/voice payloads."""
    if isinstance(packet, str):
        try: packet = json.loads(packet)
        except (ValueError, TypeError): return None
    if not isinstance(packet, dict): return None
    kind, data = packet.get('t'), packet.get('d')
    if not isinstance(data, dict) or str(data.get('guild_id')) != guild_id: return None
    if kind == 'GUILD_ROLE_DELETE' and snowflake(str(data.get('role_id'))):
        return {'type': 'event', 'event': 'role_delete', 'roleId': str(data['role_id'])}
    if kind not in ('GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE'): return None
    user = data.get('user')
    if not isinstance(user, dict) or not snowflake(str(user.get('id'))): return None
    present = kind != 'GUILD_MEMBER_REMOVE'
    roles = data.get('roles') if present else []
    if not isinstance(roles, list) or len(roles) > 250 or any(not snowflake(str(x)) for x in roles): return None
    avatar_hash = user.get('avatar')
    avatar = f"https://cdn.discordapp.com/avatars/{user['id']}/{avatar_hash}.png?size=128" if isinstance(avatar_hash, str) and re.fullmatch(r'(?:a_)?[0-9a-f]{32}', avatar_hash) else None
    normalized_roles = list(dict.fromkeys(([guild_id] if present else []) + [str(x) for x in roles]))
    record = {'id': str(user['id']), 'present': present, 'roles': normalized_roles, 'at': int(time.time() * 1000)}
    if isinstance(user.get('bot'), bool): record['bot'] = user['bot']
    if avatar: record['avatar'] = avatar
    return {'type': 'event', 'event': 'member', 'data': record}

async def execute(guild, request, at):
    op = request['op']
    if op == 'role':
        role = await guild.fetch_role(int(request['roleId']))
        return {'id': str(role.id), 'name': role.name[:100]}
    if op == 'role_counts':
        return {str(role.id): count for role, count in (await guild.role_member_counts()).items()}
    if op == 'role_holders':
        if int(request['roleId']) == guild.id: return []
        role = guild.get_role(int(request['roleId'])) or await guild.fetch_role(int(request['roleId']))
        members = await role.fetch_members(subscribe=False)
        return [member_record(member, at) for member in members[:100]]
    if op == 'members':
        members = await guild.query_members(user_ids=[int(x) for x in request['userIds']], limit=100,
                                             presences=False, cache=False, subscribe=False)
        wanted = set(request['userIds'])
        return [member_record(member, at) for member in members if str(member.id) in wanted]
    if op == 'member':
        return member_record(await guild.fetch_member(int(request['userId'])), at)
    raise ValueError()

async def handle(guild, request):
    request_id, op = request.get('id'), request.get('op')
    valid = isinstance(request_id, str) and 0 < len(request_id) <= 30 and op in OPS
    if op in ('role', 'role_holders'): valid = valid and snowflake(request.get('roleId'))
    if op == 'member': valid = valid and snowflake(request.get('userId'))
    if op == 'members':
        ids = request.get('userIds')
        valid = valid and isinstance(ids, list) and 1 <= len(ids) <= 100 and all(snowflake(x) for x in ids)
    if not valid: return {'id': request_id, 'ok': False, 'code': 'INVALID_REQUEST'}, False
    try:
        timeout = request.get('timeoutMs', 30000)
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout): timeout = 30000
        data = await asyncio.wait_for(execute(guild, request, int(time.time() * 1000)), timeout=max(.001, min(30, timeout / 1000)))
        return {'id': request_id, 'ok': True, 'data': data}, False
    except Exception as error:
        code, fatal = classify(error, op)
        reply = {'id': request_id, 'ok': False, 'code': code}
        status, discord_code = getattr(error, 'status', None), getattr(error, 'code', None)
        if isinstance(status, int) and 100 <= status <= 599: reply['httpStatus'] = status
        if isinstance(discord_code, int) and 0 < discord_code < 1000000: reply['discordCode'] = discord_code
        retry_after = getattr(error, 'retry_after', None)
        if code == 'RATE_LIMIT' and isinstance(retry_after, (int, float)) and math.isfinite(retry_after) and retry_after > 0:
            reply['retryAfterMs'] = math.ceil(retry_after * 1000)
        return reply, fatal

async def serve(discord, token, guild_id):
    ready = asyncio.Event()
    cooldown_until = 0.0
    client = discord.Client(chunk_guilds_at_startup=False, member_cache_flags=discord.MemberCacheFlags.none(),
                            guild_subscriptions=False, max_messages=None, enable_debug_events=True,
                            max_ratelimit_timeout=30.0)
    @client.event
    async def on_ready(): ready.set()
    @client.event
    async def on_socket_raw_receive(packet):
        nonlocal cooldown_until
        parsed = packet
        if isinstance(parsed, str):
            try: parsed = json.loads(parsed)
            except ValueError: return
        if not isinstance(parsed, dict): return
        data = parsed.get('d')
        if parsed.get('t') in ('RATE_LIMITED', 'RATE_LIMIT') and isinstance(data, dict) and data.get('opcode') == 8:
            delay = data.get('retry_after')
            if isinstance(delay, (int, float)) and math.isfinite(delay) and delay > 0:
                cooldown_until = max(cooldown_until, time.monotonic() + delay)
                emit({'type': 'event', 'event': 'rate_limit', 'retryAfterMs': math.ceil(delay * 1000)})
            return
        event = member_event(parsed, guild_id)
        if event: emit(event)
    runner = asyncio.create_task(client.start(token, reconnect=False))
    ready_wait = asyncio.create_task(ready.wait())
    try:
        done, _ = await asyncio.wait({runner, ready_wait}, timeout=45, return_when=asyncio.FIRST_COMPLETED)
        if runner in done:
            try: await runner
            except Exception as error:
                code, fatal = classify(error)
                emit({'type': 'fatal', 'code': code if fatal else 'READER_STARTUP'})
            else: emit({'type': 'fatal', 'code': 'READER_STARTUP'})
            return
        if not ready.is_set():
            emit({'type': 'fatal', 'code': 'READER_STARTUP'}); return
        guild = client.get_guild(int(guild_id))
        if guild is None:
            emit({'type': 'fatal', 'code': 'ARENA_NOT_JOINED'}); return
        await guild.subscribe(typing=True, activities=False, threads=False, member_updates=True)
        emit({'type': 'ready', 'protocol': 1, 'guild': {'id': guild_id, 'name': guild.name[:100], 'memberCount': guild.member_count}, 'userId': str(client.user.id)})
        inbox = queue.Queue(maxsize=3)
        def read_input():
            while True:
                raw = sys.stdin.buffer.readline(8193)
                inbox.put(raw)
                if not raw or len(raw) > 8192: return
        threading.Thread(target=read_input, daemon=True).start()
        last_request = 0.0
        while not runner.done():
            try: raw = inbox.get_nowait()
            except queue.Empty:
                await asyncio.sleep(.05); continue
            if not raw: return
            if len(raw) > 8192:
                emit({'type': 'fatal', 'code': 'READER_PROTOCOL'}); return
            try:
                request = json.loads(raw)
                if not isinstance(request, dict): raise ValueError()
            except (ValueError, TypeError):
                emit({'type': 'fatal', 'code': 'READER_PROTOCOL'}); return
            if time.monotonic() < cooldown_until:
                emit({'id': request.get('id'), 'ok': False, 'code': 'RATE_LIMIT', 'retryAfterMs': math.ceil((cooldown_until-time.monotonic())*1000)}); continue
            await asyncio.sleep(max(0, last_request + 1.0 - time.monotonic()))
            if time.monotonic() < cooldown_until:
                emit({'id': request.get('id'), 'ok': False, 'code': 'RATE_LIMIT', 'retryAfterMs': math.ceil((cooldown_until-time.monotonic())*1000)}); continue
            last_request = time.monotonic()
            reply, fatal = await handle(guild, request)
            emit(reply)
            if fatal:
                emit({'type': 'fatal', 'code': reply['code']}); return
        try: await runner
        except Exception as error:
            code, fatal = classify(error)
            emit({'type': 'fatal', 'code': code if fatal else 'READER_CLOSED'})
        else: emit({'type': 'fatal', 'code': 'READER_CLOSED'})
    finally:
        ready_wait.cancel()
        await client.close()
        if not runner.done(): runner.cancel()
        await asyncio.gather(runner, ready_wait, return_exceptions=True)

def main():
    sys.stdout = open(os.devnull, 'w'); sys.stderr = open(os.devnull, 'w')
    token, guild_id = os.environ.get('READER_TOKEN', '').strip(), os.environ.get('ARENA_GUILD_ID', '').strip()
    if not token or not snowflake(guild_id):
        emit({'type': 'fatal', 'code': 'READER_NOT_CONFIGURED'}); return
    report, discord = inspect_runtime()
    if discord is None:
        emit({'type': 'fatal', 'code': report['code']}); return
    try: asyncio.run(serve(discord, token, guild_id))
    except BaseException: emit({'type': 'fatal', 'code': 'READER_CLOSED'})

if __name__ == '__main__': main()
