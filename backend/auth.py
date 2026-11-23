"""Password login for the web UI (sendust_player.json: "auth": true, "password": "...").

- Login sets an HttpOnly cookie holding an HMAC-signed expiry (secret in data/secret, so sessions
  survive backend restarts; changing the password invalidates them).
- Exempt: loopback clients (CasparCG's HTML overlay, local tools), the login page/API, /ext/*
  (it has its own key), and requests carrying X-Api-Key == ext_control.key (gang control server).
"""
import hashlib
import hmac
import secrets
import time

from .config import ROOT

COOKIE = "sp_session"
MAX_AGE = 30 * 86400
SECRET_FILE = ROOT / "data" / "secret"
PUBLIC_PREFIXES = ("/login.html", "/api/v1/login", "/api/v1/logout", "/css/", "/favicon", "/ext/")
LOOPBACK = ("127.0.0.1", "::1", "localhost")


def _secret() -> bytes:
    try:
        s = SECRET_FILE.read_bytes()
        if len(s) >= 32:
            return s
    except OSError:
        pass
    s = secrets.token_bytes(32)
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    SECRET_FILE.write_bytes(s)
    SECRET_FILE.chmod(0o600)
    return s


class Auth:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.secret = _secret()

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.get("auth"))

    def _key(self) -> bytes:
        # the password is part of the key: changing it logs everybody out
        return self.secret + str(self.cfg.get("password", "")).encode()

    def make_token(self) -> str:
        exp = str(int(time.time()) + MAX_AGE)
        sig = hmac.new(self._key(), exp.encode(), hashlib.sha256).hexdigest()
        return f"{exp}.{sig}"

    def valid_token(self, tok: str | None) -> bool:
        if not tok or "." not in tok:
            return False
        exp, sig = tok.split(".", 1)
        good = hmac.new(self._key(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and exp.isdigit() and int(exp) > time.time()

    def check_password(self, pw: str) -> bool:
        return hmac.compare_digest(str(pw).encode(), str(self.cfg.get("password", "")).encode())

    def api_key_ok(self, key: str | None) -> bool:
        want = self.cfg.get("ext_control", {}).get("key") or ""
        return bool(want) and key is not None and hmac.compare_digest(key.encode(), want.encode())

    def allowed(self, path: str, ip: str, cookie: str | None, api_key: str | None) -> bool:
        if not self.enabled or ip in LOOPBACK:
            return True
        if path.startswith(PUBLIC_PREFIXES):
            return True
        return self.valid_token(cookie) or self.api_key_ok(api_key)
