#!/usr/bin/env python3
"""Prepare native helper inside a selected Rushes build; never launch or alter user workflows."""
import argparse,json,plistlib,subprocess
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--app',required=True,type=Path)
p.add_argument('--expected-bundle-id',default='com.nexai.rushes')
p.add_argument('--sign-identity',required=True)
p.add_argument('--configuration',choices=['debug','release'],default='release')
p.add_argument('--production',action='store_true')
a=p.parse_args();root=Path(__file__).resolve().parents[2];app=a.app.resolve()
info_path=app/'Contents/Info.plist'
if not info_path.is_file():raise SystemExit('Select an existing reviewable Rushes application build.')
info=plistlib.loads(info_path.read_bytes())
if info.get('CFBundleIdentifier')!=a.expected_bundle_id:raise SystemExit('Application identity does not match the explicitly selected Rushes build.')
helper=app/'Contents/Helpers/RushesAutomation.app'
if helper.exists():raise SystemExit('A helper already exists; preserve it and build a fresh containing app for replacement.')
command=['python3',str(root/'scripts/app-intents/host-package.py'),'--configuration',a.configuration,'--bundle-id',a.expected_bundle_id+'.automation','--output',str(helper),'--sign-identity',a.sign_identity,'--version',info['CFBundleShortVersionString'],'--build-version',info['CFBundleVersion']]
if a.production:command+=['--production']
subprocess.run(command,check=True,cwd=root)
print(json.dumps({'helperPath':str(helper),'helperBundleIdentifier':a.expected_bundle_id+'.automation','metadataExtracted':True,'helperSignatureVerified':True,'containingAppResignRequired':True,'runtimeDiscoveryVerified':False}))
