import json
import os
import sys
import time

GUILD='766953289409232896'
ROLE='1470732413112942665'
JAIL='766953289513172995'
A='141947703742562301'
B='141947703742562302'
OUTSIDE='141947703742562303'
token=os.environ.get('READER_TOKEN','')
def emit(value): print(json.dumps(value),flush=True)
def row(user_id,roles=None): return {'id':user_id,'present':True,'roles':roles if roles is not None else [ROLE], 'bot':False,'avatar':None,'at':int(time.time()*1000)}
if any(key in os.environ for key in ('DISCORD_BOT_TOKEN','MONGODB_URI','ENCRYPTION_KEY','FIXTURE_SECRET')) or token in sys.argv:
    emit({'type':'fatal','code':'READER_PROTOCOL'});sys.exit(0)
if token=='fixture-dependency':
    emit({'type':'fatal','code':'READER_PACKAGE_MISSING'});sys.exit(0)
emit({'type':'ready','protocol':1,'guild':{'id':GUILD,'name':'Arena','memberCount':270000},'userId':'141947703742562399'})
for line in sys.stdin:
    req=json.loads(line);op=req['op'];request_id=req['id']
    error={'fixture-auth':'READER_AUTH','fixture-verification':'READER_VERIFICATION','fixture-access':'READER_ACCESS'}.get(token)
    if error:
        emit({'id':request_id,'ok':False,'code':error});sys.exit(0)
    if token=='fixture-rate':
        emit({'id':request_id,'ok':False,'code':'RATE_LIMIT','retryAfterMs':180000});continue
    if token=='fixture-optional' and op=='role_counts':
        emit({'id':request_id,'ok':False,'code':'OPTIONAL_ACCESS','httpStatus':403,'discordCode':50013});continue
    if op=='role': data={'id':req['roleId'],'name':'SNOW'}
    elif op=='role_counts': data={ROLE:2}
    elif op=='role_holders': data=[row(A),row(OUTSIDE,[ROLE,JAIL])]
    elif op=='members':
        data=[row(user_id,[ROLE,JAIL] if user_id==OUTSIDE else [ROLE]) for user_id in req['userIds'] if user_id!=B]
        if token=='fixture-live': emit({'type':'event','event':'member','data':row(A,[])})
    elif op=='member':
        if req['userId']==B:
            emit({'id':request_id,'ok':False,'code':'NOT_MEMBER','httpStatus':404,'discordCode':10007});continue
        data=row(req['userId'])
    else:
        emit({'id':request_id,'ok':False,'code':'INVALID_REQUEST'});continue
    emit({'id':request_id,'ok':True,'data':data})
