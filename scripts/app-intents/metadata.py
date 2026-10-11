#!/usr/bin/env python3
"""Extract native intent metadata from actual Swift compiler constant files."""
import argparse, json, platform, subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--configuration', choices=['debug','release'], default='release')
parser.add_argument('--output', type=Path, default=Path('.build/app-intents'))
parser.add_argument('--bundle-id', default='com.nexai.rushes.intents')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
sdk = subprocess.check_output(['xcrun','--show-sdk-path'], text=True).strip()
toolchain = str(Path(subprocess.check_output(['xcrun','--find','swiftc'],text=True).strip()).parents[1])
version = subprocess.check_output(['xcodebuild','-version'],text=True).split('Build version ')[1].strip()
architecture = platform.machine()
compiled = root / '.build'
for module,folder in [('RushIntents','Sources/RushIntents'),('RushIntentsExtension','Sources/RushIntentsExtension')]:
    stage=output/module;stage.mkdir(exist_ok=True)
    sources=sorted((root/folder).glob('*.swift'))
    constants=[]
    for source in sources:
        matching=[p for p in compiled.rglob(source.stem+'.swiftconstvalues') if args.configuration.capitalize() in p.parts or args.configuration in p.parts]
        if not matching: raise SystemExit('Missing compiler constant values: '+str(source)+'. Run the declared Swift build first.')
        constants.append(max(matching,key=lambda p:p.stat().st_mtime))
    sources_path=stage/'sources.txt'; sources_path.write_text('\n'.join(map(str,sources))+'\n')
    constants_path=stage/'constants.txt';constants_path.write_text('\n'.join(map(str,constants))+'\n')
    command=['xcrun','appintentsmetadataprocessor','--output',str(stage),'--toolchain-dir',toolchain,'--module-name',module,'--sdk-root',sdk,'--xcode-version',version,'--platform-family','macOS','--deployment-target','26.4','--target-triple',architecture+'-apple-macosx26.4','--source-file-list',str(sources_path),'--swift-const-vals-list',str(constants_path)]
    if module=='RushIntentsExtension':
        dependencies=stage/'static-metadata.txt'
        metadata=output/'RushIntents'/'Metadata.appintents'/'extract.actionsdata'
        if not metadata.exists(): raise SystemExit('Library intent metadata is absent: '+str(metadata))
        dependencies.write_text(str(metadata)+'\n')
        command+=['--static-metadata-file-list',str(dependencies),'--bundle-identifier',args.bundle_id]
    subprocess.run(command,check=True,cwd=root)
    actions=list(stage.rglob('*.actionsdata'))
    if not actions:raise SystemExit('Processor produced no action metadata for '+module)
    # Parse actual metadata as data; never print raw compiler payloads.
    found=[]
    for path in actions:
        try: value=json.loads(path.read_text())
        except (UnicodeError,json.JSONDecodeError):continue
        data=json.dumps(value)
        for name in ['StartRecordingIntent','StopRecordingIntent']:
            if name in data:found.append(name)
    print(json.dumps({'module':module,'metadata':str(stage/'Metadata.appintents'),'action_types':sorted(set(found)),'const_files':len(constants)}))
    if not {'StartRecordingIntent','StopRecordingIntent'}.issubset(found):raise SystemExit('Expected recording actions absent from '+module+' metadata')
