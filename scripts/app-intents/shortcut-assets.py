#!/usr/bin/env python3
"""Generate scoped, unsigned native AppIntent shortcuts for explicit user import."""
import argparse,plistlib,uuid
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--bundle-id',default='com.nexai.rushes.automation');p.add_argument('--app-name',default='RushesAutomation');p.add_argument('--team-id');p.add_argument('--output',type=Path,default=Path('scripts/app-intents/assets'));args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
for action,label in [('StartRecordingIntent','Rushes Start Recording'),('StopRecordingIntent','Rushes Stop Recording')]:
 descriptor={'BundleIdentifier':args.bundle_id,'Name':args.app_name,'AppIntentIdentifier':action}
 if args.team_id:descriptor['TeamIdentifier']=args.team_id
 parameters={'AppIntentDescriptor':descriptor,'UUID':str(uuid.uuid4()).upper()}
 # Device defaults remain the verified metadata defaults Off; no camera/mic flags or permissions are silently enabled.
 data={'WFWorkflowName':label,'WFWorkflowMinimumClientVersion':900,'WFWorkflowMinimumClientVersionString':'900','WFWorkflowClientVersion':'5037.0.17','WFWorkflowActions':[{'WFWorkflowActionIdentifier':args.bundle_id+'.'+action,'WFWorkflowActionParameters':parameters}],'WFWorkflowTypes':[],'WFWorkflowInputContentItemClasses':[],'WFWorkflowOutputContentItemClasses':['WFStringContentItem'],'WFWorkflowIcon':{'WFWorkflowIconStartColor':4282601983,'WFWorkflowIconGlyphNumber':59777}}
 path=args.output/(label+'.unsigned.shortcut')
 if path.exists():raise SystemExit('Refusing to overwrite existing shortcut asset: '+str(path))
 path.write_bytes(plistlib.dumps(data));print(path)
