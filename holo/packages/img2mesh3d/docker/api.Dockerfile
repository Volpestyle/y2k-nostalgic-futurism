FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml README.md LICENSE /app/
COPY src /app/src

RUN pip install --no-cache-dir -U pip \
 && pip install --no-cache-dir -e ".[api]"

ENV PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["uvicorn", "img2mesh3d.api.app:app", "--host", "0.0.0.0", "--port", "8080"]
