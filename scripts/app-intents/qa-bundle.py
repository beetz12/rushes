#!/usr/bin/env python3
"""Build a separately identified local QA app with only a stub recording socket."""
import argparse,plistlib,subprocess,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);p.add_argument('--socket',required=True,type=Path);p.add_argument('--sign-identity',required=True);args=p.parse_args();root=Path(__file__).resolve().parents[2];app=args.output.resolve()
if app.exists():raise SystemExit('Refusing to overwrite an app bundle.')
if not args.socket.is_socket():raise SystemExit('Start the scoped stub engine first.')
contents=app/'Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Extensions').mkdir();(contents/'Resources').mkdir()
subprocess.run(['xcrun','swiftc','-parse-as-library',str(root/'scripts/app-intents/QAHost.swift'),'-o',str(contents/'MacOS'/'RushesIntentQA')],check=True)
info={'CFBundleIdentifier':'com.nexai.rushes.intentqa','CFBundleName':'Rushes Intent QA','CFBundleDisplayName':'Rushes Intent QA','CFBundleExecutable':'RushesIntentQA','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','LSMinimumSystemVersion':'26.4','LSUIElement':True}
(contents/'Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['python3',str(root/'scripts/app-intents/package.py'),'--configuration','debug','--bundle-id','com.nexai.rushes.intentqa.extension','--output',str(contents/'Extensions'/'RushesIntents.appex'),'--qa-socket',str(args.socket),'--sign-identity',args.sign_identity],check=True,cwd=root)
shutil.copytree(contents/'Extensions'/'RushesIntents.appex'/'Contents'/'Resources'/'Metadata.appintents',contents/'Resources'/'Metadata.appintents')
subprocess.run(['codesign','--force','--sign',args.sign_identity,'--options','runtime','--timestamp=none',str(app)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict','--verbose=2',str(app)],check=True)
print(app)
