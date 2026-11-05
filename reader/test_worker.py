import unittest
import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import worker

GUILD='766953289409232896'
ROLE='1470732413112942665'
USER='141947703742562304'
def error(status,code=None):
    e=RuntimeError('sensitive details must not leave the worker');e.status=status;e.code=code;return e
def member():
    return SimpleNamespace(id=int(USER),guild=SimpleNamespace(id=int(GUILD)),roles=[SimpleNamespace(id=int(GUILD)),SimpleNamespace(id=int(ROLE))],bot=False,display_avatar=None)

class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_targeted_queries_never_request_whole_guild_or_presence(self):
        guild=SimpleNamespace(query_members=AsyncMock(return_value=[member()]))
        reply,fatal=await worker.handle(guild,{'id':'1','op':'members','userIds':[USER]})
        self.assertFalse(fatal);self.assertTrue(reply['ok'])
        guild.query_members.assert_awaited_once_with(user_ids=[int(USER)],limit=100,presences=False,cache=False,subscribe=False)
        self.assertEqual(reply['data'][0]['roles'],[GUILD,ROLE])

    async def test_oversized_or_bad_target_lists_are_rejected_before_query(self):
        guild=SimpleNamespace(query_members=AsyncMock())
        for ids in ([],[USER]*101,['bad']):
            reply,fatal=await worker.handle(guild,{'id':'1','op':'members','userIds':ids})
            self.assertEqual(reply['code'],'INVALID_REQUEST');self.assertFalse(fatal)
        guild.query_members.assert_not_awaited()

    async def test_only_explicit_unknown_member_becomes_not_member(self):
        for code,expected in [(10007,'NOT_MEMBER'),(10004,'NOT_FOUND')]:
            guild=SimpleNamespace(fetch_member=AsyncMock(side_effect=error(404,code)))
            reply,fatal=await worker.handle(guild,{'id':'1','op':'member','userId':USER})
            self.assertFalse(fatal);self.assertEqual(reply['code'],expected);self.assertEqual(reply['discordCode'],code)

    async def test_optional_permission_failure_and_auth_verification_differ(self):
        for exc,op,expected,terminal in [(error(403,50013),'role_counts','OPTIONAL_ACCESS',False),(error(403,50001),'member','READER_ACCESS',True),(error(403,40002),'role_counts','READER_VERIFICATION',True),(error(401),'role_counts','READER_AUTH',True)]:
            guild=SimpleNamespace(role_member_counts=AsyncMock(side_effect=exc),fetch_member=AsyncMock(side_effect=exc))
            reply,fatal=await worker.handle(guild,{'id':'1','op':op,'userId':USER})
            self.assertEqual(reply['code'],expected);self.assertEqual(fatal,terminal);self.assertNotIn('sensitive',str(reply))

    async def test_rate_limit_duration_is_preserved(self):
        exc=type('RateLimited',(Exception,),{})();exc.retry_after=180.25
        reply,fatal=await worker.handle(SimpleNamespace(role_member_counts=AsyncMock(side_effect=exc)),{'id':'1','op':'role_counts'})
        self.assertFalse(fatal);self.assertEqual(reply['retryAfterMs'],180250)

    async def test_raw_member_updates_work_for_uncached_members_and_omit_other_content(self):
        packet={'t':'GUILD_MEMBER_UPDATE','d':{'guild_id':GUILD,'user':{'id':USER,'username':'not emitted'},'roles':[ROLE],'bio':'not emitted'}}
        event=worker.member_event(packet,GUILD)
        self.assertEqual(event['event'],'member');self.assertEqual(event['data']['roles'],[GUILD,ROLE]);self.assertNotIn('not emitted',str(event))
        packet['d'].pop('roles');self.assertIsNone(worker.member_event(packet,GUILD))

    async def test_messages_voice_and_other_guilds_are_never_forwarded(self):
        for kind in ('MESSAGE_CREATE','VOICE_STATE_UPDATE','TYPING_START'):
            self.assertIsNone(worker.member_event({'t':kind,'d':{'guild_id':GUILD,'user':{'id':USER},'roles':[ROLE]}},GUILD))
        self.assertIsNone(worker.member_event({'t':'GUILD_MEMBER_UPDATE','d':{'guild_id':'other','user':{'id':USER},'roles':[ROLE]}},GUILD))

    async def test_role_holder_lookup_is_bounded_public_wrapper(self):
        role=SimpleNamespace(fetch_members=AsyncMock(return_value=[member()]*101))
        guild=SimpleNamespace(id=int(GUILD),get_role=lambda _:role)
        reply,fatal=await worker.handle(guild,{'id':'1','op':'role_holders','roleId':ROLE})
        self.assertFalse(fatal);self.assertEqual(len(reply['data']),100);role.fetch_members.assert_awaited_once_with(subscribe=False)

    async def test_full_worker_start_subscribe_targeted_read_and_close_without_network(self):
        guild=SimpleNamespace(id=int(GUILD),name='Arena',member_count=270000,subscribe=AsyncMock(),query_members=AsyncMock(return_value=[member()]))
        class Client:
            def __init__(self,**options): self.user=SimpleNamespace(id=int(USER));self.events={}
            def event(self,handler): self.events[handler.__name__]=handler;return handler
            async def start(self,token,reconnect):
                assert reconnect is False
                await self.events['on_ready']()
                await asyncio.Event().wait()
            def get_guild(self,guild_id): return guild
            async def close(self): pass
        discord=SimpleNamespace(Client=Client,MemberCacheFlags=SimpleNamespace(none=lambda:None))
        output=io.StringIO();stdin=SimpleNamespace(buffer=io.BytesIO((json.dumps({'id':'1','op':'members','userIds':[USER]})+'\n').encode()))
        with patch.object(worker,'PROTOCOL_OUT',output),patch.object(worker.sys,'stdin',stdin):
            await asyncio.wait_for(worker.serve(discord,'fixture-not-for-login',GUILD),timeout=2)
        messages=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(messages[0]['type'],'ready');self.assertTrue(messages[1]['ok']);self.assertEqual(messages[1]['data'][0]['id'],USER)
        guild.subscribe.assert_awaited_once_with(typing=True,activities=False,threads=False,member_updates=True)

    async def test_arena_membership_is_checked_before_reads(self):
        class Client:
            def __init__(self,**options): self.events={}
            def event(self,handler): self.events[handler.__name__]=handler;return handler
            async def start(self,token,reconnect):
                await self.events['on_ready']();await asyncio.Event().wait()
            def get_guild(self,guild_id): return None
            async def close(self): pass
        output=io.StringIO();discord=SimpleNamespace(Client=Client,MemberCacheFlags=SimpleNamespace(none=lambda:None))
        with patch.object(worker,'PROTOCOL_OUT',output):
            await asyncio.wait_for(worker.serve(discord,'fixture-not-for-login',GUILD),timeout=2)
        self.assertEqual(json.loads(output.getvalue()),{'type':'fatal','code':'ARENA_NOT_JOINED'})

if __name__=='__main__':unittest.main()
