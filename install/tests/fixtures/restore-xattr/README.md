# restore-xattr fixtures

Fixed archives for `install/tests/restore_memory_xattr.test.ts`. Each case
directory holds one `memory.<sha256>.tar.gz`, named the way
`install/restore-memory.ts` expects (the SHA-256 of the gzip bytes; built with
Python's `tarfile`, gzipped without a name or timestamp so the bytes are stable).
The test checks every name against its bytes and reads each header's typeflag
before it relies on a fixture.

| case | tar entries | expected |
|---|---|---|
| `ok-regular` | `0` `memories/MEMORY.md` | restores; the restored file carries no extended attribute |
| `pax-x-schily-xattr` | `x` (`SCHILY.xattr.user.plant`), `0` | refused `tar_entry_not_regular`; nothing written |
| `pax-x-libarchive-xattr` | `x` (`LIBARCHIVE.xattr.user.plant`), `0` | same |
| `pax-g-global` | `g` (`SCHILY.xattr.user.plant`), `0` | same |
| `solaris-X-xattr` | `X` (`SCHILY.xattr.user.plant`), `0` | same |

`solaris-X-xattr` is the `x` archive with that header's typeflag byte rewritten
to `X` and its checksum recomputed. The regular file is the same 19-byte test
line in every case; the header values are inert test strings. Data only: nothing
here is executed.
