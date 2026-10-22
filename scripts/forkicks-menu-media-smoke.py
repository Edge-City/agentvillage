#!/usr/bin/env python3
"""Opt-in local preview read smoke: native -> real HTTPS AV app -> merchant -> PNG.

No model, Telegram adapter/send, order or payment. Requires an existing local-only
fixture credential. Source-derived parser mode does not claim a running Hermes.
"""
from __future__ import annotations
import argparse
import ast
import contextvars
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import types
from urllib.parse import urlsplit
from urllib.request import urlopen

PIN = '118984d7a02f8a8baec11255002cbbab7c202e06'
SOURCE_URL = f'https://raw.githubusercontent.com/NousResearch/hermes-agent/{PIN}/gateway/platforms/base.py'


def source_parser(evidence):
    """Execute exact upstream PNG extraction methods/helpers, not a replica regex.

    The native output only contains quoted .png directives, so extensionless and
    inline-code path-policy branches must not execute. Full-runtime mode covers
    the complete media path policy instead.
    """
    with urlopen(SOURCE_URL, timeout=30) as response:
        source = response.read(1024 * 1024 + 1)
    if len(source) > 1024 * 1024:
        raise RuntimeError('Pinned parser source unexpectedly large')
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    (evidence / 'hermes-base.py').write_bytes(source)
    tree = ast.parse(source)
    names = {'_AUDIO_MIME_TYPES', '_AUDIO_EXTS', 'MEDIA_DELIVERY_EXTS', '_MEDIA_EXT_ALTERNATION', '_MEDIA_CJK_TERMINATORS', 'MEDIA_TAG_CLEANUP_RE', 'MEDIA_EXTENSIONLESS_TAG_RE', '_TERMINAL_SENTINEL', '_FENCED_CODE_RE', '_INLINE_CODE_RE', '_normalize_media_tag_path', '_path_lacks_deliverable_extension', '_terminal_sentinel_start', '_mask_media_scan_text', '_deliverable_tag_spans', '_extensionless_media_matches', '_real_media_tag_spans', '_blank_spans', '_delete_spans', '_match_extensionless_path'}
    nodes = []
    found = set()
    for node in tree.body:
        name = node.name if isinstance(node, (ast.FunctionDef, ast.ClassDef)) else node.target.id if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) else node.targets[0].id if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) else None
        if name in names:
            nodes.append(node); found.add(name)
        if name == 'BasePlatformAdapter':
            methods = [method for method in node.body if isinstance(method, ast.FunctionDef) and method.name in ('extract_media', '_mask_protected_spans', '_mask_json_string_media')]
            if len(methods) != 3:
                raise RuntimeError('Pinned parser method shape changed')
            nodes.append(ast.ClassDef(name='BasePlatformAdapter', bases=[], keywords=[], body=methods, decorator_list=[]))
    if found != names:
        raise RuntimeError('Pinned parser helper shape changed')
    def unsupported_path_policy(*args, **kwargs):
        raise RuntimeError('Source-derived PNG-only proof reached full-runtime path policy; use --hermes-source')
    namespace = {'os': os, 're': re, 'Path': Path, 'validate_media_delivery_path': unsupported_path_policy}
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), SOURCE_URL, 'exec'), namespace)
    return namespace['BasePlatformAdapter'], {'mode': 'source-derived exact upstream PNG parser, not running Hermes', 'url': SOURCE_URL, 'revision': PIN, 'sha256': hashlib.sha256(source).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-home', type=Path, required=True)
    parser.add_argument('--origin', required=True, help='Existing HTTPS tailnet-only AV preview, no production')
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--hermes-source', type=Path, help='Optional actual installed Hermes source + dependencies')
    parser.add_argument('--theme', choices=('forkicks', 'chalk', 'paper'), default='forkicks')
    parser.add_argument('--date')
    parser.add_argument('--location-id')
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or origin.hostname != 'jmill-desktop.tail587341.ts.net' or origin.port != 8472 or origin.path or origin.query or origin.fragment or origin.username or origin.password:
        raise SystemExit('Only the existing private :8472 local AV preview is allowed')
    config = json.loads((args.fixture_home / 'village-bridge.json').read_text())
    projection = (args.fixture_home / 'mini-apps.json').read_bytes()
    args.evidence_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='forkicks-menu-hermes-') as directory:
        home = Path(directory)
        os.environ['HERMES_HOME'] = str(home)
        config['origin'] = args.origin
        for name, data in (('village-bridge.json', json.dumps(config).encode()), ('mini-apps.json', projection)):
            path = home / name
            path.write_bytes(data); path.chmod(0o600)
        if args.hermes_source:
            sys.path.insert(0, str(args.hermes_source.resolve()))
            from gateway.platforms.base import BasePlatformAdapter
            from gateway import session_context as sc
            provenance = {'mode': 'actual Hermes import (no gateway started)', 'source': str(args.hermes_source), 'sha256': hashlib.sha256((args.hermes_source / 'gateway/platforms/base.py').read_bytes()).hexdigest()}
        else:
            BasePlatformAdapter, provenance = source_parser(args.evidence_dir)
            # Explicit simulated private owner context, not a running Telegram turn.
            gateway = types.ModuleType('gateway'); sc = types.ModuleType('gateway.session_context')
            sc._UNSET = object(); sc._VAR_MAP = {}
            gateway.session_context = sc
            delegation = types.ModuleType('agent.delegation_context')
            delegation.is_delegated_child_context = lambda: False
            sys.modules.update({'gateway': gateway, 'gateway.session_context': sc, 'agent.delegation_context': delegation})
        values = {'HERMES_SESSION_PLATFORM': 'telegram', 'HERMES_SESSION_CHAT_TYPE': 'private', 'HERMES_SESSION_CHAT_ID': config['ownerTelegramId'], 'HERMES_SESSION_USER_ID': config['ownerTelegramId'], 'HERMES_SESSION_KEY': 'forkicks-isolated-media-smoke', 'HERMES_SESSION_MESSAGE_ID': '1', 'HERMES_CRON_SESSION': ''}
        for name, value in values.items():
            if name not in sc._VAR_MAP:
                sc._VAR_MAP[name] = contextvars.ContextVar(name, default=sc._UNSET)
            sc._VAR_MAP[name].set(value)
        plugin_path = Path(__file__).resolve().parents[1] / 'plugins/village-bridge/__init__.py'
        spec = importlib.util.spec_from_file_location('village_bridge', plugin_path)
        bridge = importlib.util.module_from_spec(spec); sys.modules[spec.name] = bridge; spec.loader.exec_module(bridge)
        request = {'operation': 'forkicks.menu', 'format': 'image', 'theme': args.theme}
        if args.date: request['date'] = args.date
        if args.location_id: request['locationId'] = args.location_id
        raw = bridge.handle(request)  # Actual native guards + HTTP transport, no network mocks.
        if not raw.startswith('MEDIA:'):
            error = json.loads(raw)
            raise SystemExit('Native image failed: ' + str(error.get('error', 'unknown')) + '; no credential/body logged')
        attachments, accessible = BasePlatformAdapter.extract_media(raw)
        if not attachments or 'For Kicks' not in accessible:
            raise SystemExit('Real parser did not recognize native attachments/accessibility text')
        proofs = []
        for index, (filename, voice) in enumerate(attachments, 1):
            path = Path(filename)
            if voice or not path.is_relative_to(home / 'cache/images/forkicks') or path.stat().st_mode & 0o777 != 0o600:
                raise SystemExit('Unsafe native attachment')
            if args.hermes_source and BasePlatformAdapter.validate_media_delivery_path(filename) != filename:
                raise SystemExit('Actual Hermes media policy rejected attachment')
            data = path.read_bytes()
            (args.evidence_dir / f'{args.theme}-{index}.png').write_bytes(data)
            proofs.append({'page': index, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        # The exact failure mode this integration avoids: JSON values are stored text.
        bare_marker = 'MEDIA:' + attachments[0][0]
        if BasePlatformAdapter.extract_media(json.dumps({'result': bare_marker}))[0]:
            raise SystemExit('Pinned parser unexpectedly accepted JSON-string marker')
        (args.evidence_dir / 'accessible-menu.txt').write_text(accessible)
        report = {'request': request, 'parser': provenance, 'attachments': proofs, 'session': 'simulated private owner root context', 'transport': 'actual native HTTPS -> local preview app -> configured merchant', 'telegramSent': False, 'modelCalled': False, 'ordersPlaced': False}
        (args.evidence_dir / 'media-proof.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
