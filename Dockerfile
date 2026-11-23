FROM python:3.11-slim

LABEL org.opencontainers.image.title="Autograph" \
      org.opencontainers.image.description="Vehicle telemetry lab with 2D and 3D drive, a new obstacle layout each trip, collision logs, and self-drive that can avoid every hit or mix lane changes with collisions."

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY README.md .

RUN mkdir -p /app/data/logs

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
