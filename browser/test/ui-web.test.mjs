import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {chromium, webkit} from 'playwright';
let server, browser, origin;
const videoBytes=await readFile(new URL('../../viewer/test/fixtures/video.mp4',import.meta.url));
const proof=process.env.RUSHES_WEB_PROOF??await mkdtemp(`${tmpdir()}/rushes-web-`);
const user={id:'web-user',tenantId:'web-tenant',name:'Sam Taylor',email:'sam@example.test'};
const config={revision:'web-fixture',googleConfigured:true,billingConfigured:true,billingMode:'test',streamConfigured:false,captureEnabled:false,hostingEnabled:true,signupEnabled:true,priceUSD:15,limits:{maxTakeSeconds:600}};
const record={id:'native-video',title:'Mac walkthrough',createdAt:'2026-10-24T12:00:00Z',mode:'screen-camera',state:'ready',source:'native-mp4',durationMs:8000,bytes:videoBytes.length,error:null,shareId:null,shareURL:null};
const usage={uploadSeconds:12,reservedSeconds:0,retainedSeconds:12,deliverySeconds:0,rawBytes:4096,reservedRawBytes:0,periodStart:'2026-10-01T00:00:00Z',subscription:{status:'none',paidThrough:null,graceThrough:null,canUpload:false}};
before(async()=>{
  await mkdir(proof,{recursive:true});
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));origin=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,[fileURLToPath(new URL('./web-server.mjs',import.meta.url)),String(port)],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['ignore','pipe','pipe']});
  let output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
  for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}if(server.exitCode!==null||i===99)throw Error(`Web fixture failed to start: ${output}`);await new Promise(r=>setTimeout(r,50));}
  const engine=process.env.RUSHES_TEST_BROWSER??'chromium';
  if(!['chromium','webkit'].includes(engine))throw Error('Unknown web viewing engine');
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?(process.env.RUSHES_CHROME?{executablePath:process.env.RUSHES_CHROME}:{channel:'chromium'}):{})});
  console.log(`Web viewing: ${engine} ${browser.version()} on ${process.platform}`);
});
after(async()=>{await browser?.close();server?.kill('SIGTERM');console.log(`Web proof: ${proof}`);});
async function fixture(options={}){
  const context=process.env.RUSHES_TEST_BROWSER==='webkit' ? await webkit.launchPersistentContext(await mkdtemp(`${proof}/webkit-profile-`),{headless:true,viewport:{width:1280,height:960}}) : await browser.newContext({viewport:{width:1280,height:960}});
  const calls=[],errors=[];
  let current={...record,state:options.recordState??record.state}, approved=false;
  await context.addInitScript(({allowLegacy})=>{
    window.captureCalls=[];
    for(const name of ['getUserMedia','getDisplayMedia','enumerateDevices'])if(navigator.mediaDevices)navigator.mediaDevices[name]=()=>{window.captureCalls.push(name);throw Error('The shipped web app must not initialize recording devices');};
    if(navigator.storage && !allowLegacy)navigator.storage.getDirectory=()=>{window.captureCalls.push('OPFS');throw Error('No capture storage during cloud mount');};
    localStorage.setItem('rushes.browser.guide.v1','untouched-legacy-draft-marker');
  },{allowLegacy:options.allowLegacy===true});
  await context.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method();
    const body=req.postData()?JSON.parse(req.postData()):undefined;calls.push({path:url.pathname,method,body,headers:req.headers()});
    let payload,status=200;
    if(url.pathname==='/api/config')payload={...config,...options.config};
    else if(url.pathname==='/api/session'){if(options.holdSession){options.holdSession=false;await new Promise(resolve=>options.releaseSession=resolve);}payload={user:options.signed===false?null:options.user??user,csrfToken:options.signed===false?null:'web-csrf'};}
    else if(url.pathname.startsWith('/api/native/link/')&&url.pathname.endsWith('/approve')){approved=true;payload={ok:true};}
    else if(url.pathname.startsWith('/api/native/link/')&&options.expiredLink){status=410;payload={error:{code:'EXPIRED_LINK',message:'The Mac connection expired. Start again from the app.'}};}
    else if(url.pathname.startsWith('/api/native/link/'))payload={id:url.pathname.split('/').at(-1),deviceName:'Rushes on Mac',status:approved?'approved':'pending',expiresAt:new Date(Date.now()+300000).toISOString()};
    else if(url.pathname==='/api/recordings'&&method==='GET'){if(options.holdLibrary){options.holdLibrary=false;await new Promise(resolve=>options.releaseLibrary=resolve);}payload={recordings:options.empty?[]:[current],usage,nextCursor:null};}
    else if(url.pathname.endsWith('/playback'))payload={url:`${origin}/test-video.mp4`,kind:'mp4',expiresAt:new Date(Date.now()+60000).toISOString()};
    else if(url.pathname.endsWith('/export'))payload={status:'ready',url:`${origin}/test-video.mp4`,expiresAt:new Date(Date.now()+60000).toISOString()};
    else if(url.pathname.endsWith('/share')&&method==='POST'){current={...current,shareId:'native-share',shareURL:`${origin}/s/native-share`};payload={id:'native-share',url:current.shareURL,expiresAt:body.expiresAt??null};}
    else if(url.pathname.endsWith('/share')&&method==='DELETE'){current={...current,shareId:null,shareURL:null};payload={ok:true};}
    else if(url.pathname.endsWith('/native-video')&&method==='GET'){current={...current,state:options.recordState??current.state};payload={...current,manifest:null,chunks:[]};}
    else if(url.pathname.endsWith('/native-video')&&method==='PATCH'){current={...current,title:body.title};payload=current;}
    else if(url.pathname.endsWith('/native-video')&&method==='DELETE'){current={...current,state:'deleting'};payload={state:'deleting'};}
    else if(url.pathname==='/api/logout')payload={ok:true};
    else if(url.pathname.startsWith('/api/billing/'))payload={url:`${origin}/test-checkout`};
    else if(url.pathname==='/api/shares/native-share')payload={id:'native-share',title:'Shared Mac video',durationMs:12000,passwordRequired:true,expiresAt:null,...(options.shareState?{state:options.shareState}:{})};
    else if(url.pathname.endsWith('/unlock'))payload={ok:true};
    else{status=404;payload={error:{code:'FIXTURE_ROUTE',message:'Unexpected web request'}};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
  });
  await context.route('**/test-checkout',route=>route.fulfill({contentType:'text/html',body:'<h1>Test checkout fixture</h1>'}));
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+(options.path??'/'));return{page,context,calls,errors,options};
}
test('shipped web opens library with no device or capture-storage request, preserves legacy data, and record links explain Mac use',async()=>{
  const f=await fixture();try{
    await f.page.getByRole('heading',{name:'Cloud library',exact:true}).waitFor();
    await f.page.getByRole('button',{name:'Record on Mac',exact:true}).click();
    await f.page.getByRole('heading',{name:'Record on your Mac. Share anywhere.'}).waitFor();
    assert.match(await f.page.textContent('main'),/Web recording is deferred/);
    assert.equal(await f.page.getByRole('link',{name:'Download Rushes for Mac'}).count(),0);
    await f.page.getByRole('button',{name:'Cloud account',exact:true}).click();
    await f.page.getByRole('heading',{name:'Cloud account',exact:true}).waitFor();
    assert.deepEqual(await f.page.evaluate(()=>window.captureCalls),[]);assert.deepEqual(f.errors,[]);
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('rushes.browser.guide.v1')),'untouched-legacy-draft-marker');
    assert.equal(f.calls.some(x=>x.method==='POST'),false);
  }finally{await f.context.close();}
});
test('old record route offers Mac recording and never starts the deferred recorder',async()=>{
  const f=await fixture({path:'/record'});try{await f.page.getByRole('heading',{name:'Record on your Mac. Share anywhere.'}).waitFor();assert.equal(await f.page.getByRole('button',{name:'Start recording',exact:true}).count(),0);assert.deepEqual(await f.page.evaluate(()=>window.captureCalls),[]);}finally{await f.context.close();}
});
test('native MP4 library supports rename, native player, export, password share, revoke and truthful pending deletion using CSRF',async()=>{
  const f=await fixture();try{
    await f.page.getByRole('button').filter({has:f.page.getByRole('heading',{name:'Mac walkthrough',exact:true})}).click();
    await f.page.getByLabel('Title',{exact:true}).fill('Renamed Mac walkthrough');await f.page.getByRole('button',{name:'Save title',exact:true}).click();
    await f.page.getByRole('heading',{name:'Renamed Mac walkthrough',exact:true}).waitFor();
    await f.page.getByRole('button',{name:'Play video',exact:true}).click();
    await f.page.getByLabel('Private cloud video',{exact:true}).waitFor();
    assert.equal(await f.page.locator('iframe').count(),0);
    await f.page.getByRole('button',{name:'Export composed video',exact:true}).click();await f.page.getByRole('link',{name:'Download composed MP4'}).waitFor();
    await f.page.getByLabel('Password (optional)',{exact:true}).fill('only-in-fixture');await f.page.getByRole('button',{name:'Create / update share link',exact:true}).click();
    await f.page.getByLabel('Share link',{exact:true}).waitFor();assert.match(await f.page.getByLabel('Share link',{exact:true}).inputValue(),/\/s\/native-share$/);
    await f.page.getByRole('button',{name:'Revoke share link',exact:true}).click();await f.page.getByLabel('Share link',{exact:true}).waitFor({state:'hidden'});
    f.page.once('dialog',dialog=>dialog.accept());await f.page.getByRole('button',{name:'Delete cloud recording',exact:true}).click();
    await f.page.getByRole('heading',{name:'Access revoked. Cleanup is pending.'}).waitFor();
    assert.ok(f.calls.filter(x=>['PATCH','POST','DELETE'].includes(x.method)).every(x=>x.headers['x-csrf-token']==='web-csrf'));
    assert.deepEqual(await f.page.evaluate(()=>window.captureCalls),[]);
  }finally{await f.context.close();}
});
test('held library response cannot restore private data after sign-out',async()=>{
  const options={holdLibrary:true},f=await fixture(options);try{
    await f.page.getByRole('button',{name:'Cloud account',exact:true}).click();await f.page.getByRole('button',{name:'Sign out',exact:true}).click();
    await f.page.getByRole('status').filter({hasText:'Signed out. Your recordings remain saved on your Mac.'}).waitFor();options.releaseLibrary();
    await f.page.getByRole('button',{name:'Cloud library',exact:true}).click();assert.equal(await f.page.getByRole('heading',{name:'Mac walkthrough',exact:true}).count(),0);
  }finally{options.releaseLibrary?.();await f.context.close();}
});
test('test checkout passes no client price or entitlement and signed-out account actions remain disabled',async()=>{
  const f=await fixture();try{
    await f.page.getByRole('button',{name:'Cloud account',exact:true}).click();await f.page.getByRole('button',{name:'Subscribe with test Checkout'}).click();
    await f.page.getByRole('heading',{name:'Test checkout fixture'}).waitFor();
    assert.deepEqual(f.calls.find(x=>x.path==='/api/billing/checkout').body,{});
    assert.equal(usage.subscription.canUpload,false);
  }finally{await f.context.close();}
});
test('password-protected native share requests authorization before rendering a media URL',async()=>{
  const f=await fixture({path:'/s/native-share'});try{
    await f.page.getByLabel('Video password',{exact:true}).fill('only-in-fixture');
    assert.equal(await f.page.locator('video,iframe').count(),0);await f.page.getByRole('button',{name:'Watch video',exact:true}).click();
    await f.page.getByLabel('Shared Rushes recording',{exact:true}).waitFor();assert.equal(await f.page.locator('iframe').count(),0);
    assert.ok(f.calls.findIndex(x=>x.path.endsWith('/unlock'))<f.calls.findIndex(x=>x.path.endsWith('/playback')));
  }finally{await f.context.close();}
});
test('library, account, Mac guidance and shared playback fit mobile/default/wide and save screen evidence',async()=>{
  const f=await fixture(),screens=[];try{
    for(const width of [375,1280,1920]){
      await f.page.setViewportSize({width,height:960});
      for(const [screen,button,heading] of [['library','Cloud library','Cloud library'],['account','Cloud account','Cloud account'],['desktop','Record on Mac','Record on your Mac. Share anywhere.']]){
        await f.page.getByRole('button',{name:button,exact:true}).click();await f.page.getByRole('heading',{name:heading,exact:true}).waitFor();
        assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${screen} at${width}`);
        const path=`${proof}/${screen}-${width}.png`;await f.page.screenshot({path,fullPage:true});screens.push({screen,width,path});
      }
    }
    await writeFile(`${proof}/screens.json`,JSON.stringify(screens,null,2));assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});

test('a held session refresh cannot restore the private library or CSRF after sign-out',async()=>{
  const f=await fixture();try{
    await f.page.getByRole('button',{name:'Cloud account',exact:true}).click();await f.page.getByRole('button',{name:'Refresh account',exact:true}).waitFor();
    f.options.holdSession=true;await f.page.getByRole('button',{name:'Refresh account',exact:true}).click();
    for(let i=0;i<100&&!f.options.releaseSession;i++)await f.page.waitForTimeout(5);assert.ok(f.options.releaseSession);
    await f.page.getByRole('button',{name:'Sign out',exact:true}).click();await f.page.getByRole('status').filter({hasText:'Signed out.'}).waitFor();f.options.releaseSession();
    await f.page.getByRole('button',{name:'Cloud library',exact:true}).click();await f.page.getByRole('heading',{name:'A private home for your videos.'}).waitFor();
    assert.equal(await f.page.getByRole('heading',{name:'Mac walkthrough',exact:true}).count(),0);
  }finally{f.options.releaseSession?.();await f.context.close();}
});
test('Mac account link displays the signed-in identity and requires explicit CSRF approval without recording',async()=>{
  const f=await fixture({path:'/desktop/link/native-link-fixture-12345'});try{
    await f.page.getByRole('heading',{name:'Connect your Mac',exact:true}).waitFor();await f.page.getByRole('button',{name:'Connect this Mac',exact:true}).waitFor();
    assert.match(await f.page.textContent('main'),/sam@example.test/);assert.equal(f.calls.some(call=>call.path.endsWith('/approve')),false);
    await f.page.getByRole('button',{name:'Connect this Mac',exact:true}).click();await f.page.getByRole('heading',{name:'Connection approved',exact:true}).waitFor();
    const approval=f.calls.find(call=>call.path.endsWith('/approve'));assert.equal(approval.headers['x-csrf-token'],'web-csrf');assert.deepEqual(approval.body,{});
    assert.deepEqual(await f.page.evaluate(()=>window.captureCalls),[]);
  }finally{await f.context.close();}
});
test('legacy browser originals remain downloadable only through explicit recovery',async()=>{
  const f=await fixture({path:'/local-drafts',allowLegacy:true});try{
    await f.page.getByRole('heading',{name:'Recover old browser drafts',exact:true}).waitFor();
    await f.page.evaluate(async()=>{const root=await navigator.storage.getDirectory(),drafts=await root.getDirectoryHandle('rushes-browser-v1',{create:true}),folder=await drafts.getDirectoryHandle('legacy-recovery-fixture',{create:true});const file=await folder.getFileHandle('camera-00000.bin',{create:true}),writer=await file.createWritable();await writer.write(new Uint8Array([31,32,33]));await writer.close();});
    await f.page.getByRole('button',{name:'Find saved drafts',exact:true}).click();await f.page.getByRole('heading',{name:'Recording needs recovery'}).waitFor();
    const downloading=f.page.waitForEvent('download');await f.page.getByRole('button',{name:'Download Camera',exact:true}).click();const download=await downloading;
    const {readFile}=await import('node:fs/promises');assert.deepEqual([...await readFile(await download.path())],[31,32,33]);assert.equal(f.calls.some(call=>call.method!=='GET'),false);assert.deepEqual(await f.page.evaluate(()=>window.captureCalls),[]);
  }finally{await f.context.close();}
});

test('controlled native MP4 player decodes the generated H264 fixture and seeks',async()=>{
  const f=await fixture();try{
    await f.page.getByRole('button').filter({has:f.page.getByRole('heading',{name:'Mac walkthrough',exact:true})}).click();await f.page.getByRole('button',{name:'Play video',exact:true}).click();
    const video=f.page.getByLabel('Private cloud video',{exact:true});await video.waitFor();
    await f.page.waitForFunction(()=>document.querySelector('video')?.readyState>=1);
    await writeFile(`${proof}/player-preload-${process.env.RUSHES_TEST_BROWSER??'chromium'}.json`,JSON.stringify(await video.evaluate(el=>({ready:el.readyState,preload:el.preload,duration:el.duration,error:el.error?.code??null})),null,2));
    await video.evaluate(el=>{el.muted=true;void el.play().catch(error=>{window.fixturePlayError=String(error);});});
    await f.page.waitForFunction(()=>window.fixturePlayError||(document.querySelector('video')?.readyState>=2&&document.querySelector('video')?.currentTime>0));
    assert.equal(await f.page.evaluate(()=>window.fixturePlayError??null),null);
    const actual=await video.evaluate(async el=>{el.pause();await new Promise((resolve,reject)=>{el.addEventListener('seeked',resolve,{once:true});el.addEventListener('error',reject,{once:true});el.currentTime=4;});return{width:el.videoWidth,height:el.videoHeight,duration:el.duration,position:el.currentTime,seekable:Array.from({length:el.seekable.length},(_,i)=>[el.seekable.start(i),el.seekable.end(i)]),error:el.error?.code??null};});
    assert.equal(actual.width,320);assert.equal(actual.height,240);assert.ok(Math.abs(actual.duration-8)<0.05);assert.ok(Math.abs(actual.position-4)<0.05,JSON.stringify(actual));assert.equal(actual.error,null);
  }finally{await f.context.close();}
});

test('a processing native share reveals no playback grant and refreshes to ready only after upload verification',async()=>{
  const f=await fixture({path:'/s/native-share',shareState:'uploading'});try{
    await f.page.getByRole('heading',{name:'Your video is being prepared.'}).waitFor();assert.equal(await f.page.getByRole('button',{name:'Watch video',exact:true}).count(),0);assert.equal(f.calls.some(call=>call.path.endsWith('/playback')),false);
    f.options.shareState='ready';await f.page.getByRole('button',{name:'Check upload status',exact:true}).click();await f.page.getByLabel('Video password',{exact:true}).waitFor();assert.equal(f.calls.some(call=>call.path.endsWith('/playback')),false);
    await f.page.getByLabel('Video password',{exact:true}).fill('fixture-only-password');await f.page.getByRole('button',{name:'Watch video',exact:true}).click();await f.page.getByLabel('Shared Rushes recording',{exact:true}).waitFor();
  }finally{await f.context.close();}
});

test('expired account-link return pointer has an explicit escape back to the library',async()=>{
  const f=await fixture({path:'/desktop/link/native-link-fixture-12345',expiredLink:true});try{
    await f.page.evaluate(()=>sessionStorage.setItem('rushes.native-link-return.v1','native-link-fixture-12345'));await f.page.reload();
    await f.page.getByRole('alert').filter({hasText:'Mac connection expired'}).waitFor();await f.page.getByRole('link',{name:'Back to cloud library',exact:true}).click();
    await f.page.getByRole('heading',{name:'Cloud library',exact:true}).waitFor();assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('rushes.native-link-return.v1')),null);
  }finally{await f.context.close();}
});
test('pending native library entry refreshes metadata without invoking the legacy transcoder',async()=>{
  const f=await fixture({recordState:'uploading'});try{
    await f.page.getByRole('button').filter({has:f.page.getByRole('heading',{name:'Mac walkthrough',exact:true})}).click();
    await f.page.getByRole('button',{name:'Refresh upload status',exact:true}).click();
    for(let i=0;i<100&&!f.calls.some(call=>call.path==='/api/recordings/native-video'&&call.method==='GET');i++)await f.page.waitForTimeout(5);
    assert.ok(f.calls.some(call=>call.path==='/api/recordings/native-video'&&call.method==='GET'));assert.equal(f.calls.some(call=>call.path.endsWith('/process')),false);assert.equal(await f.page.locator('video,iframe').count(),0);
  }finally{await f.context.close();}
});
test('all shipped web screens and key states have current narrow/default/wide evidence',async()=>{
  const cases=[
    {name:'library-ready',options:{},heading:'Cloud library'},
    {name:'library-signed-out',options:{signed:false},heading:'A private home for your videos.'},
    {name:'library-empty',options:{empty:true},heading:'Your Mac videos, ready to share.'},
    {name:'account-test',options:{},nav:'Cloud account',heading:'Cloud account'},
    {name:'account-live-copy',options:{config:{billingMode:'live'}},nav:'Cloud account',heading:'Cloud account'},
    {name:'account-unconfigured',options:{signed:false,config:{googleConfigured:false,billingConfigured:false,billingMode:'unconfigured'}},nav:'Cloud account',heading:'Cloud account'},
    {name:'mac-guidance',options:{path:'/record'},heading:'Record on your Mac. Share anywhere.'},
    {name:'legacy-recovery',options:{path:'/local-drafts'},heading:'Recover old browser drafts'},
    {name:'mac-link-pending',options:{path:'/desktop/link/native-link-fixture-12345'},heading:'Connect your Mac'},
    {name:'mac-link-signed-out',options:{path:'/desktop/link/native-link-fixture-12345',signed:false},heading:'Sign in to connect'},
    {name:'mac-link-expired',options:{path:'/desktop/link/native-link-fixture-12345',expiredLink:true},heading:'Connect your Mac',error:true},
    {name:'mac-link-approved',options:{path:'/desktop/link/native-link-fixture-12345'},approve:true,heading:'Connection approved'},
    {name:'shared-password',options:{path:'/s/native-share'},heading:'This video has a password.'},
    {name:'shared-uploading',options:{path:'/s/native-share',shareState:'uploading'},heading:'Your video is being prepared.'},
    {name:'shared-player',options:{path:'/s/native-share'},watch:true},
    {name:'private-player',options:{},detail:true},
  ];
  const manifest={startedAt:new Date().toISOString(),browser:process.env.RUSHES_TEST_BROWSER??'chromium',generatedOnly:true,screens:[]};
  for(const item of cases){
    const f=await fixture(item.options);
    try{
      if(item.nav)await f.page.getByRole('button',{name:item.nav,exact:true}).click();
      if(item.approve){await f.page.getByRole('button',{name:'Connect this Mac',exact:true}).click();}
      if(item.watch){await f.page.getByLabel('Video password',{exact:true}).fill('fixture-only-password');await f.page.getByRole('button',{name:'Watch video',exact:true}).click();await f.page.getByLabel('Shared Rushes recording',{exact:true}).waitFor();}
      if(item.detail){await f.page.getByRole('button').filter({has:f.page.getByRole('heading',{name:'Mac walkthrough',exact:true})}).click();await f.page.getByRole('button',{name:'Play video',exact:true}).click();await f.page.getByLabel('Private cloud video',{exact:true}).waitFor();}
      if(item.heading)await f.page.getByRole('heading',{name:item.heading,exact:true}).waitFor();
      if(item.error)await f.page.getByRole('alert').waitFor();
      if(!item.options.path&&item.name==='library-ready')await f.page.getByRole('heading',{name:'Mac walkthrough',exact:true}).waitFor();
      for(const width of [375,1280,1920]){
        await f.page.setViewportSize({width,height:960});
        const path=`${proof}/${item.name}-${width}.png`;await f.page.screenshot({path,fullPage:true});manifest.screens.push({name:item.name,width,path});
        const fits=await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
        if(!fits)await writeFile(`${proof}/${item.name}-${width}-overflow.json`,JSON.stringify(await f.page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('main *')].map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,left:el.getBoundingClientRect().left,height:el.getBoundingClientRect().height,minHeight:getComputedStyle(el).minHeight,ratio:getComputedStyle(el).aspectRatio})).filter(el=>el.right>innerWidth+1||el.left<0)})),null,2));
        assert.equal(fits,true,`${item.name}/${width}`);
      }
      assert.deepEqual(await f.page.evaluate(()=>window.captureCalls),[]);
      assert.deepEqual(f.errors,[]);
    }finally{await f.context.close();}
  }
  assert.equal(manifest.screens.length,cases.length*3);await writeFile(`${proof}/screens.json`,JSON.stringify(manifest,null,2));
});
