#!/usr/bin/env python3
"""Package native main-process App Intents host; no extra entitlements or capture."""
import argparse,plistlib,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);p.add_argument('--configuration',choices=['debug','release'],default='release');p.add_argument('--bundle-id',default='com.nexai.rushes.automation');p.add_argument('--qa-socket');p.add_argument('--sign-identity',required=True);args=p.parse_args();root=Path(__file__).resolve().parents[2];app=args.output.resolve()
if app.exists():raise SystemExit('Select a fresh artifact path; an existing app will not be overwritten.')
if args.qa_socket and not args.bundle_id.endswith('.intentqa'):raise SystemExit('Stub override requires a QA-only bundle identifier.')
if args.qa_socket and not Path(args.qa_socket).is_socket():raise SystemExit('Start the explicit stub socket before packaging.')
build=['swift','build','-c',args.configuration,'--product','RushIntentsExtension','-Xswiftc','-DRUSHES_INTENTS_MAIN_HOST']
if args.qa_socket:build+=['-Xswiftc','-DRUSHES_INTENT_QA']
subprocess.run(build,cwd=root,check=True)
binpath=Path(subprocess.check_output(['swift','build','-c',args.configuration,'--show-bin-path'],cwd=root,text=True).strip())
stage=root/'.build/app-intents-main-metadata'/args.configuration/args.bundle_id
subprocess.run(['python3',str(root/'scripts/app-intents/metadata.py'),'--configuration',args.configuration,'--bundle-id',args.bundle_id,'--output',str(stage)],check=True,cwd=root)
contents=app/'Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
shutil.copy2(binpath/'RushIntentsExtension',contents/'MacOS'/'RushesAutomation')
shutil.copytree(stage/'RushIntentsExtension'/'Metadata.appintents',contents/'Resources'/'Metadata.appintents')
info={'CFBundleIdentifier':args.bundle_id,'CFBundleName':'Rushes Automation','CFBundleDisplayName':'Rushes Automation','CFBundleExecutable':'RushesAutomation','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','LSMinimumSystemVersion':'26.4','LSUIElement':True}
if args.qa_socket:info['RushesIntentQASocketPath']=str(Path(args.qa_socket).resolve())
(contents/'Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['codesign','--force','--sign',args.sign_identity,'--options','runtime','--timestamp=none',str(app)],check=True)
subprocess.run(['codesign','--verify','--strict','--verbose=2',str(app)],check=True)
print(app)
