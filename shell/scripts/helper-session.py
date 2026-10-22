"""Inspect or retire process groups in one build-owned POSIX session."""
import argparse
import errno
import json
import os
import signal
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('session', type=int)
parser.add_argument('--signal', choices=['TERM', 'KILL'])
args = parser.parse_args()
if args.session <= 1 or args.session == os.getsid(0):
    raise SystemExit('A separate positive build session is required.')

snapshot = subprocess.run(['ps', '-ax', '-o', 'pid='], capture_output=True, text=True, timeout=2, check=True)
members = []
for line in snapshot.stdout.splitlines():
    pid = int(line.strip())
    try:
        if os.getsid(pid) == args.session:
            members.append({'pid': pid, 'group': os.getpgid(pid)})
    except OSError as error:
        if error.errno != errno.ESRCH:
            raise

signaled = []
if args.signal:
    selected = signal.SIGTERM if args.signal == 'TERM' else signal.SIGKILL
    for group in sorted({member['group'] for member in members}):
        if group <= 1 or group == os.getpgrp():
            raise SystemExit('Refusing an invalid or caller process group.')
        # Recheck a living member immediately before signaling its whole group.
        for member in members:
            if member['group'] != group:
                continue
            try:
                if os.getsid(member['pid']) == args.session and os.getpgid(member['pid']) == group:
                    os.killpg(group, selected)
                    signaled.append(group)
                    break
            except OSError as error:
                if error.errno != errno.ESRCH:
                    raise

print(json.dumps({'session': args.session, 'members': members, 'signaledGroups': signaled}))
