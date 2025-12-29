# Note: for Apple Silicon GPU acceleration, run the worker natively.
# This Dockerfile is intended for Linux/CUDA deployments.
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY worker ./worker
ENV HOLO_WORKER_POLL_INTERVAL=1.0
CMD ["python", "-m", "worker.worker"]
