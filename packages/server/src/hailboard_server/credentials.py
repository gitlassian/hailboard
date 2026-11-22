import hashlib
import secrets
from typing import Literal

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

SecretKind = Literal["api_key", "join_token", "read_token", "device_code"]

PREFIX: dict[str, str] = {
    "api_key": "aw_",
    "join_token": "inv_",
    "read_token": "rd_",
    "device_code": "dev_",
}


def _random_base62() -> str:
    """Base62 encoding of 32 random bytes (43 characters)."""
    n = int.from_bytes(secrets.token_bytes(32))
    digits: list[str] = []
    while n:
        n, rest = divmod(n, 62)
        digits.append(ALPHABET[rest])
    return "".join(reversed(digits)).rjust(43, "0")


def generate_secret(kind: SecretKind) -> str:
    """A new secret such as "aw_...". Shown to the user once; only its hash is stored."""
    return PREFIX[kind] + _random_base62()


def hash_secret(secret: str) -> bytes:
    """SHA-256 digest, as stored in api_keys.key_hash and board_tokens.token_hash."""
    return hashlib.sha256(secret.encode()).digest()
