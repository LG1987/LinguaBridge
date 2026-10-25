"""Development shim for the DSH Windows sandbox.

Why this exists
---------------
DSH runs shell commands under a restricted token that is granted access through an
explicit ACE (S-1-4-*) on the workspace. Python 3.13+ translates a POSIX ``mode``
argument into a real Windows DACL, so ``os.mkdir(path, 0o700)`` (used by
``tempfile.mkdtemp``) creates a directory whose DACL omits the sandbox ACE. The
process then cannot even ``chmod`` it back (WinError 5), and pip/uv/pytest fail
with ``PermissionError``.

What it does
------------
Ignores restrictive ``mode`` arguments on Windows so directories inherit the
workspace DACL instead of receiving an explicit owner-only one. File contents,
ownership and the parent ACL are untouched; the only change is that newly created
directories are group/owner writable like a default ``mkdir``.

Scope: only processes that load this directory on ``PYTHONPATH`` (a development
convenience, never installed system-wide).
"""

import os
import sys

if sys.platform == "win32":  # pragma: no cover - Windows only
    _real_mkdir = os.mkdir
    _real_makedirs = os.makedirs

    def mkdir(path, mode=0o777, *, dir_fd=None):  # noqa: D103
        return _real_mkdir(path, 0o777, dir_fd=dir_fd)

    def makedirs(name, mode=0o777, exist_ok=False):  # noqa: D103
        return _real_makedirs(name, 0o777, exist_ok=exist_ok)

    os.mkdir = mkdir
    os.makedirs = makedirs
