"""Unix terminal regression check: cargo build --locked && python3 tests/legacy_prompt.py."""

import os
from pathlib import Path
import select
import signal
import sys
import time

if os.name != "posix":
    print("SKIP: terminal prompts require a Unix PTY")
    sys.exit(0)

import pty


def check(binary, retry):
    pid, terminal = pty.fork()
    if pid == 0:
        for key in ("APPIUM_URL", "PROXY_HOST", "PROXY_PORT"):
            os.environ.pop(key, None)
        os.execv(str(binary), [str(binary)])

    transcript = b""
    consumed = 0
    reaped = False

    def expect(text):
        nonlocal transcript, consumed
        deadline = time.monotonic() + 5
        while text not in transcript[consumed:]:
            remaining = deadline - time.monotonic()
            assert remaining > 0, repr(transcript)
            ready, _, _ = select.select([terminal], [], [], remaining)
            assert ready, repr(transcript)
            try:
                chunk = os.read(terminal, 4096)
            except OSError:
                chunk = b""
            assert chunk, repr(transcript)
            transcript += chunk
        consumed = transcript.index(text, consumed) + len(text)

    try:
        expect(b"Host [127.0.0.1]: ")
        if retry:
            for invalid, label, prompt in (
                (b"0.0.0.0\n", b"Host", b"Host [127.0.0.1]: "),
                (b"file:///tmp/appium.sock\n", b"Appium URL", b"Appium URL [http://127.0.0.1:4723]: "),
                (b"0\n", b"Port", b"Port [4724]: "),
            ):
                os.write(terminal, invalid)
                expect(b"Invalid " + label)
                expect(prompt)
                if label != b"Port":
                    os.write(terminal, b"\n")
                    expect(b"Appium URL [" if label == b"Host" else b"Port [")
        os.write(terminal, b"\x03")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0, status
                break
            time.sleep(0.01)
        assert reaped, "Ctrl+C did not stop the prompt"
        assert b'"running":true' not in transcript
    finally:
        if not reaped:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(terminal)


if __name__ == "__main__":
    executable = Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/appium-recorder").resolve()
    check(executable, retry=False)
    check(executable, retry=True)
    print("PASS: invalid terminal answers retry, and Ctrl+C exits successfully")
