"""Explicit operator policy. No credential/config text is returned or logged."""
import json
import math
import os
from pathlib import Path
import stat
import time

INDIA_END = 1793557800  # 2026-11-01T18:30:00Z; same instant as TS reader
KEYS = frozenset(('daily_digest', 'opportunity_midday', 'opportunity_evening', 'negotiation_summary',
                  'pending_alert', 'zzz_pairs', 'zzz_event_autonomy', 'zzz_owner_repeating', 'welcome_seed'))


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('policy-invalid')
        result[key] = value
    return result


def parse_policy(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > 4096:
        raise ValueError('policy-invalid')
    value = json.loads(raw, object_pairs_hook=_unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('policy-invalid')))
    if (not isinstance(value, dict) or set(value) != {'version', 'enabled'} or
            type(value['version']) not in (int, float) or value['version'] != 1 or
            not isinstance(value['enabled'], list) or
            any(not isinstance(key, str) or key not in KEYS for key in value['enabled']) or
            len(set(value['enabled'])) != len(value['enabled'])):
        raise ValueError('policy-invalid')
    return value


def read_policy(home):
    home = Path(home)
    try:
        folder = home / 'av-events'
        if folder.is_symlink():
            return 'invalid', None
        fd = os.open(folder / 'post-village-policy.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            meta = os.fstat(stream.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_size > 4096:
                return 'invalid', None
            raw = stream.read(4097).decode('utf-8')
        return 'ok', parse_policy(raw)
    except FileNotFoundError:
        return 'missing', None
    except (OSError, ValueError, UnicodeError):
        return 'invalid', None


def allowed(home, key, now=None):
    now = time.time() if now is None else now
    if key not in KEYS or isinstance(now, bool) or not isinstance(now, (int, float)) or not math.isfinite(now):
        return False
    if now < INDIA_END:
        return True
    status, policy = read_policy(home)
    return status == 'ok' and key in policy['enabled']

JOB_NAMES = {
    'daily_digest': ('Edge — daily digest', 'Edge — digest prepare', 'Edge — template: brief', 'Edge — template: digest-preview'),
    'opportunity_midday': ('Edge — opportunity drop (midday)',),
    'opportunity_evening': ('Edge — opportunity drop (evening)',),
    'negotiation_summary': ('Edge — negotiation summary',), 'pending_alert': ('Edge — pending opportunity',),
    'zzz_pairs': ('Edge — zzz pairs',), 'zzz_event_autonomy': ('Edge — zzz event autonomy',),
}


def _local_json(path, limit):
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('unsafe-file')
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {}
    with os.fdopen(fd, 'rb') as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > limit:
            raise ValueError('unsafe-file')
        value = json.loads(stream.read(limit + 1), object_pairs_hook=_unique)
    if not isinstance(value, dict):
        raise ValueError('unsafe-file')
    return value


def runtime_allowed(home, key, now=None):
    if not allowed(home, key, now):
        return False
    try:
        home = Path(home)
        holds = _local_json(home / 'av-events/job-holds.json', 65536)
        states = holds.get('holds', {})
        if not isinstance(states, dict):
            return False
        jobs = _local_json(home / 'cron/jobs.json', 16 * 1024 * 1024).get('jobs', [])
        if not isinstance(jobs, list):
            return False
        return not any(isinstance(job, dict) and job.get('name') in JOB_NAMES.get(key, ())
                       and states.get(job.get('id')) == 'paused' for job in jobs)
    except (OSError, ValueError, UnicodeError, TypeError):
        return False
