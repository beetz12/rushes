#!/usr/bin/env python3
"""Build, describe and sign one isolated native App Intents helper."""
import argparse,json,plistlib,shutil,subprocess,tempfile
from pathlib import Path
from helper_inputs import helper_binary, helper_versions, helper_timestamp, production_signature_fields

parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True,type=Path)
parser.add_argument('--configuration',choices=['debug','release'],default='release')
parser.add_argument('--bundle-id',default='com.nexai.rushes.automation')
parser.add_argument('--qa-socket')
parser.add_argument('--sign-identity',required=True)
parser.add_argument('--version')
parser.add_argument('--build-version')
parser.add_argument('--production',action='store_true')
args=parser.parse_args();root=Path(__file__).resolve().parents[2];app=args.output.resolve()
if app.exists():raise SystemExit('Select a fresh artifact path; an existing app will not be overwritten.')
if args.qa_socket and not args.bundle_id.endswith('.intentqa'):raise SystemExit('Stub override requires a QA-only bundle identifier.')
if args.qa_socket and not Path(args.qa_socket).is_socket():raise SystemExit('Start the explicit stub socket before packaging.')
version=args.version if args.version is not None else json.loads((root/'shell/package.json').read_text())['version']
versions=helper_versions(version,args.build_version if args.build_version is not None else version)
timestamp=helper_timestamp(args.sign_identity,args.production,args.qa_socket,args.configuration)
with tempfile.TemporaryDirectory(prefix='rushes-helper-build-') as workspace:
    scratch=Path(workspace)/'compiler';stage=Path(workspace)/'metadata'
    common=['swift','build','--force-resolved-versions','--scratch-path',str(scratch),'-c',args.configuration]
    build=common+['--product','RushIntentsExtension','-Xswiftc','-DRUSHES_INTENTS_MAIN_HOST']
    if args.qa_socket:build+=['-Xswiftc','-DRUSHES_INTENT_QA']
    subprocess.run(build,cwd=root,check=True)
    binpath=Path(subprocess.check_output(common+['--show-bin-path'],cwd=root,text=True).strip())
    executable=helper_binary(scratch,binpath)
    subprocess.run(['python3',str(root/'scripts/app-intents/metadata.py'),'--configuration',args.configuration,'--build-root',str(scratch),'--bundle-id',args.bundle_id,'--output',str(stage)],check=True,cwd=root)
    contents=app/'Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
    shutil.copy2(executable,contents/'MacOS'/'RushesAutomation')
    shutil.copytree(stage/'RushIntentsExtension'/'Metadata.appintents',contents/'Resources'/'Metadata.appintents')
    info={'CFBundleIdentifier':args.bundle_id,'CFBundleName':'Rushes Automation','CFBundleDisplayName':'Rushes Automation','CFBundleExecutable':'RushesAutomation','CFBundlePackageType':'APPL',**versions,'LSMinimumSystemVersion':'26.4','LSUIElement':True}
    if args.qa_socket:info['RushesIntentQASocketPath']=str(Path(args.qa_socket).resolve())
    (contents/'Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['codesign','--force','--sign',args.sign_identity,'--options','runtime',timestamp,str(app)],check=True)
subprocess.run(['codesign','--verify','--strict','--verbose=2',str(app)],check=True)
if args.production:
    subprocess.run(['codesign','--verify','--strict','--test-requirement','=anchor apple generic',str(app)],check=True)
    description=subprocess.check_output(['codesign','--display','--verbose=4',str(app)],stderr=subprocess.STDOUT,text=True)
    production_signature_fields(description,args.sign_identity)
print(app)
