from typing import Literal

ErrorCode = Literal[
    "unauthorized",
    "removed",
    "key_stopped",
    "forbidden",
    "pending",
    "not_found",
    "conflict",
    "validation_failed",
    "gone",
    "too_large",
    "rate_limited",
    "internal",
]

STATUS: dict[str, int] = {
    "unauthorized": 401,
    "removed": 401,
    "key_stopped": 401,
    "forbidden": 403,
    "pending": 403,
    "not_found": 404,
    "conflict": 409,
    "validation_failed": 422,
    "gone": 410,
    "too_large": 413,
    "rate_limited": 429,
    "internal": 500,
}


class ApiError(Exception):
    """An error that becomes a JSON error response with a matching HTTP status."""

    def __init__(self, code: ErrorCode, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.headers = headers

    @property
    def status(self) -> int:
        return STATUS[self.code]


def unauthorized(message: str = "missing or invalid credentials") -> ApiError:
    return ApiError("unauthorized", message)


def removed(message: str = "you are no longer on this board") -> ApiError:
    """A key that was stopped because its member left the board or was taken off it."""
    return ApiError("removed", message)


def key_stopped(
    message: str = "this key no longer works: its machine was taken off the board, or it was "
    "replaced",
) -> ApiError:
    """A stopped key of a member who is still on the board (not a member who left)."""
    return ApiError("key_stopped", message)


def forbidden(message: str) -> ApiError:
    return ApiError("forbidden", message)


def pending(message: str) -> ApiError:
    """The member joined, and the board's owner has not let them in yet."""
    return ApiError("pending", message)


def not_found(message: str = "not found") -> ApiError:
    return ApiError("not_found", message)


def conflict(message: str) -> ApiError:
    return ApiError("conflict", message)


def invalid(message: str) -> ApiError:
    return ApiError("validation_failed", message)


def gone(message: str) -> ApiError:
    return ApiError("gone", message)


def too_large(message: str) -> ApiError:
    return ApiError("too_large", message)
