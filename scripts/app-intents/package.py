#!/usr/bin/env python3
"""Prepare original native intent extension for a containing Electron bundle."""
import argparse, plistlib, shutil, subprocess
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--configuration',choices=['debug','release'],default='release')
parser.add_argument('--bundle-id',default='com.nexai.rushes.intents')
parser.add_argument('--output',type=Path,default=Path('.build/app-intents/RushesIntents.appex'))
parser.add_argument('--qa-socket')
parser.add_argument('--sign-identity')
args=parser.parse_args();root=Path(__file__).resolve().parents[2]
if args.qa_socket and not args.bundle_id.endswith('.intentqa.extension'):raise SystemExit('Stub override requires a QA-only extension identifier.')
output=args.output.resolve()
if output.exists():raise SystemExit('Refusing to replace an existing extension artifact. Select a fresh output path.')
build=['swift','build','-c',args.configuration,'--product','RushIntentsExtension']
if args.qa_socket:build+=['-Xswiftc','-DRUSHES_INTENT_QA']
subprocess.run(build,cwd=root,check=True)
binpath=Path(subprocess.check_output(['swift','build','-c',args.configuration,'--show-bin-path'],cwd=root,text=True).strip())
stage=root/'.build/app-intents-metadata'/args.configuration/args.bundle_id
subprocess.run(['python3',str(root/'scripts/app-intents/metadata.py'),'--configuration',args.configuration,'--bundle-id',args.bundle_id,'--output',str(stage)],cwd=root,check=True)
contents=output/'Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
shutil.copy2(binpath/'RushIntentsExtension',contents/'MacOS'/'RushIntentsExtension')
shutil.copytree(stage/'RushIntentsExtension'/'Metadata.appintents',contents/'Resources'/'Metadata.appintents')
info={'CFBundleIdentifier':args.bundle_id,'CFBundleName':'Rushes Intents','CFBundleDisplayName':'Rushes','CFBundleExecutable':'RushIntentsExtension','CFBundlePackageType':'XPC!','CFBundleShortVersionString':'1.0','CFBundleVersion':'1','CFBundleInfoDictionaryVersion':'6.0','LSMinimumSystemVersion':'26.4','EXAppExtensionAttributes':{'EXExtensionPointIdentifier':'com.apple.appintents-extension'}}
if args.qa_socket:info['RushesIntentQASocketPath']=str(Path(args.qa_socket).resolve())
(contents/'Info.plist').write_bytes(plistlib.dumps(info))
if args.sign_identity:
 subprocess.run(['codesign','--force','--sign',args.sign_identity,'--options','runtime','--timestamp=none',str(output)],check=True)
 subprocess.run(['codesign','--verify','--strict','--verbose=2',str(output)],check=True)
print(output)
