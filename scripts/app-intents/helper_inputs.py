"""Validate the selected native helper build without consulting unrelated outputs."""
from pathlib import Path
import re


def helper_binary(build_root, binary_directory):
    directory = Path(build_root).resolve()
    selected = Path(binary_directory) / 'RushIntentsExtension'
    if not directory.is_dir() or not Path(binary_directory).resolve().is_relative_to(directory):
        raise ValueError('The helper executable directory escaped the selected compiler build.')
    if selected.is_symlink() or not selected.resolve().is_relative_to(directory) or not selected.is_file():
        raise ValueError('The helper executable is missing or escaped the selected compiler build.')
    return selected


def compiler_constants(build_root, module, sources, configuration):
    directory = Path(build_root).resolve()
    if not directory.is_dir():
        raise ValueError('The selected compiler build directory is missing.')
    module_folder = re.compile(re.escape(module) + r'(?:-[A-Za-z0-9]+)?\.build')

    def matches(name):
        selected = []
        for candidate in directory.rglob(name):
            parts = candidate.relative_to(directory).parts
            if configuration.casefold() not in [part.casefold() for part in parts]:
                continue
            if not any(module_folder.fullmatch(part) for part in parts):
                continue
            if candidate.is_symlink() or not candidate.resolve().is_relative_to(directory):
                raise ValueError('Compiler constants escaped the selected build directory.')
            if candidate.is_file():
                selected.append(candidate)
        return selected

    whole = matches(module + '-primary.swiftconstvalues') + matches(module + '.swiftconstvalues')
    if whole:
        if len(whole) != 1:
            raise ValueError('Ambiguous whole-module compiler constants in the selected build.')
        return whole
    result = []
    for source in sources:
        found = matches(Path(source).stem + '.swiftconstvalues')
        if len(found) != 1:
            raise ValueError('Missing or ambiguous per-source compiler constants in the selected build.')
        result.extend(found)
    if not result:
        raise ValueError('No compiler constants selected.')
    return result


def helper_versions(version, build_version):
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('The helper requires its containing app stable release version.')
    if not isinstance(build_version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', build_version):
        raise ValueError('The helper requires its containing app numeric build version.')
    return {'CFBundleShortVersionString': version, 'CFBundleVersion': build_version}


def helper_timestamp(identity, production, qa_socket, configuration):
    if production:
        if qa_socket or configuration != 'release':
            raise ValueError('Production helpers cannot use a QA socket or debug configuration.')
        if not re.fullmatch(r'Developer ID Application: .+ \([A-Z0-9]{10}\)', identity):
            raise ValueError('Production helper signing requires Developer ID Application.')
        return '--timestamp'
    return '--timestamp=none'


def production_signature_fields(description, identity):
    lines = description.splitlines()
    team = identity.rsplit('(', 1)[1].removesuffix(')')
    timestamps = [line.removeprefix('Timestamp=').strip() for line in lines if line.startswith('Timestamp=')]
    if 'Authority=' + identity not in lines or 'TeamIdentifier=' + team not in lines:
        raise ValueError('The helper signature differs from the selected Developer ID identity/team.')
    if len(timestamps) != 1 or timestamps[0].lower() in ('', 'none'):
        raise ValueError('The production helper has no secure signature timestamp.')
