#!/usr/bin/env python3
"""Read-only preflight before extracting an untrusted acceptance ZIP."""
import json
import posixpath
import stat
import struct
import sys
import unicodedata
import zipfile
from pathlib import Path


def inspect(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 ** 3:
        raise ValueError('Bounded regular ZIP required')
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 65557))
        tail = stream.read(65557)
    end = tail.rfind(b'PK\x05\x06')
    if end < 0 or end + 22 > len(tail):
        raise ValueError('ZIP end directory absent')
    disk, directory_disk, disk_count, count, size, offset, comment = struct.unpack_from('<HHHHIIH', tail, end + 4)
    if disk or directory_disk or disk_count != count or not 0 < count <= 50000 or size > 16 * 1024 ** 2 or end + 22 + comment != len(tail) or offset + size > path.stat().st_size:
        raise ValueError('ZIP directory bound failed')
    observed = set()
    total = 0
    links = 0
    targets = {}
    names = []
    alias = lambda name: unicodedata.normalize('NFC', name).casefold()
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) != count:
            raise ValueError('ZIP count differs from its directory')
        for member in members:
            name = member.filename
            parts = name.split('/')
            if len(name.encode('utf8')) > 4096 or name.startswith('/') or '\\' in name or '..' in parts or '.' in parts or not (name.startswith('Rushes.app/') or name.startswith('__MACOSX/Rushes.app/') or name == '__MACOSX/'):
                raise ValueError('ZIP path escapes expected app')
            normalized = posixpath.normpath(name)
            if alias(normalized) in observed or member.flag_bits & 1 or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('Duplicate/encrypted/unsupported ZIP member')
            observed.add(alias(normalized))
            names.append(normalized)
            total += member.file_size
            if member.file_size > 2 * 1024 ** 3 or total > 8 * 1024 ** 3:
                raise ValueError('ZIP expansion exceeds bound')
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                if member.file_size > 4096:
                    raise ValueError('ZIP link exceeds bound')
                with archive.open(member) as source:
                    target = source.read(4097).decode('utf8')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(normalized), target))
                root = '__MACOSX/Rushes.app' if normalized.startswith('__MACOSX/') else 'Rushes.app'
                if len(target.encode('utf8')) > 4096 or target.startswith('/') or '\\' in target or not resolved.startswith(root + '/'):
                    raise ValueError('ZIP symlink escapes app before extraction')
                targets[alias(normalized)] = target
                links += 1
            elif stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('ZIP special filesystem node refused')
    operations = 0
    for name in names:
        if name == '__MACOSX':
            continue
        pending, resolved, hops = name.split('/'), [], 0
        while pending:
            operations += 1
            if operations > 1000000 or len(pending) > 8192:
                raise ValueError('ZIP link resolution exceeds bound')
            part = pending.pop(0)
            if not part or part == '.':
                continue
            if part == '..':
                if not resolved:
                    raise ValueError('ZIP chained link escapes extraction root')
                resolved.pop()
                continue
            selected = alias('/'.join(resolved + [part]))
            if selected in targets:
                hops += 1
                if hops > 40:
                    raise ValueError('ZIP link cycle refused')
                pending = targets[selected].split('/') + pending
            else:
                resolved.append(part)
        root = '__MACOSX/Rushes.app' if name.startswith('__MACOSX/') else 'Rushes.app'
        if '/'.join(resolved) != root and not '/'.join(resolved).startswith(root + '/'):
            raise ValueError('ZIP chained link escapes app')
    return {'level': 'archive-structure-only', 'entries': count, 'uncompressedBytes': total, 'internalLinks': links, 'productionAccepted': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('One exact ZIP path required')
        print(json.dumps(inspect(sys.argv[1])))
    except Exception as error:
        print(json.dumps({'status': 'refused', 'reason': str(error), 'productionAccepted': False}))
        sys.exit(1)
