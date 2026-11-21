"""`llm.call` `error_code`: a failed model call named from a fixed list (pure; HOT-RASOOL F1).

Hermes fires `api_request_error` with the exception's class name, the HTTP
status, its own classification (`reason`, `agent/error_classifier.py`
`FailoverReason`) and the provider's message. The message can quote the prompt
that caused the failure, so it never leaves; `error_code` is a token from
`ERROR_CODES`, chosen from the reason first, then the status, then the class
name, else `other`.

One message earns a code of its own: OpenRouter's 400 for a history that
carries encrypted reasoning from more than one provider (CLAIMS L26001: a luna
fallback turn's reasoning items replayed to haiku). It is matched by a fixed
substring and the match is all that leaves.

`fallback_activated` is not a failure: it marks the first `llm.call` of a turn
on a different model after a failed call in that turn, i.e. Hermes's fallback
chain answered. The failed call before it carries the failure's own code.

Python 3.11, standard library only.
"""

from __future__ import annotations

from typing import Any, Optional

MIXED_PROVIDER_HISTORY = "mixed_provider_history"
FALLBACK_ACTIVATED = "fallback_activated"
OTHER = "other"

#: Every value `error_code` can take on a failed call.
FAILURE_CODES = (
    MIXED_PROVIDER_HISTORY,
    "bad_request",
    "context_overflow",
    "content_policy",
    "model_not_found",
    "rate_limited",
    "billing",
    "auth",
    "timeout",
    "server",
    "network",
    "cancelled",
    "invalid_response",
    OTHER,
)
#: Every value `error_code` can take on any `llm.call`.
ERROR_CODES = FAILURE_CODES + (FALLBACK_ACTIVATED,)

#: OpenRouter's wording (CLAIMS L26001), lower-cased. Matched, never stored.
MIXED_PROVIDER_TEXT = "encrypted reasoning or compaction content from multiple providers"

#: Hermes `FailoverReason` values (v2026.9.24) and the turn-level reasons its
#: other hook call sites pass (`invalid_response`).
_BY_REASON = {
    "format_error": "bad_request",
    "role_alternation": "bad_request",
    "invalid_encrypted_content": "bad_request",
    "thinking_signature": "bad_request",
    "multimodal_tool_content_unsupported": "bad_request",
    "reasoning_mandatory": "bad_request",
    "image_too_large": "bad_request",
    "image_corrupt": "bad_request",
    "llama_cpp_grammar_pattern": "bad_request",
    "long_context_tier": "bad_request",
    "oauth_long_context_beta_forbidden": "bad_request",
    "context_overflow": "context_overflow",
    "payload_too_large": "context_overflow",
    "content_policy_blocked": "content_policy",
    "provider_policy_blocked": "content_policy",
    "model_not_found": "model_not_found",
    "rate_limit": "rate_limited",
    "upstream_rate_limit": "rate_limited",
    "billing": "billing",
    "auth": "auth",
    "auth_permanent": "auth",
    "model_entitlement": "auth",
    "timeout": "timeout",
    "server_error": "server",
    "overloaded": "server",
    "upstream_blocked": "network",
    "ssl_cert_verification": "network",
    "invalid_response": "invalid_response",
    "incomplete_response": "invalid_response",
}

_BY_STATUS = {
    400: "bad_request",
    401: "auth",
    402: "billing",
    403: "auth",
    404: "model_not_found",
    408: "timeout",
    413: "context_overflow",
    422: "bad_request",
    429: "rate_limited",
}

#: Exception class-name fragments, lower-cased, checked in order.
_BY_CLASS = (
    ("cancel", "cancelled"),
    ("interrupt", "cancelled"),
    ("timeout", "timeout"),
    ("ratelimit", "rate_limited"),
    ("authentication", "auth"),
    ("permissiondenied", "auth"),
    ("notfound", "model_not_found"),
    ("badrequest", "bad_request"),
    ("unprocessable", "bad_request"),
    ("connection", "network"),
    ("connect", "network"),
    ("remoteprotocol", "network"),
    ("ssl", "network"),
    ("internalserver", "server"),
    ("serviceunavailable", "server"),
    ("overloaded", "server"),
    ("invalidapiresponse", "invalid_response"),
    ("contentpolicy", "content_policy"),
)


def _status(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def is_mixed_provider_history(message: Any) -> bool:
    """OpenRouter's mixed encrypted-reasoning 400, by its fixed wording only."""
    return isinstance(message, str) and MIXED_PROVIDER_TEXT in message.lower()


def failure_code(*, reason: Any = None, status_code: Any = None, error_type: Any = None, message: Any = None) -> str:
    """The `error_code` for a failed call: always a member of `FAILURE_CODES`."""
    if is_mixed_provider_history(message):
        return MIXED_PROVIDER_HISTORY
    if isinstance(reason, str):
        code = _BY_REASON.get(reason.strip().lower())
        if code:
            return code
    status = _status(status_code)
    if status is not None:
        code = _BY_STATUS.get(status)
        if code:
            return code
        if 500 <= status <= 599:
            return "server"
    if isinstance(error_type, str):
        name = error_type.strip().lower()
        for fragment, code in _BY_CLASS:
            if fragment in name:
                return code
    return OTHER


__all__ = [
    "ERROR_CODES",
    "FAILURE_CODES",
    "FALLBACK_ACTIVATED",
    "MIXED_PROVIDER_HISTORY",
    "MIXED_PROVIDER_TEXT",
    "OTHER",
    "failure_code",
    "is_mixed_provider_history",
]
