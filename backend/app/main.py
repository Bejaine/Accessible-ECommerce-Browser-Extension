"""FastAPI app. Routes are thin; logic lives in services/ and brain/."""

from fastapi import FastAPI

from app import __version__
from app.errors import install_error_handlers
from app.routes import extract, health, ocr, product, reviews, speech, translate, turn, vision

app = FastAPI(title="Accessible Shopping Layer", version=__version__)
install_error_handlers(app)

for module in (health, product, extract, ocr, speech, translate, turn, vision, reviews):
    app.include_router(module.router)
