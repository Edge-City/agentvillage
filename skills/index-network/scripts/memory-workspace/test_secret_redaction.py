#!/usr/bin/env python3
from __future__ import annotations

import unittest

from secret_redaction import redact, scan_text


class SecretRedactionTest(unittest.TestCase):
    def test_redacts_hosted_token_shapes(self) -> None:
        text = "\n".join(
            [
                "token=eos_live_abcd1234EFGH5678",
                "github=ghu_abcdefghijklmnopqrstuvwxyz12",
                "jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart",
            ]
        )

        rendered = redact(text)

        self.assertIn("eos_live_[REDACTED]", rendered)
        self.assertIn("ghu_[REDACTED]", rendered)
        self.assertIn("eyJ[REDACTED]", rendered)
        self.assertNotIn("abcd1234EFGH5678", rendered)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz12", rendered)
        self.assertNotIn("signaturepart", rendered)

    def test_redacts_sensitive_assignment_shapes(self) -> None:
        text = "\n".join(
            [
                "export TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwx",
                "ADMIN_TOKEN='admin-secret-value-123456'",
                '"RAILWAY_API_TOKEN": "railway-secret-value-123456",',
                "OPENROUTER_API_KEY: sk-or-v1-secretvalue123456",
            ]
        )

        rendered = redact(text)

        self.assertEqual(rendered.count("[REDACTED]"), 4)
        self.assertNotIn("ABCdef", rendered)
        self.assertNotIn("admin-secret-value", rendered)
        self.assertNotIn("railway-secret-value", rendered)
        self.assertNotIn("sk-or-v1-secretvalue", rendered)

    def test_keeps_variable_references_and_reports_counts_only(self) -> None:
        text = 'export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:?set it}"\nINDEX_API_KEY=idx-secret-value-123456\n'

        rendered = redact(text)
        report = scan_text(rendered)

        self.assertIn("${OPENROUTER_API_KEY:?set it}", rendered)
        self.assertIn("INDEX_API_KEY=[REDACTED]", rendered)
        self.assertEqual(report, {})
        self.assertEqual(scan_text(text), {"sensitive-assignment": 1})


if __name__ == "__main__":
    unittest.main()
