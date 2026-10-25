// Owned HTTP fixture: WebKit's network media loader needs real Range responses.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer as createViteServer} from 'vite';
const port=Number(process.argv[2]);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('A bounded fixture port is required.');
const media=await readFile(new URL('../../viewer/test/fixtures/video.mp4',import.meta.url));
let vite;
const server=createServer((request,response)=>{
  if(new URL(request.url,'http://fixture.test').pathname==='/test-video.mp4'){
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    const range=request.headers.range,match=range?.match(/^bytes=(\d*)-(\d*)$/);
    let first=0,last=media.length-1;
    if(match){
      if(!match[1])first=Math.max(0,media.length-Number(match[2]));
      else{first=Number(match[1]);if(match[2])last=Math.min(last,Number(match[2]));}
    }
    if(range&&(!match||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||first>last||first>=media.length||(!match[1]&&!Number(match[2])))){
      response.writeHead(416,{'Content-Range':`bytes */${media.length}`});response.end();return;
    }
    response.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':String(last-first+1),'Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${first}-${last}/${media.length}`}:{})});
    response.end(request.method==='HEAD'?undefined:media.subarray(first,last+1));return;
  }
  vite.middlewares(request,response,()=>{response.writeHead(404);response.end();});
});
vite=await createViteServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{middlewareMode:true,hmr:{server}},appType:'spa'});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
console.log('WEB_FIXTURE_READY');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(closing)return;closing=true;
  void vite.close().then(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})).then(()=>process.exit(0),()=>process.exit(1));
});
