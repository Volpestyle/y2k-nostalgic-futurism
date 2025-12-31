FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml README.md LICENSE /app/
COPY src /app/src

RUN pip install --no-cache-dir -U pip \
 && pip install --no-cache-dir -e "."

ENV PYTHONUNBUFFERED=1

CMD ["img2mesh3d-worker"]
