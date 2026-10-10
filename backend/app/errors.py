"""Every error leaves the API as {error, code, retryable} (ErrorResponse)."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.models import ErrorResponse


class ApiError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 500, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable

    def to_response(self) -> ErrorResponse:
        return ErrorResponse(error=self.message, code=self.code, retryable=self.retryable)


def not_implemented(feature: str) -> ApiError:
    return ApiError("not_implemented", f"{feature} is not available yet.", status=501)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(exc.to_response().model_dump(), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        body = ErrorResponse(
            error="The request was not in the expected shape.",
            code="invalid_request",
            retryable=False,
        )
        return JSONResponse(body.model_dump(), status_code=422)
