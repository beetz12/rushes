#!/usr/bin/env node
// Real installed OS/device capture, explicit exercise only. No cloud upload.
import assert from 'node:assert/strict';
import {parseArgs, promisify} from 'node:util';
import {execFile, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, mkdtemp, realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname, join, resolve, relative, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {tree, executableContent} from './update-acceptance/policy.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {requiredPhysicalRoles, inspectPhysicalDecode, inspectPhysicalSelection, inspectOnsets, risingEdges, codedTonePoints} from './recording-acceptance/physical-oracle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {values} = parseArgs({options:{exercise:{type:'boolean'},recheck:{type:'boolean'},'calibration-only':{type:'boolean'},'signal-only':{type:'boolean'},'allow-local-physical':{type:'boolean'},'input-override':{type:'boolean'},'evidence-root':{type:'string'},app:{type:'string'},'source-proof':{type:'string'},ffmpeg:{type:'string'},ffprobe:{type:'string'}},strict:true});
assert(values['evidence-root'] && !!values.exercise !== !!values.recheck, 'Select explicit --exercise or readonly --recheck, and --evidence-root');
assert(!values.exercise || values['source-proof'], 'Exercise requires the existing passing --source-proof');
const evidence = resolve(values['evidence-root']);
const tools = {ffmpeg:values.ffmpeg ?? '/opt/homebrew/bin/ffmpeg',ffprobe:values.ffprobe ?? '/opt/homebrew/bin/ffprobe'};
const execute = promisify(execFile);
let report = {schema:'rushes.installed-physical/1',scope:'installed-real-source-capture',status:'running',startedAt:new Date().toISOString(),physicalCapture:true,uploadAllowed:false,commands:[],takes:[]};
let createdEvidence = false;
async function command(file,args,{binary=false,timeout=90000}={}) {
  try {
    const r=await execute(file,args,{cwd:root,timeout,maxBuffer:32*1024**2,encoding:binary?'buffer':'utf8'});
    report.commands.push({file,args,exitCode:0});return r.stdout;
  } catch(error) {report.commands.push({file,args,exitCode:error.code,signal:error.signal,stderr:String(error.stderr??'').slice(-4096)});throw error;}
}
async function digest(file) {const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function inside(file) {const resolved=await realpath(file);assert(resolved.startsWith(await realpath(evidence)+sep),'Media escaped the owned evidence root');return resolved;}
async function productSources() {
  const names=(await command('git',['ls-files','-z','--','Sources','shell/src','cloud/src','shell/package.json','shell/package-lock.json'])).split('\0').filter(Boolean).sort();
  return Object.fromEntries(await Promise.all(names.map(async name=>[name,await digest(join(root,name))])));
}
async function buildBinding(app) {
  const ownRequire=createRequire(join(root,'shell/package.json')),asar=ownRequire('@electron/asar');
  const packed=join(app,'Contents/Resources/app.asar'),members=asar.listPackage(packed).map(name=>name.replace(/^\//,''));
  const sourcePackage=JSON.parse(await readFile(join(root,'shell/package.json'),'utf8')),archivePackage=JSON.parse(asar.extractFile(packed,'package.json').toString('utf8'));
  for(const key of ['name','main','version'])assert.equal(archivePackage[key],sourcePackage[key],'Packaged metadata differs from source');
  const outputs={};
  for(const [source,target] of [['shell/dist','dist'],['cloud/dist','Contents/Resources/cloud'],['viewer/dist','Contents/Resources/viewer']]) {
    const inventory=await tree(join(root,source));outputs[source]=inventory;
    for(const [relative,entry] of Object.entries(inventory)) {
      if(entry.kind==='directory')continue;assert.equal(entry.kind,'file','Build output links cannot qualify source binding');
      const member=target+'/'+relative;
      if(source==='shell/dist')assert.equal(createHash('sha256').update(asar.extractFile(packed,member)).digest('hex'),entry.sha256,'Packaged main/renderer differs from source-gated output');
      else assert.equal(await digest(join(app,member)),entry.sha256,'Packaged SDK/viewer differs from source-gated output');
    }
    if(source==='shell/dist')for(const member of members.filter(name=>name.startsWith('dist/'))){const item=asar.statFile(packed,member,false);if(!item.files){assert(!item.link,'ASAR output link refused');assert(inventory[member.slice(5)],'Ungated ASAR output');}}
    else {
      const packaged=await tree(join(app,target)),expectedNames=Object.keys(inventory);
      if(source==='cloud/dist')expectedNames.push('package.json');
      assert.deepEqual(Object.keys(packaged).sort(),expectedNames.sort(),'Ungated packaged SDK/viewer entries');
      for(const [relative,entry] of Object.entries(packaged))assert.equal(entry.kind,relative==='package.json'&&source==='cloud/dist'?'file':inventory[relative].kind,'Packaged SDK/viewer entry kind differs');
      if(source==='cloud/dist')assert.equal(packaged['package.json'].sha256,await digest(join(root,'cloud/package.json')),'Packaged SDK metadata differs');
    }
  }
  const native={};
  for(const name of ['rushcore-engine','rushes']) {
    const built=join(root,'.build/release',name),installed=join(app,'Contents/Resources/bin',name);
    const content=await executableContent(built);assert.equal(await executableContent(installed),content,'Packaged native executable differs from source-gated release binary');
    native[name]={sourceBuildSHA256:await digest(built),executableContent:content};
  }
  return {outputs,native};
}
async function identity(app) {
  const metadata=JSON.parse(await command('plutil',['-convert','json','-o','-',join(app,'Contents/Info.plist')]));
  assert.equal(metadata.CFBundleIdentifier,'com.nexai.rushes');
  await command('codesign',['--verify','--deep','--strict',app]);
  return {app,version:metadata.CFBundleShortVersionString,asarSHA256:await digest(join(app,'Contents/Resources/app.asar')),engineSHA256:await digest(join(app,'Contents/Resources/bin/rushcore-engine')),buildBinding:await buildBinding(app),bindingPolicySHA256:await digest(join(root,'verification/update-acceptance/policy.mjs')),productSources:await productSources(),verifierSHA256:await digest(fileURLToPath(import.meta.url)),oracleSHA256:await digest(join(root,'verification/recording-acceptance/physical-oracle.mjs')),probeSourceSHA256:await digest(join(root,'verification/ProbeMedia.swift')),patternSourceSHA256:await digest(join(root,'verification/recording-acceptance/PatternHost.swift'))};
}
async function probeOriginals(take,probe) {
  const files=[];
  for(const role of requiredPhysicalRoles(take.mode)) {
    const track=take.manifest.tracks.find(t=>t.role===role&&t.present);assert(track,'Missing '+role+' original');
    assert.equal(track.offsetNs,0,'Declared source offset is not zero');
    const path=await inside(join(take.packagePath,track.file));assert.equal(await digest(path),take.rawHashes[track.file],'An original changed');files.push(path);
  }
  const decoded=JSON.parse(await command(probe,files));inspectPhysicalDecode(decoded,requiredPhysicalRoles(take.mode),take.durationMs);
  take.audioPeaks={};
  for(const role of requiredPhysicalRoles(take.mode).filter(x=>['mic','system'].includes(x))) {
    const track=take.manifest.tracks.find(t=>t.role===role&&t.present),path=await inside(join(take.packagePath,track.file));
    const pcm=await command(tools.ffmpeg,['-nostdin','-v','error','-i',path,'-ac','1','-ar','48000','-f','f32le','pipe:1'],{binary:true});
    let peak=0;for(let offset=0;offset+4<=pcm.length;offset+=4){const sample=pcm.readFloatLE(offset);assert(Number.isFinite(sample),'Invalid decoded PCM');peak=Math.max(peak,Math.abs(sample));}
    assert(peak>0.00001,'Non-silent PCM is unverified for physical '+role+' input');take.audioPeaks[role]=peak;
  }
  return decoded;
}
async function measureSync(take) {
  const screen=take.manifest.tracks.find(t=>t.role==='screen'),audio=take.manifest.tracks.find(t=>t.role==='system');
  const scale=screen.width/take.displayWidthPoints,bounds=take.pattern.bounds;
  const x=Math.round((bounds.X+bounds.Width/2)*scale-32),y=Math.round((bounds.Y+bounds.Height/2)*scale-32);
  const video=await inside(join(take.packagePath,screen.file)),sound=await inside(join(take.packagePath,audio.file));
  const frames=JSON.parse(await command(tools.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',video])).frames;
  const rgb=await command(tools.ffmpeg,['-nostdin','-v','error','-i',video,'-vf',`crop=64:64:${x}:${y},scale=1:1:flags=area`,'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{binary:true});
  assert.equal(rgb.length,frames.length*3,'Frame signal and presentation times differ');
  const visual=risingEdges(frames.map((frame,i)=>({time:Number(frame.best_effort_timestamp_time),active:rgb[i*3+1]>130&&rgb[i*3+1]>rgb[i*3+2]*1.5})));
  const pcm=await command(tools.ffmpeg,['-nostdin','-v','error','-i',sound,'-ac','1','-ar','48000','-f','f32le','pipe:1'],{binary:true});
  const samples=Float32Array.from({length:pcm.length/4},(_,i)=>pcm.readFloatLE(i*4));
  const audioEdges=risingEdges(codedTonePoints(samples));take.signalEvidence={videoOnsets:visual,audioOnsets:audioEdges};
  const expected=take.calibrationSchedule??take.fixtureTimes.map(time=>(take.pattern.scheduledHostNs-take.manifest.clock.epochHostNs)/1e9+time);
  return inspectOnsets(visual,audioEdges,take.durationMs/1000,expected);
}
async function recheck() {
  report=JSON.parse(await readFile(join(evidence,'report.json'),'utf8'));
  assert.equal(report.schema,'rushes.installed-physical/1');assert.equal(report.status,'verified');assert.equal(report.uploadAllowed,false);
  assert.equal(report.scope,'installed-real-source-capture');assert.equal(report.physicalCapture,true,'Generated calibration cannot qualify physical sources');
  const actual=await identity(report.identity.app);assert.deepEqual(actual,report.identity,'Installed app, product source or verifier differs');
  assert(report.closed&&report.nativeExited&&report.patternClosed,'Owned sources were not confirmed closed');
  assert.deepEqual(report.takes.map(t=>t.mode),['display','window','area','camera-only']);
  const probe=await inside(report.probe);assert.equal(await digest(probe),report.probeSHA256,'Independent probe changed');
  for(const take of report.takes){inspectPhysicalSelection(take.manifest,take.requestedSources);await probeOriginals(take,probe);}
  const sync=await measureSync(report.takes[0]);
  assert.equal(await digest(await inside(report.composite.path)),report.composite.sha256);
  const rendered=JSON.parse(await command(probe,[report.composite.path]));assert(rendered[0]?.ok&&rendered[0].decodedTracks.some(t=>t.type==='vide')&&rendered[0].decodedTracks.some(t=>t.type==='soun'),'Export is not independently playable');
  console.log(JSON.stringify({status:'verified',scope:'installed physical sources and screen/system-audio content sync',sync,productionSignedUpdateQualified:false,providerQualified:false}));
}
async function exercise() {
  assert(values['allow-local-physical'],'Explicit approved local screen/camera/mic/system-audio exercise required');
  await mkdir(evidence,{mode:0o700});
  createdEvidence = true;
  const profile=await mkdtemp(join(tmpdir(),'rushes-device-')),user=join(profile,'data'),recordings=join(evidence,'recordings');
  await mkdir(user);await mkdir(recordings);assert(Buffer.byteLength(join(user,'control.sock'))<104);
  report.profile=profile;report.identity=await identity(resolve(values.app??'/Applications/Rushes.app'));
  const proof=JSON.parse(await readFile(resolve(values['source-proof']),'utf8'));
  assert(proof.exitCode===0&&proof.unchanged,'Passing source union is required');
  for(const [path,sha] of Object.entries(report.identity.productSources))assert.equal(proof.after.public[path],sha,'Product source differs from source gate');
  await writeFile(join(evidence,'source-proof.json'),JSON.stringify(proof));
  const patternApp=join(evidence,'fixture.noindex/CapturePattern.app'),patternExecutable=join(patternApp,'Contents/MacOS/CapturePattern');
  const bundleID='com.nexai.capture-qualification.'+randomUUID();await mkdir(dirname(patternExecutable),{recursive:true});
  await writeFile(join(patternApp,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleID}</string><key>CFBundleExecutable</key><string>CapturePattern</string><key>CFBundleName</key><string>Capture Pattern</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  const probe=join(evidence,'probe-media');report.probe=probe;
  await command('swiftc',['-parse-as-library',join(root,'verification/ProbeMedia.swift'),'-o',probe]);report.probeSHA256=await digest(probe);
  await command('swiftc',['-parse-as-library',join(root,'verification/recording-acceptance/PatternHost.swift'),join(root,'Sources/RushCore/Selftest/SelftestSignal.swift'),'-o',patternExecutable]);
  await command('codesign',['--force','--sign','-','--timestamp=none',patternApp]);
  const times=[0.4,1.1,2.4,3.3,4.95,5.5];
  const pulses=times.map(t=>`between(t,${t},${t+0.14})`).join('+'),fixture=join(evidence,'pattern.mp4');
  const cues=join(evidence,'pattern-cues.json');await writeFile(cues,JSON.stringify({times,width:0.14}),{flag:'wx',mode:0o600});
  await command(tools.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`color=c=0x145a84:s=640x360:r=30:d=40,drawbox=x=0:y=0:w=iw:h=ih:color=0x20c050:t=fill:enable='${pulses}'`,'-f','lavfi','-i',`aevalsrc=exprs='if(${pulses},0.04*sin(2*PI*1763*t)+0.04*sin(2*PI*2939*t),0)':s=48000:d=40`,'-shortest','-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-n',fixture]);
  report.fixture={sha256:await digest(fixture),generatedOnly:true,pulseTimes:times,frequencies:[1763,2939]};
  report.signalCalibration=await measureSync({packagePath:evidence,durationMs:40000,calibrationSchedule:times,displayWidthPoints:640,pattern:{bounds:{X:0,Y:0,Width:640,Height:360}},manifest:{tracks:[{role:'screen',file:'pattern.mp4',width:640},{role:'system',file:'pattern.mp4'}]}});
  if(values['calibration-only']){report.scope='generated-signal-calibration';report.physicalCapture=false;report.status='verified';return;}
  if(values['signal-only'])report.scope='screen-system-transport-calibration';
  let application,page,pattern,idle=true,nativePID;
  try {
    const idleSeconds=Number((await command('/bin/sh',['-c',"ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'"])).trim());
    assert(idleSeconds>=3||values['input-override'],'Input active; explicit override or idle input required');report.inputGate={idleSeconds,explicitOverride:!!values['input-override']};
    const title='Recording qualification '+randomUUID(),events=join(evidence,'pattern-events.jsonl'),arm=join(evidence,'pattern-arm.json');await writeFile(events,'',{mode:0o600,flag:'wx'});await writeFile(arm,'{}',{mode:0o600,flag:'wx'});
    pattern=spawn('/usr/bin/open',['-n','-W','-a',patternApp,'--args',fixture,title,events,cues,arm],{stdio:['ignore','ignore','pipe']});
    let patternError='';pattern.stderr.on('data',bytes=>{patternError=(patternError+bytes).slice(-4096);});
    for(let n=0;n<100;n++){const lines=(await readFile(events,'utf8')).trim().split('\n').filter(Boolean);if(lines.length>=2){report.pattern=JSON.parse(lines.at(-1));break;}await delay(100);}
    assert(report.pattern,'Separately identified fixture did not launch: '+patternError);assert.equal(report.pattern.title,title);assert.equal(report.pattern.bundleID,bundleID,'Fixture is not its separate application identity');
    assert(report.pattern.signalPrepared===true&&report.pattern.scheduledHostNs===0,'Fixture must be prepared and unarmed before capture');
    assert(report.pattern.bounds.Width>0&&report.pattern.bounds.Height>0,'Fixture window bounds were not measured');
    const env={...process.env,RUSHES_DATA_DIR:user,RUSHES_RECORDINGS_ROOT:recordings};
    for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(name)||name.startsWith('RUSHES_SMOKE')||['RUSHES_TEST_ENGINE_STUB','RUSHES_ENGINE_PATH','RUSHES_DEV_URL','ELECTRON_RUN_AS_NODE'].includes(name))delete env[name];
    const {_electron}=await import('../viewer/node_modules/playwright/index.mjs');
    application=await _electron.launch({executablePath:join(report.identity.app,'Contents/MacOS/Rushes'),args:[`--user-data-dir=${join(profile,'electron')}`],env,timeout:30000});
    page=await application.firstWindow();page.setDefaultTimeout(15000);await page.waitForURL(url=>url.protocol==='file:'&&url.pathname.endsWith('/index.html'));await page.waitForFunction(()=>typeof window.rushes?.bootstrap==='function');
    const invoke=async(name,...args)=>{const result=await page.evaluate(({name,args})=>window.rushes[name](...args),{name,args});if(result?.__rushesError)throw Object.assign(Error(result.__rushesError.message),{code:result.__rushesError.code});return result;};
    const status=async()=>{const end=Date.now()+2000;for(;;){try{return await invoke('request','status');}catch(error){if(error.code!=='status-superseded'||Date.now()>=end)throw error;report.supersededStatusReads=(report.supersededStatusReads??0)+1;await delay(50);}}};
    const boot=await invoke('bootstrap');assert(boot.packaged&&boot.enginePath===join(report.identity.app,'Contents/Resources/bin/rushcore-engine'));
    assert.equal((await invoke('cloudSettings')).configured,false);await invoke('onboarding','dismiss');
    report.permissions=await invoke('request','permissions.check');for(const name of ['screen','camera','microphone'])assert.equal(report.permissions[name],'granted','Permission '+name+' must already be granted');
    const targets=await invoke('request','targets'),display=targets.displays.find(x=>x.isMain);assert(display);
    const target=targets.windows.find(x=>x.title===title);assert(target,'Generated external OS window was not catalogued');
    for(const mode of values['signal-only']?['signal-only']:['display','window','area','camera-only']) {
      let area;
      if(mode==='area') {
        await invoke('saveOptions',{...boot.options,mode:'area',source:display.id,camera:'none',mic:'none',systemAudio:false,autoShare:false,countdownSeconds:0});
        await invoke('window','area');let picker;
        for(let n=0;n<100&&!picker;n++){picker=application.windows().find(p=>p.url().endsWith('#area'));if(!picker)await delay(100);}
        assert(picker,'Area picker did not open');
        report.areaPicker=await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('#area'));return {fullScreen:window.isFullScreen(),background:window.getBackgroundColor(),bounds:window.getBounds()};});
        assert.equal(report.areaPicker.fullScreen,false,'Area picker entered a separate fullscreen Space');
        const screenshot=join(evidence,'area-desktop.png');await command('/usr/sbin/screencapture',['-x',screenshot]);
        const image=JSON.parse(await command(tools.ffprobe,['-v','error','-show_entries','stream=width,height','-of','json',screenshot]));
        const ratio=image.streams[0].width/display.widthPoints,centerX=(report.pattern.bounds.X+report.pattern.bounds.Width/2)*ratio,centerY=(report.pattern.bounds.Y+report.pattern.bounds.Height/2)*ratio;
        const sample=await command(tools.ffmpeg,['-nostdin','-v','error','-i',screenshot,'-vf',`crop=40:40:${Math.round(centerX-20)}:${Math.round(centerY-20)},scale=1:1:flags=area`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{binary:true});
        report.areaPicker.patternPixelRGB=[...sample];assert(sample.length===3&&sample[0]+sample[1]+sample[2]>90,'Area picker obscures the generated desktop pattern with black');
        const bounds=report.pattern.bounds,x=bounds.X+24,y=bounds.Y+60,width=bounds.Width-48,height=bounds.Height-84;
        await picker.mouse.move(x,y);await picker.mouse.down();await picker.mouse.move(x+width,y+height,{steps:10});await picker.mouse.up();
        await picker.getByRole('button',{name:/Use this area/}).click();
        area=(await invoke('bootstrap')).options.area;assert(area&&Math.abs(area.width-width)<2&&Math.abs(area.height-height)<2,'Drawn area was not retained');report.areaPicker.selected=area;
      }
      const options={countdownSeconds:0,camera:mode==='display'||mode==='camera-only'?'default':'none',mic:mode==='display'||mode==='camera-only'?'default':'none',systemAudio:['display','signal-only'].includes(mode),...(mode==='window'?{window:target.id}:mode==='camera-only'?{}:{display:display.id}),...(area?{area}:{}),title:'Local physical qualification '+mode};
      idle=false;const start=await invoke('request','record.start',options);
      if(['display','signal-only'].includes(mode)){
        await writeFile(arm,JSON.stringify({arm:true}));
        let armed;
        for(let n=0;n<40;n++){const lines=(await readFile(events,'utf8')).trim().split('\n').filter(Boolean);armed=JSON.parse(lines.at(-1));if(armed.scheduledHostNs>0)break;await delay(50);}
        assert(armed?.scheduledHostNs>0,'Fixture arming was not acknowledged');report.pattern=armed;
      }
      await delay(['display','signal-only'].includes(mode)?8000:4000);const stopped=await invoke('request','record.stop');
      const state=await status();assert.equal(state.state,'idle');idle=true;nativePID=state.pid;
      const shown=await invoke('request','show',{id:stopped.id??start.id});await inside(shown.packagePath);
      assert.equal(shown.manifest.status,'complete');assert(!JSON.stringify(shown.manifest.sources).includes('diagnostic'),'Synthetic engine input cannot qualify physical capture');
      const requestedSources={mode:mode==='signal-only'?'display':mode,displayId:options.display,windowId:options.window,area:options.area,camera:options.camera,mic:options.mic,cameraId:options.camera==='default'?targets.cameras[0]?.id:undefined,microphoneId:options.mic==='default'?targets.microphones[0]?.id:undefined,systemAudio:options.systemAudio};
      if(mode!=='signal-only')inspectPhysicalSelection(shown.manifest,requestedSources);
      const take={mode,requestedSources,packagePath:shown.packagePath,manifest:shown.manifest,durationMs:stopped.durationMs,fixtureTimes:times,displayWidthPoints:display.widthPoints,pattern:report.pattern,rawHashes:{}};
      for(const t of shown.manifest.tracks.filter(x=>x.present))take.rawHashes[t.file]=await digest(await inside(join(shown.packagePath,t.file)));
      report.pendingTake=take;
      take.decoded=await probeOriginals(take,probe);report.takes.push(take);
      delete report.pendingTake;
      assert.equal((await invoke('request','verify',{id:shown.id})).ok,true);
      if(mode==='display') {
        const preview=await invoke('previewFile',shown.id);const file=await inside(preview.path);
        report.composite={path:file,sha256:await digest(file)};const decoded=JSON.parse(await command(probe,[file]));assert(decoded[0]?.ok&&decoded[0].decodedTracks.some(t=>t.type==='vide')&&decoded[0].decodedTracks.some(t=>t.type==='soun'));
      }
    }
    report.sync=await measureSync(report.takes[0]);report.status='verified';
  } finally {
    if(application&&!idle&&page){try{const state=await page.evaluate(async()=>{const reply=await window.rushes.request('status');return reply.__rushesError?null:reply;});idle=state?.state==='idle';nativePID??=state?.pid;}catch{}}
    if(application&&idle){try{const closed=application.waitForEvent('close',{timeout:20000});void application.evaluate(({app})=>app.quit()).catch(()=>{});await closed;report.closed=true;}catch(error){report.closed=false;report.closeError=String(error);}}
    else if(application)report.leftOpenForRecovery=true;
    if(pattern&&report.pattern?.pid){
      const state=await execute('ps',['-p',String(report.pattern.pid),'-o','command='],{encoding:'utf8'}).catch(error=>({stdout:'',code:error.code}));
      if(state.stdout.trim().startsWith(patternExecutable)){process.kill(report.pattern.pid,'SIGTERM');}
      else assert.equal(state.stdout.trim(),'','Fixture process identity changed; refusing an unrelated signal');
      const ended=pattern.exitCode!==null?Promise.resolve():new Promise(resolve=>pattern.once('exit',resolve));await Promise.race([ended,delay(5000)]);
      try{process.kill(report.pattern.pid,0);report.patternClosed=false;}catch(error){if(error.code==='ESRCH')report.patternClosed=true;else throw error;}
      report.fixtureRegistration=await execute('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',['-u',patternApp],{encoding:'utf8'}).then(()=>({exitCode:0}),error=>({exitCode:error.code}));
    }
    if(nativePID){for(let n=0;n<50;n++){try{process.kill(nativePID,0);}catch(error){if(error.code==='ESRCH'){report.nativeExited=true;break;}throw error;}await delay(100);}}
    if(!report.closed||!report.nativeExited||!report.patternClosed)report.status='unverified';
  }
  assert.equal(report.status,'verified','Owned sources did not close cleanly');
}
try {
  if(values.recheck)await recheck();else await exercise();
} catch(error) {report.status='unverified';report.error=String(error.stack??error);process.exitCode=1;}
finally {
  if(values.exercise){report.endedAt=new Date().toISOString();if(createdEvidence)await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n').catch(error=>{console.error(error);process.exitCode=1;});console.log(JSON.stringify({status:report.status,scope:report.scope,error:report.error,evidence,physicalCapture:report.physicalCapture,uploadAllowed:false}));}
  else if(process.exitCode)console.error(report.error);
}
