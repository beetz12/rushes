#!/usr/bin/env python3
"""Dedicated NDJSON fake engine. Never imports or launches capture components."""
import argparse,json,os,socket,threading
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--socket',required=True,type=Path);p.add_argument('--log',required=True,type=Path);args=p.parse_args()
if args.socket.exists():raise SystemExit('Refusing to replace a socket.')
args.socket.parent.mkdir(parents=True,exist_ok=True);os.chmod(args.socket.parent,0o700)
package=args.socket.parent/'stub-recording';package.mkdir(exist_ok=True)
identifier='01J00000000000000000000000';active=False;lock=threading.Lock()
server=socket.socket(socket.AF_UNIX);server.bind(str(args.socket));os.chmod(args.socket,0o600);server.listen()
def client(s):
 global active
 with s,s.makefile('r') as stream:
  for line in stream:
   request=json.loads(line);cmd=request.get('cmd');result=None;error=None
   with lock:
    with args.log.open('a') as f:f.write(json.dumps({'cmd':cmd,'args':request.get('args'),'stub':True})+'\n')
    if cmd=='record.start':
     if active:error={'code':'already-active','message':'A stub recording is active.'}
     else:active=True;result={'id':identifier,'state':'recording','packagePath':str(package)}
    elif cmd=='record.stop':
     if not active:error={'code':'not-recording','message':'No stub recording is active.'}
     else:active=False;result={'id':identifier,'status':'complete','packagePath':str(package)}
    elif cmd=='status':result={'state':'recording' if active else 'idle','stub':True}
    else:error={'code':'unknown-command','message':'Stub supports start/stop/status only.'}
   response={'id':request.get('id'),'ok':error is None,**({'error':error} if error else {'result':result})}
   s.sendall((json.dumps(response)+'\n').encode())
try:
 while True:s,_=server.accept();threading.Thread(target=client,args=(s,),daemon=True).start()
finally:server.close();args.socket.unlink(missing_ok=True)
